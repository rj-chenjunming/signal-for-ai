/**
 * 悬浮置顶指示灯窗口（PRD P0-2 / 架构 §1.3）。
 *
 * 依赖: `electron`（BrowserWindow / screen）+ shared/*。
 *
 * 关键实现要点（架构 §1.3 逐条落地）：
 *  | 需求 | 实现 |
 *  | --- | --- |
 *  | 无边框 | `frame: false` |
 *  | 透明 | `transparent: true` + `backgroundColor: '#00000000'` |
 *  | 置顶 | `alwaysOnTop: true` + `setAlwaysOnTop(true, 'screen-saver')` |
 *  | 不抢焦点 | `focusable: false` + `skipTaskbar: true` |
 *  | 鼠标穿透 | `setIgnoreMouseEvents(true, { forward: true })` |
 *  | 常驻不被遮挡 | `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` |
 *  | 位置记忆 | 监听 `moved` -> 写回配置（debounce 500ms） |
 *
 * 【为什么拖拽用 CSS 而不是 IPC】（架构 §1.3）
 *  `-webkit-app-region: drag` 由 Chromium 直接处理，零 IPC 开销；
 *  但灯要同时可点击 -> 拖拽区与点击区在 HTML 里分离（见 overlay.html）。
 */

import { BrowserWindow, screen } from 'electron';
import * as path from 'node:path';

import { LAMP_DOCK_DEBOUNCE_MS, LAMP_POSITION_DEBOUNCE_MS } from '../shared/constants';
import { countVisibleTasks } from '../shared/visibility';
import { resolveCanvasSize, resolveDock } from './overlay-layout';
import type { LampDock, LampSettings, Snapshot } from '../shared/types';
import { IPC_PUSH } from '../shared/ipc-contract';
import { pushLayout } from './ipc';
import type { Logger } from './logger';

export interface OverlayOptions {
  settings: LampSettings;
  logger: Logger;
  /** 灯被拖动后的位置回调（写回配置用）。 */
  onPositionChanged: (x: number, y: number) => void;
  /** 左键单击 -> 展开/收起面板。 */
  onTogglePanel: () => void;
  /**
   * 当前启用的任务数（用于决定单灯 / 灯带形态与窗口尺寸）。
   *
   * 做成回调而不是构造时快照：配置热重载后任务数会变，
   * 窗口需要在 applySettings/重建时拿到**当前**值。
   */
  taskCount?: () => number;
}

export class OverlayWindow {
  private win: BrowserWindow | null = null;
  private settings: LampSettings;
  private moveTimer: NodeJS.Timeout | null = null;
  /** 停靠形态判定的去抖计时器（与位置写回分开，见 scheduleDockEval）。 */
  private dockTimer: NodeJS.Timeout | null = null;
  /**
   * 当前贴在哪条屏幕边缘。
   *
   * 非 `none` 时切成"点阵形态"：只留圆点、去掉文字标签
   * （用户要求：「拖到侧边或顶部的时候变成一排信号灯，没有那些后面的信号描述」）。
   */
  private dock: LampDock = 'none';
  /** 最近一次收到的快照：用于按"可显示行数"算画布尺寸（见 stripTaskCount）。 */
  private lastSnapshot: Snapshot | null = null;

  constructor(private readonly options: OverlayOptions) {
    this.settings = { ...options.settings };
  }

  /** 创建窗口。 */
  create(): void {
    if (this.win) {
      return;
    }

    const { width, height } = this.resolveCanvasSize();
    const position = this.resolveInitialPosition(width, height);

    this.win = new BrowserWindow({
      width,
      height,
      x: position.x,
      y: position.y,
      // --- PRD P0-2 的核心参数组合 ---
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: this.settings.alwaysOnTop,
      focusable: false, // 不抢焦点
      skipTaskbar: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      // Windows 上 transparent 窗口需要 disableHardwareAcceleration 才能稳定合成，
      // 但会牺牲 GPU 加速 —— 因为灯是 28px 静态内容，代价可接受（架构 §1.2 说明）。
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // preload 需要 require shared/constants
        transparent: true,
      },
    });

    // 'screen-saver' 是 Electron 支持的最高置顶级别（架构 §1.3）
    if (this.settings.alwaysOnTop) {
      this.win.setAlwaysOnTop(true, 'screen-saver');
    }
    // 常驻不被遮挡：所有工作区可见 + 全屏时也可见（PRD P0-2「始终置顶不被其他窗口遮挡」）
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    if (this.settings.clickThrough) {
      this.win.setIgnoreMouseEvents(true, { forward: true });
    }

    void this.win.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));

    // ready-to-show 后再显示，避免白屏闪烁
    this.win.once('ready-to-show', () => {
      this.win?.showInactive();
      // 让渲染层一开始就用对形态（它挂载时还会主动 getLayout 兜一次，防竞态）
      this.pushCurrentLayout();
    });

    // 位置记忆（debounce 500ms，架构 §1.3）
    this.win.on('moved', () => {
      this.schedulePersistPosition();
      // 停靠形态用更短的去抖：形态要跟手，落盘可以慢
      this.scheduleDockEval();
    });

    this.win.on('closed', () => {
      this.win = null;
    });

    this.options.logger.info(
      `悬浮灯窗口已创建（${width}x${height} @${position.x},${position.y}，${this.stripTaskCount() >= 2 ? '灯带' : '单灯'}模式，任务数=${this.stripTaskCount()}）`,
    );

    // ★ 启动即判定一次：上次拖到边缘的位置会被记进配置，下次启动时
    // 并**不会**有 `moved` 事件，不在这里判一次形态就不定型。
    this.evaluateDock();
  }

  /**
   * 当前**可显示**的行数，决定单灯还是灯带形态。
   *
   * 优先用最近一次快照里的权威值（`snapshot.stripMode` 同源），
   * 首次创建时还没有快照，退回用**配置**估算 —— 口径保持一致的近似
   * （按 shared/visibility.ts 的规则数，失联/失败的行不算）。
   *
   * ⚠️ 这里绝不能数"配置里启用了几个任务"。加了「隐藏失联/失败行」之后，
   * 可显示行数会随运行状态变化，数错就会重演
   * 「窗口按灯带尺寸开、内容只有一个灯」的错位。
   */
  private stripTaskCount(): number {
    if (this.lastSnapshot !== null) {
      return countVisibleTasks(this.lastSnapshot.tasks);
    }
    return this.options.taskCount?.() ?? 0;
  }

  /**
   * 计算透明画布尺寸。
   *
   * 数学部分抽到 `overlay-layout.ts`（纯函数、可单测），因为这里的常量
   * 必须与 `shared.css` 的 `.lamp-strip` 布局严格一致 —— 一旦算出比内容
   * 矮的画布，边缘圆点就会被窗口裁掉（"圆圈显示不完整"）。
   *
   * - **单灯模式**（可显示行数 < 2）：正方形 `size + 24`。
   *   这也就是"此刻没有任何东西活着"时的形态 —— 自动缩成一颗小灯。
   * - **灯带模式**（D6/D9）：竖排「总灯 + 每行一个」，宽度只占屏幕右侧一条。
   */
  private resolveCanvasSize(): { width: number; height: number } {
    let maxHeight = 900;
    try {
      maxHeight = Math.round((screen.getPrimaryDisplay?.()?.workArea.height ?? 900) * 0.7);
    } catch {
      // 无 display 信息（极早期调用/无头环境）时用保守上限
    }
    return resolveCanvasSize(this.settings.size, this.stripTaskCount(), maxHeight, this.dock);
  }

  /**
   * 首次运行（x = -1）时放在主屏右上角。
   * 传入的是**实际画布尺寸**，而不是灯本体尺寸，否则灯带会跑出屏幕右侧。
   */
  private resolveInitialPosition(
    width: number,
    height: number,
  ): { x: number; y: number } {
    if (this.settings.x >= 0 && this.settings.y >= 0) {
      return { x: this.settings.x, y: this.settings.y };
    }
    try {
      const display = screen.getPrimaryDisplay();
      void height;
      return {
        x: display.workArea.x + display.workArea.width - width - 24,
        y: display.workArea.y + 60,
      };
    } catch {
      // 无 display 信息时退回保守位置
      return { x: 100, y: 100 };
    }
  }

  /** 状态变更 -> 推送给渲染层。 */
  setState(snapshot: Snapshot): void {
    if (!this.win || this.win.isDestroyed()) {
      return;
    }
    // 记下最近快照：resolveCanvasSize / stripTaskCount 要靠它数"可显示行数"
    this.lastSnapshot = snapshot;

    // 每次状态更新都校正一次画布尺寸。
    //
    // 【为什么必须在这里做】可显示行数会随运行状态变化：
    // 失联/失败的行被隐藏后，可能从"灯带"退回"单灯"（或反过来）。
    // 尺寸不跟着变，灯带就会被窗口边缘裁掉 —— 表现是"圆圈显示不完整"。
    // 实测踩过：窗口按 2 行建成，实际渲染 3 行，上下各被切 1px。
    // fitToTaskCount() 内部有"尺寸未变则不动"的判断，反复调用无副作用。
    this.fitToTaskCount();

    try {
      this.win.webContents.send(IPC_PUSH.SNAPSHOT, snapshot);
    } catch (err) {
      this.options.logger.warn(`推送状态到悬浮灯失败：${(err as Error).message}`);
    }
  }

  /** 收到渲染层的拖动位置 -> 写回配置。 */
  updatePosition(x: number, y: number): void {
    this.settings.x = Math.round(x);
    this.settings.y = Math.round(y);
    this.options.onPositionChanged(this.settings.x, this.settings.y);
  }

  private schedulePersistPosition(): void {
    if (this.moveTimer) {
      clearTimeout(this.moveTimer);
    }
    this.moveTimer = setTimeout(() => {
      this.moveTimer = null;
      this.persistPosition();
    }, LAMP_POSITION_DEBOUNCE_MS);
  }

  private persistPosition(): void {
    if (!this.win || this.win.isDestroyed()) {
      return;
    }
    try {
      const [x, y] = this.win.getPosition();
      this.updatePosition(x, y);
    } catch (err) {
      this.options.logger.warn(`读取悬浮灯位置失败：${(err as Error).message}`);
    }
  }

  /* ============================================================================
   * 边缘停靠（拖到侧边/顶部 -> 点阵形态）
   * ==========================================================================*/

  /** 当前停靠方向（index.ts 的 GET_LAYOUT handler 用它回渲染层的主动拉取）。 */
  get currentDock(): LampDock {
    return this.dock;
  }

  /**
   * 停靠形态判定的去抖入口。
   *
   * 【为什么与位置写回分开计时】`moved` 在拖动过程中高频触发，
   * 每帧改窗口尺寸会让拖动发抖；而位置写回要 500ms 去抖以免频繁写盘。
   * 两者目标不同 —— 形态 160ms 跟手，落盘 500ms 稳。
   */
  private scheduleDockEval(): void {
    if (this.dockTimer) {
      clearTimeout(this.dockTimer);
    }
    this.dockTimer = setTimeout(() => {
      this.dockTimer = null;
      this.evaluateDock();
    }, LAMP_DOCK_DEBOUNCE_MS);
  }

  /**
   * 重新判定停靠方向；变了就换形态、按"贴边那条边不动"改尺寸、通知渲染层。
   *
   * 判定规则见 `overlay-layout.ts` 的 `resolveDock`（纯函数、已单测）。
   * 只认上 / 左 / 右三条边 —— 用户要的是"拖到侧边或顶部"。
   */
  private evaluateDock(): void {
    if (!this.win || this.win.isDestroyed()) {
      return;
    }
    let bounds: Electron.Rectangle;
    let workArea: Electron.Rectangle | null;
    try {
      bounds = this.win.getBounds();
      workArea = this.workAreaFor(bounds);
    } catch {
      return;
    }
    if (workArea === null) {
      return; // 拿不到显示器信息时保持现状
    }

    const next = resolveDock(bounds, workArea);
    if (next === this.dock) {
      return;
    }
    const previous = this.dock;
    this.dock = next;
    this.options.logger.info(`悬浮灯停靠形态变化：${previous} -> ${next}`);

    const { width, height } = this.resolveCanvasSize();
    this.resizeAnchored(width, height, '悬浮灯尺寸随停靠调整');
    this.pushCurrentLayout();
  }

  /** 把当前停靠方向推给渲染层。 */
  private pushCurrentLayout(): void {
    pushLayout(this.getBrowserWindow(), { dock: this.dock });
  }

  /**
   * 取窗口所在显示器的工作区。
   *
   * ★ 用**窗口中心点**判定，而不是 `getDisplayMatching`（矩形最大交集）。
   * 原因：本项目实测踩到过 —— 灯正好压在两块屏交界处时（用户的灯一度在
   * x=1768 附近，而主屏宽 1920），"最大交集"可能选中隔壁那块屏，
   * 于是右边缘距离算成了负数，灯被判成"贴右边缘"。
   * 中心点只属于一块屏，没有歧义。
   */
  private workAreaFor(bounds: Electron.Rectangle): Electron.Rectangle | null {
    try {
      const center = {
        x: bounds.x + Math.round(bounds.width / 2),
        y: bounds.y + Math.round(bounds.height / 2),
      };
      return screen.getDisplayNearestPoint(center).workArea;
    } catch {
      return null; // 无显示器信息（无头/极早期）
    }
  }

  /**
   * 改窗口尺寸，但让**贴着的那条边保持不动**。
   *
   * 例：右边缘停靠时缩小窗口要往左收（右边缘不动），否则灯会离屏幕边越来越远，
   * 看起来"没吸附住"。停靠时还会把窗口夹回工作区，避免加宽后跑出屏幕。
   * 未停靠时行为与原来完全一致（只改尺寸、不动位置）。
   */
  private resizeAnchored(targetWidth: number, targetHeight: number, reason: string): void {
    if (!this.win || this.win.isDestroyed()) {
      return;
    }
    let bounds: Electron.Rectangle;
    let workArea: Electron.Rectangle | null;
    try {
      bounds = this.win.getBounds();
      workArea = this.workAreaFor(bounds);
    } catch {
      return;
    }
    if (workArea === null) {
      return;
    }

    let nextX = bounds.x;
    let nextY = bounds.y;
    if (this.dock === 'right') {
      nextX = bounds.x + bounds.width - targetWidth;
    }
    if (this.dock !== 'none') {
      nextX = Math.max(workArea.x, Math.min(nextX, workArea.x + workArea.width - targetWidth));
      nextY = Math.max(workArea.y, Math.min(nextY, workArea.y + workArea.height - targetHeight));
    }

    const x = Math.round(nextX);
    const y = Math.round(nextY);
    if (bounds.width === targetWidth && bounds.height === targetHeight && bounds.x === x && bounds.y === y) {
      return;
    }

    try {
      this.win.setBounds({ x, y, width: targetWidth, height: targetHeight });
      this.options.logger.info(
        `${reason}：${bounds.width}x${bounds.height} -> ${targetWidth}x${targetHeight}`,
      );
    } catch (err) {
      this.options.logger.warn(`${reason}失败：${(err as Error).message}`);
    }
  }

  /** 应用设置变更（如 clickThrough / alwaysOnTop 被用户在配置里改了）。 */
  applySettings(next: LampSettings): void {
    // ⚠️ clickThrough **不参与**重建判定：它由下面的 setIgnoreMouseEvents 实时生效。
    // 早期实现把它算进 needRecreate，导致托盘里切一次"锁定/穿透"就销毁重建整个窗口
    // —— 一次本可零成本的开关带来一次闪烁，且窗口重建期间灯会短暂消失。
    const needRecreate = next.size !== this.settings.size;
    this.settings = { ...next };

    if (this.win && !this.win.isDestroyed()) {
      if (next.alwaysOnTop) {
        this.win.setAlwaysOnTop(true, 'screen-saver');
      } else {
        this.win.setAlwaysOnTop(false);
      }
      // 实时生效（D10）：锁上后完全不吃鼠标
      this.win.setIgnoreMouseEvents(next.clickThrough, { forward: true });
    }

    if (needRecreate) {
      this.options.logger.info('悬浮灯外观设置变更，重建窗口');
      this.destroy();
      this.create();
    }
  }

  /**
   * 任务数变化后按需调整窗口尺寸（配置热重载：1 个端口 → 3 个端口时，
   * 单灯的方形画布装不下灯带，必须跟着变）。
   *
   * 位置保持不变 —— 用户拖到哪儿就还在哪儿，不因为加了个端口就跳走。
   */
  fitToTaskCount(force = false): void {
    if (!this.win || this.win.isDestroyed()) {
      return;
    }
    const { width, height } = this.resolveCanvasSize();
    const [currentWidth, currentHeight] = this.win.getSize();
    if (!force && currentWidth === width && currentHeight === height) {
      return;
    }
    // 尺寸变化统一走 resizeAnchored：停靠时保持贴边那条边不动，
    // 未停靠时它就是原来的行为（只改尺寸、位置不动）。
    this.resizeAnchored(width, height, '悬浮灯尺寸随任务数调整');
  }

  setVisible(visible: boolean): void {
    if (!this.win || this.win.isDestroyed()) {
      return;
    }
    if (visible) {
      this.win.showInactive();
    } else {
      this.win.hide();
    }
  }

  get isAlive(): boolean {
    return this.win !== null && !this.win.isDestroyed();
  }

  /**
   * 暴露底层 BrowserWindow，供主进程向渲染层推送快照。
   * 比在 index.ts 里猴补丁原型要清晰得多。
   */
  getBrowserWindow(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  destroy(): void {
    if (this.moveTimer) {
      clearTimeout(this.moveTimer);
      this.moveTimer = null;
    }
    if (this.dockTimer) {
      clearTimeout(this.dockTimer);
      this.dockTimer = null;
    }
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
    }
    this.win = null;
  }
}
