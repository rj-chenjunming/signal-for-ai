/**
 * IPC 通道注册（主进程侧）—— 架构 §4.3 的 7 个 R→M 通道 + 2 个 M→R 推送。
 *
 * 依赖: `electron`（ipcMain / BrowserWindow）+ shared/ipc-contract + 各业务模块。
 *
 * 【安全约定】
 *  - 通道名一律取自 shared/ipc-contract 的常量，**禁止裸字符串**；
 *  - 每个 handler 内部 try-catch，任何异常转成 `{ ok:false, message }` 而非让渲染层拿到未捕获异常；
 *  - 只对**本应用自己创建**的窗口注册回调，不接受任意 sender。
 */

import { ipcMain, type BrowserWindow, type WebContents } from 'electron';

import { IPC, IPC_PUSH, type ConfigReloadOutcome, type InvokeMap } from '../shared/ipc-contract';
import type {
  FocusResult,
  GoalExportResult,
  GoalsView,
  LampLayout,
  NotifyActionId,
  ProbeTerminalResponse,
  Snapshot,
  TaskActionRequest,
  TaskActionResponse,
  TaskStatus,
} from '../shared/types';
import type { Logger } from './logger';

/** 业务能力集合 —— 由 index.ts 注入，避免 ipc.ts 直接依赖具体实现。 */
export interface IpcHandlers {
  showPanelMessage?: (message: string) => void;
  takePanelMessage?: () => { message?: string };
  setMonitoringPaused?: (paused: boolean) => Promise<TaskActionResponse>;
  /** 渲染层挂载时拉初始快照。 */
  getSnapshot: () => Snapshot;
  /** 任务动作（面板按钮 / 通知按钮）。 */
  handleTaskAction: (req: TaskActionRequest) => Promise<TaskActionResponse>;
  /** 通知按钮动作。 */
  handleNotifyAction: (taskId: string, action: NotifyActionId) => Promise<FocusResult>;
  /** 左键单击灯-> 切换面板，返回切换后的展开状态。 */
  togglePanel: () => boolean;
  /** 灯被拖动 -> 写回配置。 */
  lampDragged: (x: number, y: number) => { ok: boolean };
  /** 退出应用。 */
  quit: () => void;
  /** 重新探测终端。 */
  reprobeTerminal: () => Promise<ProbeTerminalResponse>;
  /** 当前浮窗布局（停靠方向）—— 渲染层挂载时主动拉一次。 */
  getLayout?: () => LampLayout;
  /** 配置热重载完成（主进程 -> 渲染层可据此拉新快照）。 */
  onConfigReloaded?: (outcome: ConfigReloadOutcome) => void;

  /* ---- SPEC-024：目标清单 ---- */
  goalsGet?: () => GoalsView;
  goalsAdd?: (request: unknown) => TaskActionResponse;
  goalsRemove?: (request: unknown) => TaskActionResponse;
  goalsUpdateTitle?: (request: unknown) => TaskActionResponse;
  goalsSetProgress?: (request: unknown) => TaskActionResponse;
  goalsComplete?: (request: unknown) => TaskActionResponse;
  goalsAddEntry?: (request: unknown) => TaskActionResponse;
  goalsDeleteEntry?: (request: unknown) => TaskActionResponse;
  goalsExport?: () => Promise<GoalExportResult>;
  goalsHide?: () => void;
  openGoals?: () => TaskActionResponse;
}

/** 注册全部 invoke 通道。 */
export function registerIpcHandlers(handlers: IpcHandlers, logger: Logger): void {
  // 每个 handler 都包一层安全壳：异常绝不让渲染层拿到未处理 rejection。
  const safe = <K extends keyof InvokeMap>(
    channel: K,
    handler: (payload: InvokeMap[K]['request']) => InvokeMap[K]['response'] | Promise<InvokeMap[K]['response']>,
  ): void => {
    ipcMain.handle(channel, async (_event, payload: unknown) => {
      try {
        return await handler(payload as InvokeMap[K]['request']);
      } catch (err) {
        logger.error(`IPC 通道 ${String(channel)} 处理异常（已隔离）`, err);
        // 返回一个形状合法的降级值，避免渲染层拿到 undefined 后崩
        return fallbackResponse(String(channel)) as InvokeMap[K]['response'];
      }
    });
  };

  safe(IPC.GET_SNAPSHOT, () => handlers.getSnapshot());
  safe(IPC.SHOW_PANEL_MESSAGE, (message) => {
    if (typeof message !== 'string' || !message.trim() || message.length > 2000) return { ok: false, message: '无效提示内容' };
    if (!handlers.showPanelMessage) return { ok: false, message: '提示面板暂不可用' };
    handlers.showPanelMessage(message);
    return { ok: true };
  });
  safe(IPC.TAKE_PANEL_MESSAGE, () => handlers.takePanelMessage?.() ?? {});
  safe(IPC.SET_MONITORING_PAUSED, (paused) => {
    if (typeof paused !== 'boolean') return { ok: false, message: '暂停状态必须为布尔值' };
    return handlers.setMonitoringPaused?.(paused) ?? { ok: false, message: '暂停功能暂不可用' };
  });

  safe(IPC.TASK_ACTION, (req) => handlers.handleTaskAction(req));

  safe(IPC.LAMP_TOGGLE_PANEL, () => ({ expanded: handlers.togglePanel() }));

  safe(IPC.LAMP_DRAGGED, (pos) => {
    if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') {
      return { ok: false };
    }
    return handlers.lampDragged(pos.x, pos.y);
  });

  safe(IPC.APP_QUIT, () => {
    handlers.quit();
    return undefined as never;
  });

  safe(IPC.NOTIFY_ACTION, (req) => handlers.handleNotifyAction(req.taskId, req.action));

  safe(IPC.REPROBE_TERMINAL, () => handlers.reprobeTerminal());

  // 布局：没注入 handler 时回一个"不停靠"的合法值，渲染层不必判空
  safe(IPC.GET_LAYOUT, () => handlers.getLayout?.() ?? { dock: 'none' });

  /* ---- SPEC-024：目标清单（未注入时返回可解释的降级值） ---- */
  safe(IPC.GOALS_GET, () => handlers.goalsGet?.() ?? { goals: [] });
  safe(IPC.GOALS_ADD, (request) => handlers.goalsAdd?.(request) ?? goalsUnavailable());
  safe(IPC.GOALS_DELETE, (request) => handlers.goalsRemove?.(request) ?? goalsUnavailable());
  safe(
    IPC.GOALS_UPDATE_TITLE,
    (request) => handlers.goalsUpdateTitle?.(request) ?? goalsUnavailable(),
  );
  safe(
    IPC.GOALS_SET_PROGRESS,
    (request) => handlers.goalsSetProgress?.(request) ?? goalsUnavailable(),
  );
  safe(IPC.GOALS_COMPLETE, (request) => handlers.goalsComplete?.(request) ?? goalsUnavailable());
  safe(IPC.GOALS_ADD_ENTRY, (request) => handlers.goalsAddEntry?.(request) ?? goalsUnavailable());
  safe(
    IPC.GOALS_DELETE_ENTRY,
    (request) => handlers.goalsDeleteEntry?.(request) ?? goalsUnavailable(),
  );
  safe(IPC.GOALS_EXPORT, () => handlers.goalsExport?.() ?? {
    ok: false,
    message: '目标导出暂不可用',
  });
  safe(IPC.GOALS_HIDE, () => {
    handlers.goalsHide?.();
    return undefined as never;
  });
  safe(IPC.OPEN_GOALS, () => handlers.openGoals?.() ?? goalsUnavailable());
}

/** 向指定窗口推送布局（M→R）。 */
export function pushLayout(win: BrowserWindow | null, layout: LampLayout): void {
  sendTo(win, IPC_PUSH.LAYOUT, layout, 'app:layout');
}

/** 向指定窗口推送快照（M→R）。 */
export function pushSnapshot(win: BrowserWindow | null, snapshot: Snapshot): void {
  sendTo(win, IPC_PUSH.SNAPSHOT, snapshot, 'app:snapshot');
}

/** 向指定窗口推送音效播放指令（M→R）。 */
export function pushPlaySound(win: BrowserWindow | null, status: TaskStatus): void {
  sendTo(win, IPC_PUSH.PLAY_SOUND, { status }, 'notify:play');
}

/** 向目标窗口推送目标数据（M→R，SPEC-024）。 */
export function pushGoals(win: BrowserWindow | null, view: GoalsView): void {
  sendTo(win, IPC_PUSH.GOALS_CHANGED, view, 'goals:changed');
}

/** 目标通道未注入时的统一降级响应。 */
function goalsUnavailable(): TaskActionResponse {
  return { ok: false, message: '目标功能暂不可用' };
}

/** 向所有窗口广播一条 toast 提示。 */
export function broadcastToast(wins: (BrowserWindow | null)[], message: string): void {
  for (const win of wins) {
    sendTo(win, IPC.APP_TOAST, { message }, 'app:toast');
  }
}

/** 内部统一发送，容忍窗口已销毁 / 未加载完成的情况。 */
function sendTo(
  win: BrowserWindow | null,
  channel: string,
  payload: unknown,
  label: string,
): void {
  if (!win || win.isDestroyed()) {
    return;
  }
  try {
    const contents: WebContents = win.webContents;
    if (contents.isDestroyed()) {
      return;
    }
    contents.send(channel, payload);
  } catch (err) {
    // 窗口正在销毁时会抛，忽略即可
    void err;
    void label;
  }
}

/** 通道处理失败时的降级响应（保持形状合法）。 */
function fallbackResponse(channel: string): unknown {
  if (channel === IPC.GET_SNAPSHOT) {
    return {
      aggregate: 'idle',
      runningCount: 0,
      counts: {
        idle: 0,
        starting: 0,
        running: 0,
        waiting: 0,
        success: 0,
        failed: 0,
        unknown: 0,
      },
      tasks: [],
      paused: false,
      notify: { popup: false, sound: false },
      version: 0,
      stripMode: false,
      hiddenCount: 0,
      displayTasks: [],
      clickThrough: false,
    } satisfies Snapshot;
  }
  if (channel === IPC.TASK_ACTION || channel === IPC.SET_MONITORING_PAUSED || channel === IPC.SHOW_PANEL_MESSAGE) {
    return { ok: false, message: '主进程处理失败' } satisfies TaskActionResponse;
  }
  if (channel === IPC.NOTIFY_ACTION) {
    return { ok: false, level: 'L5-none', detail: '主进程处理失败' } satisfies FocusResult;
  }
  if (channel === IPC.REPROBE_TERMINAL) {
    return { wtAvailable: false } satisfies ProbeTerminalResponse;
  }
  if (channel === IPC.GET_LAYOUT) {
    return { dock: 'none' } satisfies LampLayout;
  }
  if (channel === IPC.GOALS_GET) {
    return { goals: [] } satisfies GoalsView;
  }
  if (channel === IPC.GOALS_EXPORT) {
    return { ok: false, message: '主进程处理失败' } satisfies GoalExportResult;
  }
  if (
    channel === IPC.GOALS_ADD ||
    channel === IPC.GOALS_DELETE ||
    channel === IPC.GOALS_UPDATE_TITLE ||
    channel === IPC.GOALS_SET_PROGRESS ||
    channel === IPC.GOALS_COMPLETE ||
    channel === IPC.GOALS_ADD_ENTRY ||
    channel === IPC.GOALS_DELETE_ENTRY ||
    channel === IPC.OPEN_GOALS
  ) {
    return { ok: false, message: '主进程处理失败' } satisfies TaskActionResponse;
  }
  if (channel === IPC.TAKE_PANEL_MESSAGE) return {};
  return { ok: false };
}
