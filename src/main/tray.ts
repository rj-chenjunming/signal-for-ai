/**
 * 托盘控制器 —— 图标装配 / 菜单 / tooltip / 点击事件（PRD P0-1）。
 *
 * 依赖: `electron`（Tray / Menu / nativeImage）+ shared/* + snapshot.ts + focus.ts + store。
 *
 * 图标生成逻辑在 snapshot.ts（纯函数、可测），本文件只负责 Electron 侧的装配与生命周期。
 */

import { Menu, Tray, nativeImage, type NativeImage } from 'electron';

import {
  BADGE_MIN_SHOW,
  TRAY_ICON_SIZES,
} from '../shared/constants';
import type { Snapshot, TaskStatus } from '../shared/types';
import type { TaskStore } from './store';
import {
  buildTooltip,
  renderTrayBitmap,
  toNativeImage,
  type ElectronNativeImage,
} from './snapshot';
import type { Logger } from './logger';

/** 托盘菜单动作 -> 宿主回调。 */
export interface TrayCallbacks {
  /** 左键点击托盘 -> 展开/收起面板。 */
  onTogglePanel: () => void;
  /** 双击托盘 -> 展开面板并聚焦。 */
  onOpenPanel: () => void;
  /** 暂停/恢复监控。 */
  onTogglePause: (paused: boolean) => void;
  /** 打开目标清单窗口（SPEC-024）。 */
  onOpenGoals: () => void;
  /** 切换通知开关。 */
  onToggleNotify: (field: 'popup' | 'sound', value: boolean) => void;
  /**
   * 切换悬浮灯的「锁定/穿透」（设计决策 D10）。
   * 锁上后浮窗完全不吃鼠标，盖在 IDE 上也不挡事。
   */
  onToggleClickThrough: (value: boolean) => void;
  /** 打开配置文件。 */
  onOpenConfig: () => void;
  /** 重新探测终端（架构 §2.2 L0）。 */
  onReprobeTerminal: () => void;
  /** 打开某个任务的现场。 */
  onFocusTask: (taskId: string) => void;
  /** 退出应用。 */
  onQuit: () => void;
}

export class TrayController {
  private tray: Tray | null = null;
  private readonly imageCache = new Map<string, NativeImage>();
  private lastAggregate: TaskStatus | null = null;

  constructor(
    private readonly store: TaskStore,
    private readonly callbacks: TrayCallbacks,
    private readonly logger: Logger,
  ) {}

  /** 创建托盘图标。 */
  create(): void {
    if (this.tray) {
      return;
    }
    const image = this.iconFor(this.store.getSnapshot());
    this.tray = new Tray(image);
    this.tray.setToolTip(buildTooltip(toTrayCounts(this.store.getSnapshot()), this.store.pausedGlobally));

    // PRD P0-1：左键展开面板、右键菜单
    this.tray.on('click', () => this.callbacks.onTogglePanel());
    this.tray.on('double-click', () => this.callbacks.onOpenPanel());
    this.tray.on('right-click', () => {
      this.tray?.popUpContextMenu(this.buildMenu());
    });

    this.logger.info('托盘图标已创建');
  }

  /**
   * 状态变更时刷新图标 + tooltip。
   *
   * PRD 场景C：任务失败时除了托盘变红，还给一次气泡提示，让用户不看屏幕也能知道。
   * 用 lastAggregate 记住上一次聚合态，只在「新出现 failed」时提示，避免刷屏。
   */
  update(snapshot: Snapshot): void {
    if (!this.tray) {
      return;
    }
    this.tray.setImage(this.iconFor(snapshot));
    this.tray.setToolTip(buildTooltip(toTrayCounts(snapshot), snapshot.paused));

    const previous = this.lastAggregate;
    this.lastAggregate = snapshot.aggregate;
    if (previous !== 'failed' && snapshot.aggregate === 'failed') {
      const failed = snapshot.tasks.filter((t) => t.status === 'failed' && !t.paused);
      if (failed.length > 0) {
        const names = failed.map((t) => t.name).join('、');
        this.showBubble('任务失败', `${names} —— 点击托盘图标查看详情`);
      }
    }
  }

  /** 生成指定状态的图标（含数量徽标）。 */
  private iconFor(snapshot: Snapshot): NativeImage {
    const badge = snapshot.runningCount >= BADGE_MIN_SHOW ? snapshot.runningCount : 0;
    return this.iconForState(snapshot.aggregate, badge);
  }

  /** 为 (状态, 徽标数) 生成图标，带缓存避免重复绘制。 */
  iconForState(status: TaskStatus, badgeCount: number): NativeImage {
    const key = `${status}:${badgeCount}`;
    const cached = this.imageCache.get(key);
    if (cached) {
      return cached;
    }

    // 以 16px 为主图；@2x 用 32px 表示（Windows 托盘按 DPI 缩放）。
    const base = renderTrayBitmap(status, badgeCount, TRAY_ICON_SIZES[0]!);
    const retina = renderTrayBitmap(status, badgeCount, TRAY_ICON_SIZES[1]!);

    const image = toNativeImage(base, nativeImage.createFromBitmap.bind(nativeImage) as unknown as (
      buffer: Buffer,
      opts: { width: number; height: number },
    ) => ElectronNativeImage) as unknown as NativeImage;

    // 追加 @2x 表示，让高分屏下不模糊
    try {
      image.addRepresentation({
        scaleFactor: 2,
        width: retina.width,
        height: retina.height,
        buffer: retina.data,
      });
    } catch (err) {
      // addRepresentation 失败不影响主图可用性
      this.logger.warn(`添加 @2x 图标表示失败：${(err as Error).message}`);
    }

    this.imageCache.set(key, image);
    return image;
  }

  /** 构建右键菜单（PRD P0-1：打开面板 / 暂停监控 / 退出；PRD §7.2 右键菜单更完整）。 */
  buildMenu(): Menu {
    const snapshot = this.store.getSnapshot();
    const taskItems = snapshot.tasks
      .filter((t) => t.status !== 'idle')
      .slice(0, 10)
      .map((task) => ({
        label: `${statusIcon(task.status)} ${task.name}（${statusLabel(task.status)}）`,
        click: () => this.callbacks.onFocusTask(task.taskId),
      }));

    const template: Parameters<typeof Menu.buildFromTemplate>[0] = [
      { label: `共 ${snapshot.tasks.length} 个任务`, enabled: false },
      { type: 'separator' },
      ...(taskItems.length > 0
        ? ([{ label: '跳转到任务现场', submenu: taskItems }, { type: 'separator' }] as const)
        : []),
      { label: '打开面板', click: () => this.callbacks.onOpenPanel() },
      { label: '目标清单…', click: () => this.callbacks.onOpenGoals() },
      {
        label: snapshot.paused ? '恢复监控' : '暂停监控（30 分钟）',
        click: () => this.callbacks.onTogglePause(!snapshot.paused),
      },
      { type: 'separator' },
      {
        label: '完成时弹窗通知',
        type: 'checkbox',
        checked: snapshot.notify.popup,
        click: (item) => this.callbacks.onToggleNotify('popup', item.checked),
      },
      {
        label: '完成时播放提示音',
        type: 'checkbox',
        checked: snapshot.notify.sound,
        click: (item) => this.callbacks.onToggleNotify('sound', item.checked),
      },
      { type: 'separator' },
      {
        // D10：锁上后浮窗完全不吃鼠标，可安心盖在编辑器角落
        label: '锁定浮窗（鼠标穿透）',
        type: 'checkbox',
        checked: snapshot.clickThrough,
        click: (item) => this.callbacks.onToggleClickThrough(item.checked),
      },
      { type: 'separator' },
      { label: '重新探测终端', click: () => this.callbacks.onReprobeTerminal() },
      { label: '打开配置文件', click: () => this.callbacks.onOpenConfig() },
      { type: 'separator' },
      { label: '退出', click: () => this.callbacks.onQuit() },
    ];

    return Menu.buildFromTemplate(template as Electron.MenuItemConstructorOptions[]);
  }

  /** 显示一条托盘气泡（PRD P1-2 配置错误提示 / P2 崩溃告警）。 */
  showBubble(title: string, content: string): void {
    if (!this.tray) {
      return;
    }
    try {
      this.tray.displayBalloon({
        title,
        content,
        iconType: 'none' as const,
      });
    } catch (err) {
      // 气泡在部分 Windows 环境不可用（POC 沙箱即如此）——只记日志，不影响主流程
      this.logger.warn(`显示托盘气泡失败：${(err as Error).message}`);
    }
  }

  get isAlive(): boolean {
    return this.tray !== null && !this.tray.isDestroyed();
  }

  /** 供 focus 复用（点击托盘菜单里的任务项）。 */
  destroy(): void {
    if (this.tray && !this.tray.isDestroyed()) {
      this.tray.destroy();
    }
    this.tray = null;
    this.imageCache.clear();
  }
}

/** 从 Snapshot 提取 tooltip 所需的计数。 */
export function toTrayCounts(snapshot: Snapshot): {
  running: number;
  waiting: number;
  success: number;
  failed: number;
  idle: number;
  unknown: number;
} {
  const c = snapshot.counts;
  return {
    running: c.running,
    waiting: c.waiting,
    success: c.success,
    failed: c.failed,
    idle: c.idle,
    unknown: c.unknown,
  };
}

/** 菜单用的状态小图标。 */
function statusIcon(status: TaskStatus): string {
  switch (status) {
    case 'failed':
      return '✕';
    case 'waiting':
      return '⏸';
    case 'running':
      return '▶';
    case 'starting':
      return '◌';
    case 'success':
      return '✓';
    case 'unknown':
      return '?';
    case 'idle':
    default:
      return '○';
  }
}

function statusLabel(status: TaskStatus): string {
  switch (status) {
    case 'failed':
      return '失败';
    case 'waiting':
      return '等待授权';
    case 'running':
      return '运行中';
    case 'starting':
      return '启动中';
    case 'success':
      return '已完成';
    case 'unknown':
      return '失联';
    case 'idle':
    default:
      return '空闲';
  }
}
