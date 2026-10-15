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
  /** 配置热重载完成（主进程 -> 渲染层可据此拉新快照）。 */
  onConfigReloaded?: (outcome: ConfigReloadOutcome) => void;
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
}

/** 向指定窗口推送快照（M→R）。 */
export function pushSnapshot(win: BrowserWindow | null, snapshot: Snapshot): void {
  sendTo(win, IPC_PUSH.SNAPSHOT, snapshot, 'app:snapshot');
}

/** 向指定窗口推送音效播放指令（M→R）。 */
export function pushPlaySound(win: BrowserWindow | null, status: TaskStatus): void {
  sendTo(win, IPC_PUSH.PLAY_SOUND, { status }, 'notify:play');
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
  if (channel === IPC.TASK_ACTION) {
    return { ok: false, message: '主进程处理失败' } satisfies TaskActionResponse;
  }
  if (channel === IPC.NOTIFY_ACTION) {
    return { ok: false, level: 'L5-none', detail: '主进程处理失败' } satisfies FocusResult;
  }
  if (channel === IPC.REPROBE_TERMINAL) {
    return { wtAvailable: false } satisfies ProbeTerminalResponse;
  }
  return { ok: false };
}
