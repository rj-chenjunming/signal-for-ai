/**
 * 状态仓库 —— 主进程唯一数据源（架构 D8）。
 *
 * 依赖: 仅 Node 内置 `events` + shared/*，**不依赖任何 Electron API**，
 *       因此可在 vitest 中直接验证状态机（PRD P0-7/P1-5 的核心保证）。
 *
 * 设计要点：
 *  1. `apply()` 是**唯一的状态写入口**，任何非法转移一律拒绝 + 记日志，**不抛异常**（架构 §8.4）。
 *  2. `tick()` 负责所有**超时驱动**的转移（stale / start / waiting / dismiss），
 *     与事件驱动的 `apply()` 分离，保证「信号」与「时间」两类触发互不干扰。
 *  3. `getSnapshot()` 返回的聚合结果带缓存，version 单调自增，渲染层据此去重。
 */

import { EventEmitter } from 'node:events';

import {
  DEFAULT_NOTIFY_SETTINGS,
  DEFAULT_STATE_TIMEOUT,
  computeAggregate,
  sortByStatus,
  statusRank,
} from '../shared/constants';
// 浮窗「显示哪些行」的共享口径 —— 必须与渲染层用同一份，否则窗口尺寸会错位
import { countVisibleTasks, isTaskVisible, shouldShowStrip } from '../shared/visibility';
import type {
  AppConfig,
  GoalsSummary,
  Snapshot,
  StateChange,
  StateTimeoutDefaults,
  TaskConfig,
  TaskPatch,
  TaskState,
  TaskStatus,
} from '../shared/types';

/**
 * dsh 桌面端与 dsh Web 共用 `monitor.type: 'dsh'`，只能从配置里「点击后切到浏览器 URL」的能力区分。
 * 这些字段只在 Web 场景有意义，因此不需要新增配置或按运行消息猜测；没有它们的 dsh 仍是桌面鲸鱼。
 */
function isDshWebTarget(cfg: TaskConfig): boolean {
  const jump = cfg.jump;
  return Boolean(jump?.openUrl || jump?.openUrlTitleMatch || jump?.openUrlDebugPort || jump?.openUrlViaExtension);
}

/** UI capability metadata derives from configured routes, never from monitor messages. */
function presentationFor(cfg: TaskConfig): Pick<TaskState, 'toolKind' | 'availableActions'> {
  const kind = cfg.monitor.type;
  const toolKind = kind === 'codex' ? 'codex'
    : kind === 'dsh' ? (isDshWebTarget(cfg) ? 'dsh-web' : 'dsh')
      : /workbuddy/i.test(`${cfg.id} ${cfg.name}`) ? 'workbuddy' : 'generic';
  const availableActions: NonNullable<TaskState['availableActions']> = ['focus_terminal'];
  if (cfg.jump?.logFile) availableActions.push('open_log');
  if (cfg.jump?.cwd) availableActions.push('open_dir');
  availableActions.push('retry', 'mark_read');
  return { toolKind, availableActions };
}

/* ============================================================================
 * 状态机转移表（PRD §5.3 转移图 + §5.4 关键转移规则）
 * ==========================================================================*/

/**
 * 合法转移表。键为当前态，值为允许的目标态集合。
 *
 * PRD §5.4 逐条映射：
 *  - idle --首个子信号--> starting
 *  - starting --日志/心跳/进程存活--> running
 *  - starting --start_timeout 无新信号--> idle
 *  - starting/running/waiting --stale_timeout--> unknown
 *  - running --完成规则 / 进程正常退出--> success
 *  - running --授权提示规则--> waiting
 *  - waiting --授权完成 / 继续输出--> running
 *  - waiting --同一轮日志内直接完成（无 running 中间态）--> success
 *  - waiting --waiting_timeout 防悬挂--> failed
 *  - unknown --恢复信号--> running
 *  - **idle --推送到来的授权信号--> waiting**（见下方 idle 的说明）
 *  - failed --用户重试 / 新一轮同名任务--> starting
 *  - success/failed --用户已读 或 dismiss_after--> idle
 *  - **任意态 --命中错误规则 / 进程异常退出码--> failed**（PRD §5.3 图底边）
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> =
  Object.freeze({
    /**
     * idle -> waiting 是**推送型监控**的必经之路，不是放宽。
     *
     * 理由：dsh 型/插件型任务在收到信号前一直是 idle。当插件推来
     * "会话正在等授权"时，任务的**前一个状态就是 idle** —— 中间不会有
     * starting/running（那是轮询/日志型的路径）。
     *
     * 【这个缺口实际造成的后果 —— 实测抓到】
     * 它**不是**观感问题，而是直接**打掉了本产品最值钱的功能**：
     * D2 全链路里精确信号一路都对（仲裁器记到了、per-session 判成
     * waiting），最后 `apply` 却因 idle->waiting 非法**返回 null**，
     * 灯停在灰色 —— 用户永远看不到"卡住等你授权"。
     * 之前没暴露只是因为碰巧有会话在 running，走的 running->waiting。
     *
     * 不变量检查（PRD §4.2）：本边不引入 failed->success，
     * 也不引入 unknown->success，故不违反既有约束。
     *
     * ⚠️ 注意**没有**顺带放开 unknown -> waiting：那是另一回事
     * （失联 ≠ 空闲），详见下方 unknown 的说明。
     */
    /**
     * ★ idle -> success 也是同一类缺口（与上面的 idle -> waiting 同源）。
     *
     * 理由：sqlite 型这类**轮询任务态**的监控在两次任务之间一直报 idle。
     * 当它发现"刚刚有任务完成"时，任务的**前一个状态就是 idle** ——
     * 中间不会有 running（任务可能在两次轮询之间就跑完了，5s 间隔下完全可能）。
     * 若这条边被拒，`apply` 返回 null，**完成提醒的绿灯根本不会亮**，
     * 用户看到的是"任务做完后灯直接还是灰的" —— 正是本产品要消灭的
     * 「灯不反映真实状态」。
     *
     * 不变量检查（PRD §4.2）：本边不引入 failed->success，
     * 也不引入 unknown->success，故不违反既有约束。
     *
     * ⚠️ 注意**没有**顺带放开 unknown -> success：失联 ≠ 空闲。
     */
    idle: ['starting', 'running', 'waiting', 'success', 'failed', 'unknown'],
    starting: ['running', 'failed', 'unknown', 'idle'],
    running: ['waiting', 'success', 'failed', 'unknown', 'idle'],
    /**
     * waiting -> success 是 PRD §5.4 两跳路径（waiting -> running -> success）
     * 的**必要补充**，不是放宽。
     *
     * 理由：log 型监控器的契约是「每轮只上报一次当前批次判定出的状态」
     * （logfile.ts 拿到 judgeStatusBatch 的单个结果就 apply）。当一轮日志里
     * 同时含授权提示与完成信号（例如用户选了"全部允许"后一口气跑完），
     * batch 按「最后一条命中」只会上报 success 这一个状态 —— 中间不会有
     * running。若转移表拒绝 waiting -> success，apply 返回 null，
     * **灯就会永久停在黄色**，用户以为还在等授权，而任务其实早已跑完。
     * 这正是本产品要消灭的「灯不反映真实状态」，且比误报红更隐蔽。
     *
     * 这条边不影响 waiting -> running 的常规路径（授权通过后继续输出，
     * 仍走 running），只是补上「无需交互直接完成」这一跳。
     */
    waiting: ['running', 'success', 'failed', 'unknown', 'idle'],
    // 轮询/推送可直接观察到下一轮运行或等待，不保证中间有 starting。
    success: ['idle', 'starting', 'running', 'waiting', 'failed', 'unknown'],
    /**
     * failed 允许重新回到 running / starting / waiting。
     *
     * 【为什么放宽 —— 实测踩过的坑】
     * 原本只有 ['idle','starting']，看起来能防「红灯被洗绿」，但实测发现
     * **任务失败后重试**这个最常见的场景被卡死了：
     *   running -> failed -> running   ← 被拒绝，灯卡在红色
     * 于是用户重试任务后（仿真重新跑一遍、CI 重跑），日志立刻又输出
     * running，但灯还是红的，得等 10 分钟 dismiss 清理或手动点已读才恢复。
     * 这类「灯不反映真实状态」比误报红更误导人。
     *
     * 【为什么不违反「红灯不被洗绿」】
     * 那条约束的本意是：**不要在没有新信号时凭空变绿**。
     * 而 failed -> running 由**真实的 running 信号**驱动（apply 带 isSignal），
     * 不是自动回落。所以：
     *   - 误洗绿（failed 自己变成 success）：仍禁止 ✓
     *   - 任务真重试（新的 running 信号）：允许 ✓
     * failed -> success 依然禁止，防止「失败了却显示完成」。
     */
    failed: ['idle', 'starting', 'running', 'waiting'],
    /**
     * ⚠️ unknown **刻意不含** waiting / success。
     *
     * 与上面 idle -> waiting 不同：idle 是"没在干活"（安全，可以直接转 waiting），
     * 而 unknown 是"**看不见它**了"——失联期间实例可能早就崩了。
     * 若允许 unknown -> waiting/success，就会出现"明明挂了却显示在等你"
     * 或"明明挂了却显示完成"，那比停在灰色更危险（漏报失败）。
     *
     * 所以失联实例必须**先被观察到真实运行信号**（-> running）才可能进入
     * waiting/success。这条约束有既有测试守着（store.test.ts / store-extra.test.ts），
     * 我一度为图省事放开过，测试正确地把它挡了回来 —— 保留原设计。
     */
    unknown: ['starting', 'running', 'failed', 'idle'],
  });

/** 判定 `from -> to` 是否为合法转移。 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) {
    return true; // 同态刷新（仅更新 message 等附加信息）恒允许
  }
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/* ============================================================================
 * TaskStore
 * ==========================================================================*/

/** 最小日志接口，避免 store 反向依赖 logger/electron（便于单测注入断言）。 */
export interface StoreLogger {
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface TaskStoreOptions {
  /** 可注入时钟，便于单测确定性地推进时间。默认 `Date.now`。 */
  now?: () => number;
  logger?: StoreLogger;
  timeouts?: Partial<StateTimeoutDefaults>;
  notify?: { popup: boolean; sound: boolean };
  paused?: boolean;
  /** 悬浮灯初始是否鼠标穿透（来自 lamp.clickThrough）。 */
  clickThrough?: boolean;
}

type ChangeListener = (snapshot: Snapshot, changes: StateChange[]) => void;

export class TaskStore {
  private readonly tasks = new Map<string, TaskState>();
  private readonly order: string[] = [];
  private readonly emitter = new EventEmitter();
  private readonly now: () => number;
  private readonly logger: StoreLogger;
  private readonly timeouts: StateTimeoutDefaults;

  private paused = false;
  private notifyPrefs = { popup: true, sound: true };
  /** 悬浮灯是否鼠标穿透（D10「锁定/穿透」，托盘菜单可切）。 */
  private clickThrough = false;
  /** 目标摘要（SPEC-025）：只用于浮窗「目标」行，不参与七态状态机。 */
  private goalsSummary: GoalsSummary | undefined;
  private version = 0;
  private snapshotCache: Snapshot | null = null;

  /**
   * statusSince：进入当前状态的时刻。
   * 与 startedAt 区分开，因为 waiting_timeout / dismiss_after 都是「从进入该态起算」，
   * 而 durationMs 是「本轮任务从开始到结束」。
   */
  private statusSince = new Map<string, number>();

  constructor(taskConfigs: readonly TaskConfig[], options: TaskStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? {
      warn: () => undefined,
      error: () => undefined,
    };
    this.timeouts = { ...DEFAULT_STATE_TIMEOUT, ...options.timeouts };
    this.paused = options.paused ?? false;
    this.notifyPrefs = options.notify ?? { popup: true, sound: true };
    this.clickThrough = options.clickThrough ?? false;

    for (const cfg of taskConfigs) {
      this.tasks.set(cfg.id, this.createInitialState(cfg));
      this.order.push(cfg.id);
    }
    // 初始快照要先建好，否则监听者注册后第一次 getSnapshot 会拿到 null 缓存。
    this.getSnapshot();
  }

  /** 用 AppConfig 便捷构造（main/index.ts 的用法）。 */
  static fromAppConfig(config: AppConfig, options: TaskStoreOptions = {}): TaskStore {
    return new TaskStore(config.tasks, {
      now: options.now,
      logger: options.logger,
      timeouts: { ...config.defaults.stateTimeout, ...options.timeouts },
      notify: { popup: config.notify.popup, sound: config.notify.sound },
      paused: options.paused,
      clickThrough: options.clickThrough ?? config.lamp.clickThrough,
    });
  }

  private createInitialState(cfg: TaskConfig): TaskState {
    const at = this.now();
    this.statusSince.set(cfg.id, at);
    return {
      taskId: cfg.id,
      name: cfg.name,
      status: 'idle',
      cwd: cfg.jump?.cwd,
      lastSignalAt: at,
      unread: false,
      // enabled 与 paused 分开存：前者来自配置，后者是运行时开关。
      // 不要再用 paused 兼任 enabled 了（那会让"只改 enabled"同步不到）。
      enabled: cfg.enabled,
      portLabel: derivePortLabel(cfg),
      ...presentationFor(cfg),
    };
  }

  /* ---------------------------------------------------------------- 读接口 */

  getSnapshot(): Snapshot {
    if (this.snapshotCache) {
      return this.snapshotCache;
    }
    const all = this.order
      .map((id) => this.tasks.get(id))
      .filter((t): t is TaskState => t !== undefined);

    const counts = this.emptyCounts();
    let runningCount = 0;
    for (const task of all) {
      if (task.processPresent === false) continue;
      counts[task.status] += 1;
      if ((task.status === 'running' || task.status === 'starting') && !task.paused) {
        runningCount += 1;
      }
    }

    // 聚合只看"算数"的任务：配置禁用的、以及手动暂停的都不该把灯拉成异常色。
    //
    // 注意**仍然包含** unknown/failed —— 那些行虽然不显示在浮窗里，
    // 但"有东西失联/失败"这个事实必须反映在总灯颜色上
    // （否则隐藏就变成了掩盖问题，比不显示更危险）。
    const active = all
      .filter((t) => t.paused !== true && t.enabled !== false && t.processPresent !== false)
      .map((t) => t.status);

    // 可显示行数：决定单灯还是灯带（口径见 shared/visibility.ts）
    const visibleCount = countVisibleTasks(all);
    // SPEC-025：有进行中目标时，浮窗多一行「目标」，即使任务不足 2 行也要灯带。
    const goalRowCount = this.goalsSummary && this.goalsSummary.active > 0 ? 1 : 0;

    const snapshot: Snapshot = {
      aggregate: computeAggregate(active),
      runningCount,
      counts,
      tasks: sortByStatus(all),
      paused: this.paused,
      notify: { ...this.notifyPrefs },
      version: this.version,
      // 可显示行数 + 目标行：决定单灯还是灯带（见 shared/visibility.ts）
      stripMode: shouldShowStrip(visibleCount, goalRowCount),
      /** SPEC-025：浮窗「目标」行的聚合数据；undefined/active=0 时不显示目标行。 */
      goalsSummary: this.goalsSummary,
      /** 因失联/失败而被隐藏的行数（面板与 tooltip 用来说明"有几个不在"）。 */
      hiddenCount: all.filter((t) => isTaskVisible(t) === false && t.enabled !== false && t.paused !== true && t.processPresent !== false).length,
      /**
       * 实际要渲染的行 —— 主进程算好，渲染层照着画。
       * 渲染层是 classic script 无法 import 规则，所以过滤只能在主进程做。
       */
      displayTasks: all.filter((t) => isTaskVisible(t)),
      clickThrough: this.clickThrough,
    };
    this.snapshotCache = snapshot;
    return snapshot;
  }

  private emptyCounts(): Record<TaskStatus, number> {
    return {
      idle: 0,
      starting: 0,
      running: 0,
      waiting: 0,
      success: 0,
      failed: 0,
      unknown: 0,
    };
  }

  getTask(taskId: string): TaskState | undefined {
    const task = this.tasks.get(taskId);
    return task ? { ...task } : undefined;
  }

  getAllTasks(): TaskState[] {
    return this.getSnapshot().tasks;
  }

  /** 面板/通知需要按 id 找回完整的 jump 配置时使用。 */
  hasTask(taskId: string): boolean {
    return this.tasks.has(taskId);
  }

  get pausedGlobally(): boolean {
    return this.paused;
  }

  get timeoutsConfig(): Readonly<StateTimeoutDefaults> {
    return this.timeouts;
  }

  onChange(listener: ChangeListener): () => void {
    this.emitter.on('change', listener);
    return () => this.emitter.off('change', listener);
  }

  /* ---------------------------------------------------------------- 写接口 */

  /**
   * 唯一的任务状态写入口。
   *
   * @param taskId 目标任务
   * @param patch  要应用的补丁
   * @param opts.isSystemEvent true 表示由超时/用户操作驱动（非监控信号），
   *        用于决定是否刷新 lastSignalAt（系统事件不应「续命」）。
   * @returns 状态变化记录；被拒绝或任务不存在时返回 null。
   */
  apply(taskId: string, patch: TaskPatch, opts: { isSystemEvent?: boolean } = {}): StateChange | null {
    const task = this.tasks.get(taskId);
    if (!task) {
      this.logger.warn(`[store] 未知任务: ${taskId}`);
      return null;
    }
    const at = this.now();
    const from = task.status;
    const to = patch.processPresent === false ? 'idle' : patch.status ?? from;

    // ★ 完成提醒的**确认闸门**。
    //
    // 背景：用户要的形态是「执行完亮绿灯保持不动，点击后跳转并熄灭」。
    // 但 sqlite 型是**轮询**的 —— 点掉之后下一轮（默认 5s）又会从数据库
    // 读到"有会话完成了"，于是绿灯**立刻复亮**，点击等于没点。
    //
    // 解法：把"完成"建模成**单调水位**。用户点掉时记下当时的完成时刻
    // （task.ackedCompletionAt）；监控之后每轮上报都带 completionAt，
    // 只要它 **不大于** 已确认水位，就说明这个完成事件用户已经点过了 ——
    // 直接丢弃。
    //
    // 注意：这里**不记 warn 日志**。重复上报同一个完成是**正常现象**，
    // 不是非法转移；记日志会把日志刷满噪声。
    if (
      to === 'success' &&
      patch.completionAt !== undefined &&
      patch.completionAt <= (task.ackedCompletionAt ?? 0)
    ) {
      return null;
    }

    if (!canTransition(from, to)) {
      // PRD §5.4：failed 不自动回落；非法转移一律拒绝且不抛异常（架构 §8.4）。
      this.logger.warn(
        `[store] 非法状态转移被拒绝: ${taskId} ${from} -> ${to}`,
      );
      return null;
    }

    // 相同状态也是有效观测。先续心跳，再对广播去重，否则持续轮询反而会失联。
    if (patch.isSignal !== false && !opts.isSystemEvent) {
      task.lastSignalAt = at;
    }

    const changed = to !== from;
    if (!changed && !this.hasMetaChange(task, patch)) {
      return null; // 完全无变化，不触发广播
    }

    if (changed) {
      this.statusSince.set(taskId, at);
      task.status = to;
      task.unread = to === 'success' || to === 'failed' ? true : task.unread;
      if (to === 'success' || to === 'failed') {
        task.endedAt = at;
        task.durationMs = task.startedAt ? at - task.startedAt : undefined;
        if (to === 'failed' && !task.error && patch.error) {
          task.error = patch.error;
        }
      }
      if (to === 'running' && patch.startedAt !== undefined) {
        task.startedAt = patch.startedAt;
      }
    }

    // 完成水位独立于状态变化；连续两次完成也必须能确认最新一轮。
    if (to === 'success' && patch.completionAt !== undefined) {
      task.lastCompletionAt = Math.max(task.lastCompletionAt ?? 0, patch.completionAt);
    }

    this.applyMeta(task, patch);
    if (patch.processPresent === false) {
      task.unread = false;
      task.error = undefined;
      task.progress = undefined;
      task.startedAt = undefined;
      task.endedAt = undefined;
      task.durationMs = undefined;
      task.ackedCompletionAt = Math.max(task.ackedCompletionAt ?? 0, task.lastCompletionAt ?? 0, at);
    }

    const change: StateChange = { taskId, from, to, at, mutated: true };
    this.commit([change]);
    return change;
  }

  private hasMetaChange(task: TaskState, patch: TaskPatch): boolean {
    if (patch.processPresent !== undefined && patch.processPresent !== task.processPresent) return true;
    if (patch.completionAt !== undefined && patch.completionAt > (task.lastCompletionAt ?? 0)) return true;
    if (patch.message !== undefined && patch.message !== task.message) return true;
    if (patch.progress !== undefined && patch.progress !== task.progress) return true;
    if (patch.error !== undefined && patch.error !== task.error) return true;
    return false;
  }

  private applyMeta(task: TaskState, patch: TaskPatch): void {
    if (patch.processPresent !== undefined) task.processPresent = patch.processPresent;
    if (patch.message !== undefined) {
      task.message = patch.message;
    }
    if (patch.progress !== undefined) {
      task.progress = patch.progress;
    }
    if (patch.error !== undefined) {
      task.error = patch.error;
    }
    if (patch.startedAt !== undefined && task.startedAt === undefined) {
      task.startedAt = patch.startedAt;
    }
  }

  /** 收到心跳：只刷新 lastSignalAt，不改状态（PRD §5.3「收到心跳」是转入 running 的前提之一，由调用方决定目标态）。 */
  heartbeat(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }
    task.lastSignalAt = this.now();
  }

  /**
   * 超时巡检。由 main/index.ts 的定时器周期调用（默认 pollIntervalMs）。
   * 处理 PRD §5.4 的全部时间相关规则。
   */
  tick(): StateChange[] {
    const at = this.now();
    const changes: StateChange[] = [];

    for (const id of this.order) {
      const task = this.tasks.get(id);
      if (!task || task.paused || task.processPresent === false) {
        continue;
      }
      const since = this.statusSince.get(id) ?? task.lastSignalAt;

      switch (task.status) {
        case 'starting': {
          // start_timeout：无新信号自动回 idle（PRD §5.4）
          if (at - task.lastSignalAt >= this.timeouts.startTimeoutMs) {
            const ch = this.apply(id, { status: 'idle' }, { isSystemEvent: true });
            if (ch) changes.push(ch);
          }
          break;
        }
        case 'running':
        case 'waiting': {
          // stale_timeout：信号源失联 -> unknown（PRD US8 关键：防止灯一直是绿的）
          if (at - task.lastSignalAt >= this.timeouts.staleTimeoutMs) {
            const ch = this.apply(
              id,
              { status: 'unknown', message: '信号超时，监控源可能已失联' },
              { isSystemEvent: true },
            );
            if (ch) changes.push(ch);
            break;
          }
          // waiting_timeout：等待授权悬挂过久 -> failed（PRD §5.4 防悬挂）
          if (task.status === 'waiting' && at - since >= this.timeouts.waitingTimeoutMs) {
            const ch = this.apply(
              id,
              { status: 'failed', error: '等待授权超时（可能已悬挂）' },
              { isSystemEvent: true },
            );
            if (ch) changes.push(ch);
          }
          break;
        }
        case 'success':
        case 'failed': {
          // dismiss_after：已完成任务自动清理，避免列表堆积（PRD §5.4）
          if (at - since >= this.timeouts.dismissAfterMs) {
            // SPEC-007：自动熄灭 = "已经展示过这次完成"，必须同时把完成水位
            // 记进已确认。否则轮询型监控（sqlite/dsh）下一轮还会读到同一个
            // 完成（lastDoneAt > acked=0），绿灯每 10 分钟自己亮一次 ——
            // 用户现场：「WorkBuddy 没在跑东西，隔一段时间就自己亮绿灯」。
            if (task.lastCompletionAt !== undefined) {
              task.ackedCompletionAt = Math.max(
                task.ackedCompletionAt ?? 0,
                task.lastCompletionAt,
              );
            }
            const ch = this.apply(id, { status: 'idle' }, { isSystemEvent: true });
            if (ch) changes.push(ch);
          }
          break;
        }
        case 'idle':
        case 'unknown': {
          // unknown 态需要监控器主动上报信号才能恢复（由 apply 驱动），这里不做超时转移，
          // 否则一旦进入 unknown 就会被立刻打回，形成抖动。
          break;
        }
        default:
          break;
      }
    }

    if (changes.length > 0) {
      this.commit(changes);
    }
    return changes;
  }

  /** 用户点「已读」：清 unread；success/failed 同时回 idle（PRD §5.4）。 */
  markRead(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }
    task.unread = false;
    if (task.status === 'success' || task.status === 'failed') {
      // ★ 熄灭绿灯前，先把"这次完成"记进已确认水位。
      //
      // 顺序很重要：水位必须在把状态打回 idle **之前**记下 ——
      // 否则监控下一轮读到同一个完成、水位又没更新，绿灯会立刻复亮。
      // 记下之后，同一个完成事件的上报会被 apply 的确认闸门丢弃。
      if (task.lastCompletionAt !== undefined) {
        task.ackedCompletionAt = Math.max(
          task.ackedCompletionAt ?? 0,
          task.lastCompletionAt,
        );
      }
      this.apply(taskId, { status: 'idle' }, { isSystemEvent: true });
    } else {
      this.commit([]);
    }
  }

  /** 用户点「重试」：状态回 idle，等下一信号转 starting（架构 §4.3 动作映射）。 */
  reset(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }
    task.unread = false;
    task.error = undefined;
    task.message = undefined;
    task.progress = undefined;
    task.endedAt = undefined;
    task.durationMs = undefined;
    task.startedAt = undefined;
    task.lastSignalAt = this.now();
    this.statusSince.set(taskId, this.now());
    if (task.status !== 'idle') {
      // 借助 apply 走统一的状态机校验与广播路径。
      this.apply(taskId, { status: 'idle' }, { isSystemEvent: true });
    } else {
      this.commit([]);
    }
  }

  /** 暂停/恢复单个任务（面板「暂停」按钮）。 */
  setTaskPaused(taskId: string, paused: boolean): void {
    const task = this.tasks.get(taskId);
    if (!task || task.paused === paused) {
      return;
    }
    task.paused = paused;
    this.commit([]);
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) {
      return;
    }
    this.paused = paused;
    this.commit([]);
  }

  /**
   * 设置悬浮灯鼠标穿透（D10「锁定/穿透」）。
   *
   * 由托盘菜单触发，主进程再调用 overlay.applySettings 真正生效；
   * store 这里只维护快照字段，好让菜单勾选状态能反映当前值。
   */
  setClickThrough(clickThrough: boolean): void {
    if (this.clickThrough === clickThrough) {
      return;
    }
    this.clickThrough = clickThrough;
    this.commit([]);
  }

  /** 供 index.ts 在配置热重载后同步（用户在 yaml 里改了 lamp.clickThrough）。 */
  syncClickThrough(clickThrough: boolean): void {
    this.clickThrough = clickThrough;
    this.commit([]);
  }

  setNotifyPrefs(prefs: { popup: boolean; sound: boolean }): void {
    this.notifyPrefs = { ...prefs };
    this.commit([]);
  }

  /**
   * 同步目标摘要（SPEC-025）。
   *
   * 目标不是任务运行态，**不进入**七态状态机；这里只把「悬浮灯目标行」
   * 需要的聚合值带进快照，供 OverlayWindow 计算行数与渲染层绘制。
   *
   * 值没变时直接返回，避免每次目标变更都把灯带版本推一遍。
   */
  setGoalsSummary(summary: GoalsSummary | undefined): void {
    const previous = this.goalsSummary;
    if (
      previous === summary ||
      (previous !== undefined &&
        summary !== undefined &&
        previous.active === summary.active &&
        previous.done === summary.done &&
        previous.progress === summary.progress)
    ) {
      return;
    }
    this.goalsSummary = summary;
    this.commit([]);
  }

  /**
   * 配置热重载后差分同步任务集合。
   * 已存在的任务只更新 name / cwd（面板展示用），状态一律保留，避免闪断。
   */
  syncTasks(taskConfigs: readonly TaskConfig[]): {
    added: string[];
    removed: string[];
    changed: string[];
  } {
    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];
    const nextIds = new Set(taskConfigs.map((t) => t.id));

    for (const cfg of taskConfigs) {
      const existing = this.tasks.get(cfg.id);
      if (!existing) {
        this.tasks.set(cfg.id, this.createInitialState(cfg));
        added.push(cfg.id);
        continue;
      }
      // ⚠️ enabled 的同步**不能**塞进 nameChanged 分支。
      //
      // 【踩过的坑】原实现在 `if (nameChanged)` 里做 `existing.paused = !cfg.enabled`，
      // 于是「名字没变、只把 yaml 里的 enabled 从 true 改成 false」这个
      // 最常见的操作**同步不到** store —— 表现为"配置里禁用了，浮窗上那一行还在"。
      // 现在两条独立的判断，各自比较、各自记录变更。
      if (existing.name !== cfg.name || existing.cwd !== cfg.jump?.cwd) {
        existing.name = cfg.name;
        existing.cwd = cfg.jump?.cwd;
        changed.push(cfg.id);
      }
      if (existing.enabled !== cfg.enabled) {
        existing.enabled = cfg.enabled;
        if (!changed.includes(cfg.id)) changed.push(cfg.id);
      }
      const presentation = presentationFor(cfg);
      const portLabel = derivePortLabel(cfg);
      if (existing.toolKind !== presentation.toolKind || existing.portLabel !== portLabel ||
        JSON.stringify(existing.availableActions) !== JSON.stringify(presentation.availableActions)) {
        Object.assign(existing, presentation, { portLabel });
        if (!changed.includes(cfg.id)) changed.push(cfg.id);
      }
    }

    for (const id of [...this.order]) {
      if (!nextIds.has(id)) {
        this.tasks.delete(id);
        this.statusSince.delete(id);
        removed.push(id);
      }
    }

    // 保持与配置一致的展示顺序
    this.order.length = 0;
    this.order.push(...taskConfigs.map((t) => t.id));
    this.commit([]);
    return { added, removed, changed };
  }

  /** 供调试/日志：按优先级导出任务名列表。 */
  describeOrder(): string[] {
    return this.getSnapshot().tasks
      .slice()
      .sort((a, b) => statusRank(a.status) - statusRank(b.status))
      .map((t) => `${t.status}:${t.taskId}`);
  }

  /* ---------------------------------------------------------------- 内部 */

  private commit(changes: StateChange[]): void {
    this.version += 1;
    this.snapshotCache = null;
    const snapshot = this.getSnapshot();
    this.emitter.emit('change', snapshot, changes);
  }
}

/**
 * 推导灯带上这一行显示的短标签（设计决策 D9）。
 *
 * 优先级：
 *   1. 配置里显式给的 `shortLabel`（最可读，推荐）
 *   2. `dsh` 型任务取 authority 的端口号（`127.0.0.1:3080` → `3080`）
 *   3. 退回 taskId
 *
 * 在 store 初始化时算一次，渲染层（classic script、拿不到 monitor 配置）
 * 不必也不该做这件事。
 */
export function derivePortLabel(cfg: TaskConfig): string {
  // ① 显式短标签优先 —— 端口号对人不总有意义
  //    （例：dsh 桌面客户端的本地服务在 19387，用户叫它"本地客户端"）
  const explicit = cfg.shortLabel;
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    return explicit.trim();
  }

  // ② dsh 型退回端口号
  const monitor = cfg.monitor as { type: string; authority?: unknown };
  if (monitor.type === 'dsh' && typeof monitor.authority === 'string') {
    const colon = monitor.authority.lastIndexOf(':');
    const port = colon === -1 ? '' : monitor.authority.slice(colon + 1);
    if (port.length > 0) {
      return port;
    }
  }

  // ③ 最后退回 id
  return cfg.id;
}

/** 供 notify 模块复用的默认通知偏好（避免重复字面量）。 */
export { DEFAULT_NOTIFY_SETTINGS };
