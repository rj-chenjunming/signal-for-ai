/**
 * 主进程入口 —— 单实例锁 / 启动顺序 / 生命周期 / 退出清理（架构 §5.1）。
 *
 * 依赖: `electron`（app / BrowserWindow / screen / nativeTheme）+全部业务模块。
 *
 * 启动顺序（严格按架构 §5.1 时序图）：
 *   1. requestSingleInstanceLock()      —— 失败则提示并退出（P0-1 单实例）
 *   2. app.whenReady()
 *   3. ConfigManager.load()            —— 4 级路径优先级；不存在则落盘模板
 *   4. new TaskStore(cfg.tasks)        —— 唯一数据源
 *   5. TrayController.create()         —— 先出一个灰色图标，托盘立刻可见
 *   6. OverlayWindow.create()          —— 悬浮灯
 *   7. PanelWindow（懒创建，首次展开时才建）
 *   8. registerIpcHandlers(...)        —— 7 个 R→M 通道
 *   9. store.onChange(...)             —— 扇出到 tray / overlay / panel / notifier
 *  10. MonitorHost.start()             —— 逐个 try-catch 启动适配器
 *
 * 【全局兜底】架构 §8.4：uncaughtException / unhandledRejection **记日志但不退出**
 *（P1-7「崩溃不崩灯」—— 灯一直在绿比崩了更危险）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { BrowserWindow, app, dialog, globalShortcut, screen, shell } from 'electron';

import { ConfigManager, resolveConfigPath } from './config';
import { AppLogger, type Logger } from './logger';
import { TaskStore } from './store';
import { TrayController } from './tray';
import { OverlayWindow } from './overlay';
import { PanelWindow } from './panel';
import { broadcastToast, pushPlaySound, registerIpcHandlers } from './ipc';
import { Notifier } from './notify';
import { FocusService } from './focus';
import { ExtensionBridge } from './extension-bridge';
import { AutoLaunchService } from './autolaunch';
import { MonitorHost } from './monitors/host';
import { DshSignalArbiter } from './monitors/dsh-arbiter';
import { PAUSE_DURATION_MS, CONFIG_EXAMPLE_FILE_NAME } from '../shared/constants';
import { countVisibleTasks } from '../shared/visibility';
import type {
  AppConfig,
  ConfigReloadOutcome,
  FocusResult,
  NotifyActionId,
  NotifySettings,
  TaskAction,
  TaskActionRequest,
  TaskConfig,
  TaskState,
} from '../shared/types';

/* ============================================================================
 * 全局状态
 * ==========================================================================*/

let logger: Logger;
/** 让 TS 知道这些是模块级可变单例（避免 no-use-before-define 类误报）。 */
interface AppRefs {
  config: AppConfig;
  configManager: ConfigManager;
  store: TaskStore;
  tray: TrayController;
  overlay: OverlayWindow;
  panel: PanelWindow;
  focus: FocusService;
  /** 浏览器扩展桥接：让点击能在日常浏览器里精确切标签。 */
  extensionBridge: ExtensionBridge;
  notifier: Notifier;
  monitors: MonitorHost;
  /** D2 仲裁器：插件精确信号与轮询采集的合并点。 */
  arbiter: DshSignalArbiter;
  autolaunch: AutoLaunchService;
  tickTimer: NodeJS.Timeout | null;
  quitting: boolean;
  /** 真正退出前的清理钩子。 */
  cleanup: () => Promise<void>;
}

const refs: AppRefs = {
  config: null as unknown as AppConfig,
  configManager: null as unknown as ConfigManager,
  store: null as unknown as TaskStore,
  tray: null as unknown as TrayController,
  overlay: null as unknown as OverlayWindow,
  panel: null as unknown as PanelWindow,
  focus: null as unknown as FocusService,
  /** 浏览器扩展桥接：让点击能在日常浏览器里精确切标签。 */
  extensionBridge: null as unknown as ExtensionBridge,
  notifier: null as unknown as Notifier,
  monitors: null as unknown as MonitorHost,
  /** D2 仲裁器：插件精确信号与轮询采集的合并点。 */
  arbiter: null as unknown as DshSignalArbiter,
  autolaunch: null as unknown as AutoLaunchService,
  tickTimer: null,
  quitting: false,
  cleanup: async () => undefined,
};

/* ============================================================================
 * 启动前置自检（必须在碰 app 之前）
 * ==========================================================================*/

/**
 * ELECTRON_RUN_AS_NODE 自检。
 *
 * 【这个坑实测踩过，值得单独立一段】
 * 该环境变量一旦为真，`electron.exe` 会退化成「普通 Node 解释器」：
 * 传入的 .js 被当脚本执行、`require('electron')` 返回空对象，
 * 于是主进程第一行 `app.requestSingleInstanceLock()` 直接抛
 * `TypeError: Cannot read properties of undefined (reading 'requestSingleInstanceLock')`。
 *
 * 它和「缺 GUI 会话」是两回事，但报错信息完全看不出区别，容易误判。
 * 部分 CI / 容器 / 工具链（含某些 IDE 内置终端）会预先设好这个变量，
 * 于是双击图标能开、用命令行启动却静默失败，非常费解。
 *
 *【重要】Electron 在**启动早期**就把这个变量读进了内部状态，
 * 所以在 main 进程里 delete 它是**来不及**的（实测：`electron_1.app` 仍为 undefined）。
 * 真正的修复必须在 Electron 拉起之前由外部清除，见 scripts/start.mjs。
 * 这里保留检查作为兜底：正常启动路径下它不会有值，
 * 若有值则说明用户绕过了 start.mjs，此时至少能给出明确提示而非 cryptic error。
 */
if (process.env.ELECTRON_RUN_AS_NODE === '1') {
  delete process.env.ELECTRON_RUN_AS_NODE;
  process.stderr.write(
    '[ai-task-indicator] 警告：检测到 ELECTRON_RUN_AS_NODE=1。\n' +
      '  Electron 在启动早期已缓存该状态，运行时清除可能无效。\n' +
      '  请改用 `npm start`（脚本会自动清除），或手动执行：\n' +
      '    set ELECTRON_RUN_AS_NODE= && npx electron .\n',
  );
}

/**
 * GPU 兜底：本应用是纯 2D UI（几个原生圆点+ 文字），完全用不到硬件加速。
 *
 * 【为什么必须提前禁用】
 * 实测在无显卡/远程桌面/虚拟机里，Chromium 的 GPU 进程会以
 * `0xC0000409`（STATUS_FAIL_FAST_EXCEPTION）反复崩溃，
 * 最终打印 `FATAL: GPU process isn't usable. Goodbye.` 后整个应用退出 ——
 * 表现为「双击没反应」，但跟本应用代码毫无关系。
 *
 * `disableHardwareAcceleration` 必须在 app ready 之前调用才有效，
 * 所以放在这里而不是 bootstrap() 里。
 * 可以用命令行 `--enable-gpu` 覆盖（Electron 原生支持）。
 */
if (!process.argv.includes('--enable-gpu')) {
  app.disableHardwareAcceleration();
}

/* ============================================================================
 * 单实例锁（PRD P0-1 / 架构 A11）
 * ==========================================================================*/

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 已有实例在跑：提示后退出，不做任何初始化
  app.quit();
} else {
  app.on('second-instance', () => {
    // 架构 A11：第二个实例启动时把已有窗口拉出来
    refs.panel?.show();
  });

  void bootstrap();
}

/* ============================================================================
 * 启动流程
 * ==========================================================================*/

async function bootstrap(): Promise<void> {
  // 1) 日志先起来，后面每一步都能记
  logger = new AppLogger({
    level: process.env.AI_INDICATOR_DEBUG ? 'debug' : 'info',
    logDir: safeLogsDir(),
    appName: 'ai-task-indicator',
  });

  // 2) 全局兜底：记日志但不退出（架构 §8.4）
  process.on('uncaughtException', (err) => {
    logger?.error('未捕获异常（已记录，进程继续运行以保持灯可用）', err);
  });
  process.on('unhandledRejection', (reason) => {
    logger?.error('未处理的 Promise 拒绝（已记录）', reason);
  });

  await app.whenReady();

  try {
    await startApplication();
  } catch (err) {
    logger.error('启动失败', err);
    dialog.showErrorBox('AI 任务指示灯启动失败', (err as Error).message);
    app.quit();
  }
}

async function startApplication(): Promise<void> {
  /* -------- 3) 配置加载（4 级路径优先级） -------- */
  const resolved = resolveConfigPath({
    argv: process.argv,
    userDataDir: app.getPath('userData'),
  });
  // 开发模式下 config.example.yaml 在项目根，打包后在 resources 里
  const examplePath = locateExampleConfig();
  const configManager = new ConfigManager(resolved.path, logger, examplePath);
  refs.configManager = configManager;

  const outcome = configManager.load();
  const config = outcome.config;
  refs.config = config;

  logger.info(`配置已加载：${configPathLabel(resolved.source)}（${config.tasks.length} 个任务）`);
  for (const w of outcome.warnings) {
    logger.warn(`配置降级：${w}`);
  }

  /* -------- 4) 状态仓库（唯一数据源） -------- */
  const store = TaskStore.fromAppConfig(config, { logger });
  refs.store = store;

  /* -------- 5-7) 窗口与托盘 -------- */
  const panel = new PanelWindow({
    logger,
    onClosed: () => undefined,
  });
  refs.panel = panel;

  const overlay = new OverlayWindow({
    settings: config.lamp,
    logger,
    // 首次创建窗口时还没有快照，先用**配置**估算可显示行数。
    // 口径必须与 store 的 stripMode / shared/visibility.ts 一致，
    // 否则会出现"窗口按灯带开、内容按单灯渲染"的错位。
    // 走同一个 countVisibleTasks 而不是自己 filter，避免日后规则改动时口径漂移。
    taskCount: () => countVisibleTasks(config.tasks),
    onPositionChanged: (x, y) => {
      // 拖动后写回配置（架构 §1.3位置记忆）；写前自动备份
      try {
        configManager.update((cfg) => {
          cfg.lamp.x = x;
          cfg.lamp.y = y;
          return cfg;
        });
      } catch (err) {
        logger.warn(`写回灯位置失败：${(err as Error).message}`);
      }
    },
    onTogglePanel: () => {
      panel.toggle();
    },
  });
  refs.overlay = overlay;

  // 浏览器扩展桥接：让点击能在**日常浏览器**里精确切标签（决策 D73 路线②）。
  // Chrome 136+ 堵死了主浏览器上的调试端口，扩展是唯一不碰该限制的路。
  // 起不来（端口被占等）只降级、绝不影响其它功能。
  const extensionBridge = new ExtensionBridge(logger);
  refs.extensionBridge = extensionBridge;
  try {
    await extensionBridge.start();
  } catch (err) {
    logger.warn(`浏览器扩展桥接启动失败（扩展切标签将不可用）：${(err as Error).message}`);
  }

  const focus = new FocusService({
    logger,
    // 让窗口枚举知道"配置里显式要求按标题匹配"的窗口 —— 否则非终端窗口
    // （WorkBuddy / 浏览器 / 编辑器）会被 looksTerminal 过滤掉，永远匹配不到。
    // 传回调而不是快照，热重载后新配置立刻生效。
    tasks: () => configManager.config.tasks,
    extensionActivator: extensionBridge,
  });
  refs.focus = focus;
  // L0：启动时探测一次 wt.exe 并缓存（POC §4：本机可能没装 WT）
  void focus.probeWt().then(() => focus.refreshWindows());

  const autolaunch = new AutoLaunchService(logger);
  refs.autolaunch = autolaunch;
  if (config.app.autoLaunch) {
    autolaunch.setEnabled(true);
  }

  const tray = new TrayController(
    store,
    {
      onTogglePanel: () => panel.toggle(),
      onOpenPanel: () => panel.show(),
      onTogglePause: (paused) => void togglePause(paused),
      onToggleNotify: (field, value) => toggleNotify(field, value),
      onToggleClickThrough: (value) => toggleClickThrough(value),
      onOpenConfig: () => openConfigFile(),
      onReprobeTerminal: () => void reprobeTerminal(),
      onFocusTask: (taskId) => void focusTask(taskId),
      onQuit: () => quitApp(),
    },
    logger,
  );
  refs.tray = tray;
  tray.create();

  if (config.lamp.enabled) {
    overlay.create();
  }

  /* -------- 8) IPC 注册 -------- */
  registerIpcHandlers(
    {
      getSnapshot: () => store.getSnapshot(),
      // 停靠形态取决于窗口位置，只有 OverlayWindow 知道；渲染层挂载时会主动拉一次
      getLayout: () => ({ dock: overlay.currentDock }),
      handleTaskAction: (req) => handleTaskAction(req),
      handleNotifyAction: (taskId, action) => handleNotifyAction(taskId, action),
      togglePanel: () => panel.toggle(),
      lampDragged: (x, y) => {
        overlay.updatePosition(x, y);
        return { ok: true };
      },
      quit: () => quitApp(),
      reprobeTerminal: () => reprobeTerminal(),
    },
    logger,
  );

  /* -------- 通知器 -------- */
  const notifier = new Notifier({
    settings: config.notify,
    logger,
    playSound: (status) => pushPlaySound(overlayWindowOrNull(), status),
    onAction: (taskId, action) => void handleNotifyAction(taskId, action),
    isDoNotDisturb: () => isDoNotDisturb(),
  });
  refs.notifier = notifier;

  /* -------- 9) 状态变更扇出 -------- */
  store.onChange((snapshot, changes) => {
    try {
      tray.update(snapshot);
      overlay.setState(snapshot);
      panel.setState(snapshot);
      notifier.onStoreChange(snapshot, changes);
    } catch (err) {
      logger.error('状态扇出异常（已隔离）', err);
    }
  });

  /* -------- 10) 监控器 -------- */
  // D2 仲裁器：把 dsh 侧插件推来的**精确**等待信号与主动轮询合并。
  // 插件优先、轮询打底；插件信号带 TTL，过期后 DshMonitor 自动退回
  // `plan.pending` 近似判定（这条降级链是决策 D2 的核心要求）。
  const arbiter = new DshSignalArbiter({
    onExpired: (sessionId) => {
      logger.info(`会话 ${sessionId} 的插件等待信号已过期（插件可能停了），退回轮询近似判定`);
    },
  });
  refs.arbiter = arbiter;

  const monitors = new MonitorHost({
    store,
    config,
    logger,
    arbiter,
    onTaskFatal: (taskId, reason) => {
      if (taskId === '*') {
        tray.showBubble('监控启动失败', reason);
        return;
      }
      const name = store.getTask(taskId)?.name ?? taskId;
      tray.showBubble(`任务「${name}」监控异常`, reason);
    },
  });
  refs.monitors = monitors;
  await monitors.start();

  /* -------- 超时巡检（stale / dismiss 等时间驱动转移） -------- */
  refs.tickTimer = setInterval(() => {
    try {
      store.tick();
    } catch (err) {
      logger.error('状态巡检异常（已隔离）', err);
    }
  }, Math.max(1000, config.app.pollIntervalMs));
  refs.tickTimer.unref?.();

  /* -------- 配置热重载（PRD P1-2） -------- */
  configManager.watch(
    () => void onConfigReloaded(),
    (err) => {
      // 语法错误 -> 保留旧配置 + 气泡提示（架构 §5.3）
      logger.warn(`配置语法错误，已沿用旧配置：${err.message}`);
      tray.showBubble('配置语法错误', `已沿用旧配置：${err.message}`);
      broadcastToast([overlayWindowOrNull(), null], `配置语法错误：${err.message}`);
    },
  );

  /* -------- 生命周期 -------- */
  refs.cleanup = async (): Promise<void> => {
    if (refs.tickTimer) {
      clearInterval(refs.tickTimer);
      refs.tickTimer = null;
    }
    configManager.dispose();
    await monitors.stopAll();
    await refs.extensionBridge.stop();
    notifier.dispose();
    globalShortcut.unregisterAll();
    tray.destroy();
    overlay.destroy();
    panel.destroy();
  };

  app.on('window-all-closed', () => {
    // 常驻托盘应用：关窗口不退出（PRD P0-1）
    logger.info('所有窗口已关闭，应用继续在托盘常驻');
  });

  logger.info('AI 任务指示灯启动完成');
}

/* ============================================================================
 * 业务动作
 * ==========================================================================*/

async function handleTaskAction(req: TaskActionRequest): Promise<{ ok: boolean; message?: string }> {
  const { store, monitors, config } = refs;
  const action: TaskAction = req.action;

  switch (action) {
    case 'focus_terminal': {
      const task = config.tasks.find((t) => t.id === req.taskId);
      if (!task) {
        return { ok: false, message: `未知任务 ${req.taskId}` };
      }
      // 记下"点的是哪一行" —— 排查"点击跳错/没跳"时这是第一手证据
      logger.info(`聚焦请求：任务 ${req.taskId}`);
      const result = await refs.focus.focusTerminal(task, task.jump);
      return { ok: result.ok, message: result.detail };
    }
    case 'open_log': {
      const task = config.tasks.find((t) => t.id === req.taskId);
      const file = task?.jump?.logFile;
      if (!file) {
        return { ok: false, message: '该任务未配置 logFile' };
      }
      const result = refs.focus.openLog(file, task?.jump?.openWith);
      return { ok: result.ok, message: result.detail };
    }
    case 'open_dir': {
      const task = config.tasks.find((t) => t.id === req.taskId);
      const cwd = task?.jump?.cwd;
      if (!cwd) {
        return { ok: false, message: '该任务未配置 cwd' };
      }
      const result = refs.focus.openDir(cwd);
      return { ok: result.ok, message: result.detail };
    }
    case 'mark_read': {
      const state = store.getTask(req.taskId);
      if (state && (state.status === 'success' || state.status === 'failed')) {
        // 用户主动处理了 -> 下次同状态不再打扰
        refs.notifier.muteOnce(req.taskId, state.status);
      }
      store.markRead(req.taskId);
      return { ok: true };
    }
    case 'retry': {
      store.reset(req.taskId);
      // 重试后确保适配器在跑（可能被暂停过）
      await monitors.startTask(req.taskId);
      return { ok: true };
    }
    case 'pause_task': {
      const state = store.getTask(req.taskId);
      const nextPaused = !(state?.paused ?? false);
      store.setTaskPaused(req.taskId, nextPaused);
      if (nextPaused) {
        await monitors.stopTask(req.taskId);
      } else {
        await monitors.startTask(req.taskId);
      }
      return { ok: true };
    }
    default:
      return { ok: false, message: `未知动作 ${String(action)}` };
  }
}

async function handleNotifyAction(taskId: string, action: NotifyActionId): Promise<FocusResult> {
  const task = refs.config.tasks.find((t) => t.id === taskId);
  if (!task) {
    return { ok: false, level: 'L5-none', detail: `未知任务 ${taskId}` };
  }
  switch (action) {
    case 'focus_terminal':
      return refs.focus.focusTerminal(task, task.jump);
    case 'open_log': {
      const file = task.jump?.logFile;
      if (!file) {
        return { ok: false, level: 'L5-none', detail: '该任务未配置 logFile' };
      }
      return refs.focus.openLog(file, task.jump?.openWith);
    }
    case 'open_dir': {
      const cwd = task.jump?.cwd;
      if (!cwd) {
        return { ok: false, level: 'L5-none', detail: '该任务未配置 cwd' };
      }
      return refs.focus.openDir(cwd);
    }
    default:
      return { ok: false, level: 'L5-none', detail: `未知通知动作 ${String(action)}` };
  }
}

async function focusTask(taskId: string): Promise<void> {
  try {
    const task = refs.config.tasks.find((t) => t.id === taskId);
    if (!task) {
      return;
    }
    const result = await refs.focus.focusTerminal(task, task.jump);
    logger.info(`跳转任务 ${taskId}：${result.level} ${result.detail}`);
    if (!result.ok) {
      refs.tray.showBubble('无法定位终端', result.detail);
    }
  } catch (err) {
    logger.error(`跳转任务 ${taskId} 异常（已隔离）`, err);
  }
}

async function togglePause(paused: boolean): Promise<void> {
  try {
    await refs.monitors.setPaused(paused);
    refs.store.setPaused(paused);
    if (paused) {
      logger.info(`监控已暂停（${PAUSE_DURATION_MS / 60000} 分钟）`);
    } else {
      logger.info('监控已恢复');
    }
  } catch (err) {
    logger.error('切换暂停状态异常（已隔离）', err);
  }
}

function toggleNotify(field: 'popup' | 'sound', value: boolean): void {
  // 先在内存里算出新值，再让 ConfigManager.update 负责落盘（内部会做备份）。
  const nextNotify: NotifySettings = { ...refs.config.notify, [field]: value };
  const updated = refs.configManager.update((cfg) => {
    cfg.notify = { ...cfg.notify, [field]: value };
    return cfg;
  });
  refs.config = updated;
  refs.store.setNotifyPrefs({ popup: nextNotify.popup, sound: nextNotify.sound });
  refs.notifier.updateSettings(nextNotify);
  logger.info(`通知设置变更：${field} = ${value}`);
}

/**
 * 切换悬浮灯「锁定/穿透」（设计决策 D10）。
 *
 * 与 toggleNotify 同套路：先算新值 → ConfigManager 落盘（自动备份）→ 内存生效。
 * 三处必须同步，缺一处就会出现「菜单勾了但窗口没锁」或「重启后设置丢了」：
 *   1. store 的快照字段（菜单勾选状态读它）
 *   2. overlay 的真实窗口行为（setIgnoreMouseEvents）
 *   3. 配置文件（下次启动仍生效）
 */
function toggleClickThrough(value: boolean): void {
  const updated = refs.configManager.update((cfg) => {
    cfg.lamp = { ...cfg.lamp, clickThrough: value };
    return cfg;
  });
  refs.config = updated;
  refs.store.setClickThrough(value);
  refs.overlay.applySettings(updated.lamp);
  logger.info(`悬浮灯${value ? '已锁定（鼠标穿透）' : '已解锁'}，盖在其它窗口上${value ? '不再挡鼠标' : '可点击'}`);
}

function openConfigFile(): void {
  try {
    const target = refs.configManager.path;
    shell.showItemInFolder(target);
  } catch (err) {
    logger.error(`打开配置文件失败：${(err as Error).message}`);
  }
}

async function reprobeTerminal(): Promise<{ wtAvailable: boolean }> {
  try {
    const result = await refs.focus.reprobe();
    const msg = result.wtAvailable
      ? '已找到 Windows Terminal，终端跳转将复用 WT 窗口'
      : '未找到 Windows Terminal，终端跳转会走窗口聚焦/目录兜底';
    refs.tray.showBubble('终端探测', msg);
    return result;
  } catch (err) {
    logger.error('重新探测终端失败（已隔离）', err);
    return { wtAvailable: false };
  }
}

/** 配置热重载回调。 */
async function onConfigReloaded(): Promise<void> {
  try {
    const newConfig = refs.configManager.config;
    refs.config = newConfig;

    // 1) 差分同步 store 里的任务集合（状态保留，避免闪断）
    const diff = refs.store.syncTasks(newConfig.tasks);

    // 2) 差分重启监控器
    const restart = await refs.monitors.reload(newConfig);

    // 3) 应用外观/通知设置
    refs.overlay.applySettings(newConfig.lamp);
    // 用户在 yaml 里改了 lamp.clickThrough 时，同步 store 的快照字段，
    // 否则托盘的「锁定浮窗」勾选状态会与实际行为不一致。
    refs.store.syncClickThrough(newConfig.lamp.clickThrough);
    // 任务数变了要跟着换画布尺寸：单灯的方形窗口装不下灯带（D6/D9）。
    // 位置保持不变 —— 用户拖到哪儿就还在哪儿，不因为加了个端口就跳走。
    refs.overlay.fitToTaskCount();
    refs.notifier.updateSettings(newConfig.notify);
    refs.store.setNotifyPrefs({ popup: newConfig.notify.popup, sound: newConfig.notify.sound });

    const outcome: ConfigReloadOutcome = {
      ok: true,
      added: [...diff.added, ...restart.added],
      removed: [...diff.removed, ...restart.removed],
      restarted: restart.restarted,
      warnings: [],
    };
    logger.info(
      `配置已热重载：新增 ${outcome.added.length} / 移除 ${outcome.removed.length} / 重启 ${outcome.restarted.length}`,
    );
    broadcastToast(
      [refs.overlay.isAlive ? overlayWindowOrNull() : null, null],
      `配置已重载（新增 ${outcome.added.length}，重启 ${outcome.restarted.length}）`,
    );
  } catch (err) {
    logger.error('配置热重载处理异常（已隔离）', err);
    refs.tray.showBubble('配置重载失败', (err as Error).message);
  }
}

/* ============================================================================
 * DND：全屏应用检测（PRD P1-5）
 * ==========================================================================*/

/**
 * 保守策略：拿不到可靠信息时**按「不打扰」处理**（架构 §1.5）。
 * 这里用「是否有全屏显示器」作为近似判断 —— 比调 Win32 API 简单且足够保守。
 */
function isDoNotDisturb(): boolean {
  try {
    const displays = screen.getAllDisplays();
    return displays.some((d) => d.bounds.width > 0 && d.bounds.height === d.size.height);
  } catch {
    return false; // 拿不到 display 信息时不阻塞通知
  }
}

/* ============================================================================
 * 退出
 * ==========================================================================*/

async function quitApp(): Promise<void> {
  if (refs.quitting) {
    return;
  }
  refs.quitting = true;
  try {
    await refs.cleanup();
  } catch (err) {
    logger?.error('退出清理异常（忽略）', err);
  }
  app.quit();
}

app.on('before-quit', () => {
  if (!refs.quitting) {
    refs.quitting = true;
    void refs.cleanup();
  }
});

/* ============================================================================
 * 工具
 * ==========================================================================*/

function overlayWindowOrNull(): BrowserWindow | null {
  return refs.overlay?.getBrowserWindow() ?? null;
}

function safeLogsDir(): string | undefined {
  try {
    return app.getPath('logs');
  } catch {
    return undefined;
  }
}

/** 定位 config.example.yaml（开发态在项目根，打包态在 resources）。 */
function locateExampleConfig(): string {
  const candidates = [
    path.join(process.cwd(), CONFIG_EXAMPLE_FILE_NAME),
    path.join(app.getAppPath(), CONFIG_EXAMPLE_FILE_NAME),
    path.join(__dirname, '..', '..', CONFIG_EXAMPLE_FILE_NAME),
    path.join(process.resourcesPath ?? '', CONFIG_EXAMPLE_FILE_NAME),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        return c;
      }
    } catch {
      /* ignore */
    }
  }
  return candidates[0]!;
}

function configPathLabel(source: string): string {
  switch (source) {
    case 'cli':
      return '--config 指定';
    case 'user':
      return '用户目录';
    case 'userData':
      return 'userData';
    default:
      return '默认（已生成）';
  }
}

/** 导出便于测试与调试。 */
export const __testing = { isDoNotDisturb, toggleNotify, handleTaskAction };

/** 类型断言：确保 refs 在使用点被视为已初始化（运行时由 bootstrap 保证）。 */
export type { AppRefs, TaskState, TaskConfig };
