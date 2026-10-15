/**
 * IPC 通道契约 —— 主进程与渲染层共用的通道名与方向定义。
 *
 * 依赖: 仅 `import type`（编译期擦除）。
 *
 * 【强制约定】架构 §4.3：通道名只在本文件定义，任何主/渲染侧代码都不得写裸字符串。
 * 方向约定：'R→M' = 渲染层 invoke 主进程；'M→R' = 主进程 send 渲染层。
 */

import type {
  ConfigReloadOutcome,
  FocusResult,
  NotifyActionId,
  PlaySoundRequest,
  ProbeTerminalResponse,
  Snapshot,
  TaskActionRequest,
  TaskActionResponse,
} from './types';

/** 主进程侧会处理的 invoke 通道（R→M）。 */
export const IPC = Object.freeze({
  /** 渲染层挂载时拉取初始快照。 */
  GET_SNAPSHOT: 'app:getSnapshot',
  /** 面板按钮 / 托盘菜单共用的任务动作入口。 */
  TASK_ACTION: 'task:action',
  /** 左键单击悬浮灯 -> 展开/收起面板。 */
  LAMP_TOGGLE_PANEL: 'lamp:togglePanel',
  /** 灯被拖动 -> 位置写回配置。 */
  LAMP_DRAGGED: 'lamp:dragged',
  /** 退出应用。 */
  APP_QUIT: 'app:quit',
  /** 通知按钮点击（Windows 通知按钮事件在主进程，此通道供渲染层复用作统一入口）。 */
  NOTIFY_ACTION: 'notify:action',
  /** 托盘菜单「重新探测终端」。 */
  REPROBE_TERMINAL: 'app:reprobeTerminal',
  /** P1-2 配置热重载后主动拉最新快照（渲染层订阅保持简单）。 */
  CONFIG_RELOADED: 'app:configReloaded',
  /** 托盘气泡/窗口级事件（渲染层可据此显示轻提示）。 */
  APP_TOAST: 'app:toast',
} as const);

/** 主进程向渲染层推送的通道（M→R）。 */
export const IPC_PUSH = Object.freeze({
  /** 状态变更推送 —— 唯一的状态下发通道（架构 D8 单一数据源）。 */
  SNAPSHOT: 'app:snapshot',
  /** 音效播放指令，由主进程决定响哪一声。 */
  PLAY_SOUND: 'notify:play',
} as const);

/** 重新导出，便于只 import ipc-contract 的调用方。 */
export type {
  ConfigReloadOutcome,
  FocusResult,
  NotifyActionId,
  PlaySoundRequest,
  ProbeTerminalResponse,
  Snapshot,
  TaskActionRequest,
  TaskActionResponse,
} from './types';

export type IpcInvokeChannel = (typeof IPC)[keyof typeof IPC];
export type IpcPushChannel = (typeof IPC_PUSH)[keyof typeof IPC_PUSH];

/** 每个 invoke 通道的「载荷 -> 响应」映射，供 ipc.ts 与 preload 共用类型。 */
export interface InvokeMap {
  [IPC.GET_SNAPSHOT]: { request: void; response: Snapshot };
  [IPC.TASK_ACTION]: { request: TaskActionRequest; response: TaskActionResponse };
  [IPC.LAMP_TOGGLE_PANEL]: { request: void; response: { expanded: boolean } };
  [IPC.LAMP_DRAGGED]: { request: { x: number; y: number }; response: { ok: boolean } };
  [IPC.APP_QUIT]: { request: void; response: void };
  [IPC.NOTIFY_ACTION]: {
    request: { taskId: string; action: NotifyActionId };
    response: FocusResult;
  };
  [IPC.REPROBE_TERMINAL]: { request: void; response: ProbeTerminalResponse };
  [IPC.CONFIG_RELOADED]: { request: ConfigReloadOutcome; response: void };
  [IPC.APP_TOAST]: { request: { message: string }; response: void };
}

/** 每个 push 通道的载荷类型。 */
export interface PushMap {
  [IPC_PUSH.SNAPSHOT]: Snapshot;
  [IPC_PUSH.PLAY_SOUND]: PlaySoundRequest;
}

/** 暴露给渲染层的全局 API 形状（preload contextBridge 白名单的契约）。 */
export interface RendererApi {
  getSnapshot(): Promise<Snapshot>;
  sendTaskAction(req: TaskActionRequest): Promise<TaskActionResponse>;
  togglePanel(): Promise<{ expanded: boolean }>;
  notifyLampDragged(pos: { x: number; y: number }): Promise<{ ok: boolean }>;
  quit(): Promise<void>;
  sendNotifyAction(req: {
    taskId: string;
    action: NotifyActionId;
  }): Promise<FocusResult>;
  reprobeTerminal(): Promise<ProbeTerminalResponse>;
  /** M→R 订阅：返回取消订阅函数。 */
  onSnapshot(cb: (snapshot: Snapshot) => void): () => void;
  onPlaySound(cb: (req: PlaySoundRequest) => void): () => void;
  onToast(cb: (req: { message: string }) => void): () => void;
  /** 当前窗口角色（overlay / panel），由 preload 读取 HTML 上的 data 属性注入。 */
  readonly role: 'overlay' | 'panel';
}

/** 挂到 window 上的全局变量名（渲染层唯一访问入口）。 */
export const IPC_GLOBAL_KEY = 'aiIndicator';
