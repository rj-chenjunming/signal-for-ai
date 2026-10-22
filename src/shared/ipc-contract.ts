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
  GoalEntryKind,
  GoalExportResult,
  GoalsView,
  LampLayout,
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
  /**
   * 拉取当前浮窗布局（停靠方向）。
   *
   * 【为什么既要订阅又要主动拉】停靠形态是**低频**变化，若只在主进程推送，
   * 渲染层"挂载中（await getSnapshot 未返回）"时那一次推送就会丢，
   * 灯会一直停在错的形态上。启动时先拉一次，之后靠订阅跟进。
   */
  GET_LAYOUT: 'app:getLayout',
  SET_MONITORING_PAUSED: 'app:setMonitoringPaused',
  SHOW_PANEL_MESSAGE: 'panel:showMessage',
  TAKE_PANEL_MESSAGE: 'panel:takeMessage',

  /* ---- SPEC-024：目标清单 ---- */
  /** 目标窗口挂载 / 重载时拉取当前视图。 */
  GOALS_GET: 'goals:get',
  GOALS_ADD: 'goals:add',
  GOALS_DELETE: 'goals:delete',
  GOALS_UPDATE_TITLE: 'goals:updateTitle',
  GOALS_SET_PROGRESS: 'goals:setProgress',
  GOALS_COMPLETE: 'goals:complete',
  GOALS_ADD_ENTRY: 'goals:addEntry',
  GOALS_DELETE_ENTRY: 'goals:deleteEntry',
  /** 同组内拖拽排序（SPEC-026）。 */
  GOALS_MOVE: 'goals:move',
  /** 一键导出全部目标与记录（主进程弹保存对话框）。 */
  GOALS_EXPORT: 'goals:export',
  /** 隐藏目标窗口（Esc / ✕）。 */
  GOALS_HIDE: 'goals:hide',
  /** 从任务面板 / 托盘打开目标窗口。 */
  OPEN_GOALS: 'window:openGoals',
} as const);

/** 主进程向渲染层推送的通道（M→R）。 */
export const IPC_PUSH = Object.freeze({
  /** 状态变更推送 —— 唯一的状态下发通道（架构 D8 单一数据源）。 */
  SNAPSHOT: 'app:snapshot',
  /** 音效播放指令，由主进程决定响哪一声。 */
  PLAY_SOUND: 'notify:play',
  /** 浮窗布局（停靠方向）变更 —— 与状态无关，故独立于 SNAPSHOT。 */
  LAYOUT: 'app:layout',
  /** 目标数据变更推送（SPEC-024）；目标窗口据此重绘。 */
  GOALS_CHANGED: 'goals:changed',
} as const);

/** 重新导出，便于只 import ipc-contract 的调用方。 */
export type {
  ConfigReloadOutcome,
  FocusResult,
  GoalEntryKind,
  GoalExportResult,
  GoalsView,
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
  [IPC.SHOW_PANEL_MESSAGE]: { request: string; response: TaskActionResponse };
  [IPC.TAKE_PANEL_MESSAGE]: { request: void; response: { message?: string } };
  [IPC.SET_MONITORING_PAUSED]: { request: boolean; response: TaskActionResponse };
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
  [IPC.GET_LAYOUT]: { request: void; response: LampLayout };

  /* ---- SPEC-024 ---- */
  [IPC.GOALS_GET]: { request: void; response: GoalsView };
  [IPC.GOALS_ADD]: { request: { title: string }; response: TaskActionResponse };
  [IPC.GOALS_DELETE]: { request: { id: string }; response: TaskActionResponse };
  [IPC.GOALS_UPDATE_TITLE]: {
    request: { id: string; title: string };
    response: TaskActionResponse;
  };
  [IPC.GOALS_SET_PROGRESS]: {
    request: { id: string; progress: number };
    response: TaskActionResponse;
  };
  [IPC.GOALS_COMPLETE]: { request: { id: string }; response: TaskActionResponse };
  [IPC.GOALS_ADD_ENTRY]: {
    request: { goalId: string; kind: GoalEntryKind; text: string };
    response: TaskActionResponse;
  };
  [IPC.GOALS_DELETE_ENTRY]: {
    request: { goalId: string; entryId: string };
    response: TaskActionResponse;
  };
  [IPC.GOALS_MOVE]: {
    request: { id: string; beforeId: string | null };
    response: TaskActionResponse;
  };
  [IPC.GOALS_EXPORT]: { request: void; response: GoalExportResult };
  [IPC.GOALS_HIDE]: { request: void; response: void };
  [IPC.OPEN_GOALS]: { request: void; response: TaskActionResponse };
}

/** 每个 push 通道的载荷类型。 */
export interface PushMap {
  [IPC_PUSH.SNAPSHOT]: Snapshot;
  [IPC_PUSH.PLAY_SOUND]: PlaySoundRequest;
  [IPC_PUSH.LAYOUT]: LampLayout;
  [IPC_PUSH.GOALS_CHANGED]: GoalsView;
}

/** 暴露给渲染层的全局 API 形状（preload contextBridge 白名单的契约）。 */
export interface RendererApi {
  showPanelMessage(message: string): Promise<TaskActionResponse>;
  takePanelMessage(): Promise<{ message?: string }>;
  setMonitoringPaused(paused: boolean): Promise<TaskActionResponse>;
  getSnapshot(): Promise<Snapshot>;
  /** 拉取当前浮窗布局（停靠方向）；与 onLayout 配套使用。 */
  getLayout(): Promise<LampLayout>;
  sendTaskAction(req: TaskActionRequest): Promise<TaskActionResponse>;
  togglePanel(): Promise<{ expanded: boolean }>;
  notifyLampDragged(pos: { x: number; y: number }): Promise<{ ok: boolean }>;
  quit(): Promise<void>;
  sendNotifyAction(req: {
    taskId: string;
    action: NotifyActionId;
  }): Promise<FocusResult>;
  reprobeTerminal(): Promise<ProbeTerminalResponse>;

  /* ---- SPEC-024：目标清单 ---- */
  getGoals(): Promise<GoalsView>;
  addGoal(title: string): Promise<TaskActionResponse>;
  deleteGoal(id: string): Promise<TaskActionResponse>;
  updateGoalTitle(id: string, title: string): Promise<TaskActionResponse>;
  setGoalProgress(id: string, progress: number): Promise<TaskActionResponse>;
  completeGoal(id: string): Promise<TaskActionResponse>;
  addGoalEntry(
    goalId: string,
    kind: GoalEntryKind,
    text: string,
  ): Promise<TaskActionResponse>;
  deleteGoalEntry(goalId: string, entryId: string): Promise<TaskActionResponse>;
  /** 同组内拖拽排序；beforeId 为 null 表示移到组末。 */
  moveGoal(id: string, beforeId: string | null): Promise<TaskActionResponse>;
  exportGoals(): Promise<GoalExportResult>;
  hideGoals(): Promise<void>;
  openGoals(): Promise<TaskActionResponse>;

  /** M→R 订阅：返回取消订阅函数。 */
  onSnapshot(cb: (snapshot: Snapshot) => void): () => void;
  onPlaySound(cb: (req: PlaySoundRequest) => void): () => void;
  onToast(cb: (req: { message: string }) => void): () => void;
  /** 浮窗布局（停靠方向）订阅。 */
  onLayout(cb: (layout: LampLayout) => void): () => void;
  /** 目标数据变更订阅（SPEC-024）。 */
  onGoals(cb: (view: GoalsView) => void): () => void;
  /** 当前窗口角色（overlay / panel / goals），由 preload 读取 HTML 上的 data 属性注入。 */
  readonly role: 'overlay' | 'panel' | 'goals';
}

/** 挂到 window 上的全局变量名（渲染层唯一访问入口）。 */
export const IPC_GLOBAL_KEY = 'aiIndicator';
