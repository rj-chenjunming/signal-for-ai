/**
 * 浮窗「哪些行应该显示」的判定 —— **主进程与渲染层共用同一份规则**。
 *
 * ============================================================================
 * 【产品原则】浮窗里出现的东西，默认就该是活着的。
 * ============================================================================
 * 用户的原话：「如果没活着就没必要显示在浮窗里面了，既然能存在浮窗里面，
 * 那么就应该是活着的」。
 *
 * 这条原则的价值在于**可依赖**：看到一行，就知道它是活着的，
 * 不需要再去分辨"灰灯是空闲还是掉线"。这比让用户学习七态语义强得多。
 *
 * ============================================================================
 * 【为什么必须放在共享模块里】
 * ============================================================================
 * 这个判定同时被两处用到，**必须完全一致**：
 *   1. 主进程 `TaskStore`：数「可显示行数」来决定窗口尺寸（≥2 才用灯带形态）
 *   2. 渲染层 `overlay.js`：决定实际渲染哪几行
 *
 * 一旦两边口径不同，就会出现「窗口按灯带尺寸开、内容却只有一个灯的错位」
 * —— 这个 bug 本项目已经踩过一次（stripMode 与 resolveCanvasSize 数了不同的东西）。
 *
 * @module shared/visibility
 */

import type { TaskStatus } from './types';

/**
 * 这些状态**不代表"活着"**，因此对应的行不在浮窗里显示。
 *
 * - `unknown`：失联 —— 拿不到它的状态（dsh 连不上、webhook 心跳超时、
 *   进程枚举子进程反复失败）
 * - `failed`：已判定失败 —— 进程崩了、轮询报错
 *
 * 其余五态都显示：
 * - `idle`      可能存在但当前没在干活（灰色）
 * - `starting`  刚发现
 * - `running`   在干活（蓝色）
 * - `waiting`   卡住等人（黄色）★ 最值钱
 * - `success`   刚完成（绿色）
 *
 * 【为什么 idle 要显示（而不是也隐藏）】
 * 用户明确选择了"只隐藏失联和失败"：dsh 端口连接正常但暂时没有活跃会话时，
 * 仍然应该看到"这个端口在、只是空闲"。若把 idle 也隐藏，
 * 空闲的 dsh 端口会整行消失，反而看不出它在被监控。
 */
export const HIDDEN_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'unknown',
  'failed',
]);

/** 该状态对应的行是否应该在浮窗里显示。 */
export function isVisibleStatus(status: TaskStatus): boolean {
  return !HIDDEN_STATUSES.has(status);
}

/** 可显示判定所需的最小任务形状（放宽入参，便于纯函数测试）。 */
export interface VisibilityInput {
  readonly processPresent?: boolean;
  /**
   * 运行时状态。
   *
   * **可选**：配置侧（`TaskConfig`）没有 status —— 任务还没跑起来时
   * 我们只知道它"启用了、未暂停"，等价于"可见"（相当于 idle）。
   * 这样同一个 `countVisibleTasks` 既能数运行时快照、也能估算初始窗口尺寸。
   */
  readonly status?: TaskStatus;
  /** 任务级手动暂停（运行时 TaskState 上的字段）。 */
  readonly paused?: boolean;
  /**
   * 配置里的启用开关（TaskConfig 上的字段）。
   *
   * 两个来源形状不同，这里都接受：
   *   - 运行时 `TaskState` 有 `paused`、**没有** `enabled`
   *   - 配置 `TaskConfig` 有 `enabled`、**没有** `paused`
   * 语义等价（都是"这个任务现在算不算数"），所以合并成一个判定函数，
   * 免得两处各写一份 filter 日后口径漂移。
   */
  readonly enabled?: boolean;
}

/**
 * 该任务是否应该在浮窗里显示。
 *
 * 三道过滤：
 *   1. 配置里 `enabled: false` —— 没启用，不显示
 *   2. 任务级 `paused` —— 用户手动暂停，不显示
 *   3. 状态属于 HIDDEN_STATUSES —— 失联/失败的行不显示
 *
 * `status` 缺失时按"可见"处理（配置侧估算用）。
 */
export function isTaskVisible(task: VisibilityInput): boolean {
  if (task.enabled === false || task.paused === true || task.processPresent === false) {
    return false;
  }
  return task.status === undefined || isVisibleStatus(task.status);
}

/** 数出可显示的任务数（主进程用它决定窗口尺寸）。 */
export function countVisibleTasks(tasks: readonly VisibilityInput[]): number {
  let n = 0;
  for (const t of tasks) {
    if (isTaskVisible(t)) n += 1;
  }
  return n;
}
