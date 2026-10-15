/**
 * 预加载脚本 —— contextBridge 白名单（架构 §1.2 / §8.6）。
 *
 * 依赖: `electron` 的 contextBridge + shared/ipc-contract。
 *
 * 【安全约定】（架构 §1.2）
 *  - `nodeIntegration: false` + `contextIsolation: true`，渲染层**无任何 Node 能力**；
 *  - 只暴露 §4.3 白名单里的 7 个方法 + 3 个订阅函数，不 open 整个 ipcRenderer；
 *  - 渲染层是 file:// 加载的本地可信页面，但依然走白名单以防配置注入。
 *
 * 共享类型：RendererApi（shared/ipc-contract）—— 主进程与渲染层对同一份契约编译，
 * 任何签名漂移都会在 tsc 阶段暴露。
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import {
  IPC,
  IPC_GLOBAL_KEY,
  IPC_PUSH,
  type RendererApi,
} from '../shared/ipc-contract';
import type {
  FocusResult,
  NotifyActionId,
  PlaySoundRequest,
  ProbeTerminalResponse,
  Snapshot,
  TaskActionRequest,
  TaskActionResponse,
} from '../shared/types';

/** 判断当前渲染层是哪个窗口（overlay / panel），由 HTML 上的 data 属性决定。 */
function detectRole(): 'overlay' | 'panel' {
  try {
    const el = document.querySelector('[data-indicator-role]');
    const value = el?.getAttribute('data-indicator-role');
    return value === 'panel' ? 'panel' : 'overlay';
  } catch {
    return 'overlay';
  }
}

/** 把 ipcRenderer.on 包装成「返回取消订阅函数」的形态，避免渲染层忘记 removeListener。 */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => {
    try {
      cb(payload);
    } catch (err) {
      // 渲染层回调异常不能冒泡到 ipcRenderer（会变成未捕获错误）
      console.error('[preload] 订阅回调异常', err);
    }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: RendererApi = {
  getSnapshot: (): Promise<Snapshot> => ipcRenderer.invoke(IPC.GET_SNAPSHOT),

  sendTaskAction: (req: TaskActionRequest): Promise<TaskActionResponse> =>
    ipcRenderer.invoke(IPC.TASK_ACTION, req),

  togglePanel: (): Promise<{ expanded: boolean }> =>
    ipcRenderer.invoke(IPC.LAMP_TOGGLE_PANEL),

  notifyLampDragged: (pos: { x: number; y: number }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.LAMP_DRAGGED, pos),

  quit: (): Promise<void> => ipcRenderer.invoke(IPC.APP_QUIT),

  sendNotifyAction: (req: {
    taskId: string;
    action: NotifyActionId;
  }): Promise<FocusResult> => ipcRenderer.invoke(IPC.NOTIFY_ACTION, req),

  reprobeTerminal: (): Promise<ProbeTerminalResponse> =>
    ipcRenderer.invoke(IPC.REPROBE_TERMINAL),

  onSnapshot: (cb: (snapshot: Snapshot) => void): (() => void) =>
    subscribe<Snapshot>(IPC_PUSH.SNAPSHOT, cb),

  onPlaySound: (cb: (req: PlaySoundRequest) => void): (() => void) =>
    subscribe<PlaySoundRequest>(IPC_PUSH.PLAY_SOUND, cb),

  onToast: (cb: (req: { message: string }) => void): (() => void) =>
    subscribe<{ message: string }>(IPC.APP_TOAST, cb),

  role: detectRole(),
};

contextBridge.exposeInMainWorld(IPC_GLOBAL_KEY, api);
