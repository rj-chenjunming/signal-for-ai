/**
 * dsh 多端口监控适配器（设计决策 D2a / D4 / D5 / D8）。
 *
 * 语义：
 *  - 主动轮询一个 dsh web 实例的 `POST /api/session/list`，把该实例**全部会话**
 *    聚合成这个任务的灯色（D6：每端口一盏灯）。
 *  - 端口是 SSH 隧道也没关系 —— 只要 authority 能连通就行。
 *  - 密钥来源可插拔（本机读盘 / SSH 取远端 / 测试注入），见 SecretSource。
 *
 * 与其他适配器的关系：
 *  - 与 `WebhookMonitor` **互补而非替代**。webhook 型是被动的、信号精确
 *    （能拿到 `pendingInteraction` 真值）；本适配器是主动的、零侵入、
 *    覆盖所有实例，但**拿不到精确的"等待授权"**，只能用 `plan.pending` 近似。
 *    典型部署：同一个 dsh 实例配两条任务（dsh 型打底 + webhook 型兜精确），
 *    或用 D2 的混合仲裁合并二者。
 *
 * 错误隔离（架构铁律 §4.2）：
 *  - 任何网络/协议异常都不抛出，只累加失败计数；
 *  - 连续失败超上限 -> 转 unknown（同 process 型行为）；
 *  - 定时器回调一律经 safeRun 包裹。
 */

import {
  MAX_RESTART_ATTEMPTS,
  RESTART_BACKOFF_MS,
} from '../../shared/constants';
import type { DshMonitorConfig, TaskStatus } from '../../shared/types';
import { MonitorAdapter, type MonitorContext } from './base';
import {
  DshClient,
  deriveFromListItem,
  readSigningSecret,
  type DshAuthErrorCode,
  type DshSessionListItem,
} from './dsh-instance';
import { mergeExactIntoPolled } from './dsh-arbiter';

/** 聚合优先级（PRD §3.1：failed > waiting > running > success > starting > idle > unknown）。 */
const AGGREGATE_PRIORITY: Readonly<Record<TaskStatus, number>> = Object.freeze({
  failed: 0,
  waiting: 1,
  running: 2,
  success: 3,
  starting: 4,
  idle: 5,
  unknown: 6,
} as Record<TaskStatus, number>);

/**
 * 密钥来源抽象。
 *
 * 为什么要抽出来：本机实例读本机盘即可；隧道实例（实测用本机密钥必 401）
 * 需要从远端取。把"怎么拿密钥"与"怎么用密钥"分开，
 * 后续加 SSH 实现时不用动适配器本身。
 */
export interface SecretSource {
  /** 该来源是否能为这个 authority 提供密钥。 */
  supports(authority: string): boolean;
  /** 取密钥；失败时抛错（由适配器兜住并计入失败计数）。 */
  get(authority: string): Promise<Buffer>;
}

/** 本机型：直接读本机 dsh 的 credentials。 */
export class LocalCredentialsSource implements SecretSource {
  private cached: Buffer | null = null;
  /**
   * 本机密钥是否已被服务端拒绝过。
   *
   * 【为什么必须有这个标志 —— 这是实际踩过的坑】
   * 最初的兜底只在「读本机文件失败」时触发。但真实情况是：
   * 本机文件**读得到**（32 字节，完全合法），只是**服务端不认**（401）——
   * 隧道那头的 dsh 用的是它自己的密钥。
   * 于是 invalidate() 清掉缓存后，下一轮又老老实实把同一把本机密钥读回来，
   * 永远走不到远端，表现为「日志说将尝试 SSH，但永远不尝试」。
   *
   * 所以「文件读不到」与「密钥被服务端拒绝」是**两件事**，要分别处理。
   */
  private localRejected = false;

  /**
   * @param dshHome 本机 dsh 配置目录
   * @param fetchRemoteSecret 可选：本机密钥被服务端拒绝后的兜底（D5 远端 SSH）。
   */
  constructor(
    private readonly dshHome: string,
    private readonly fetchRemoteSecret?: () => Promise<Buffer>,
  ) {}

  /** 本机来源对任何 authority 都"支持"——是否能认证成功由服务端裁决。 */
  supports(_authority: string): boolean {
    return true;
  }

  async get(_authority: string): Promise<Buffer> {
    if (this.cached !== null) {
      return this.cached;
    }

    // ① 本机密钥已被拒 -> 直接走远端，不再重复读本机文件
    if (this.localRejected && this.fetchRemoteSecret !== undefined) {
      const remote = await this.fetchRemoteSecret();
      this.cached = remote;
      return remote;
    }

    // ② 常规：读本机密钥
    try {
      const secret = readSigningSecret(this.dshHome);
      this.cached = secret;
      return secret;
    } catch (err) {
      // ③ 本机文件读不到（如纯远端部署）-> 兜底远端
      if (this.fetchRemoteSecret !== undefined) {
        const remote = await this.fetchRemoteSecret();
        this.cached = remote;
        return remote;
      }
      throw err;
    }
  }

  /**
   * 服务端回 401 后调用：标记本机密钥不适用，下次改走远端兜底。
   *
   * 只标记、不清除 `localRejected` —— 一旦确认本机密钥对这个实例无效，
   * 就没必要每轮都拿它去试一遍（那会产生无谓的 401 与日志噪声）。
   */
  invalidate(): void {
    this.cached = null;
    this.localRejected = true;
  }
}

/** 固定密钥来源（测试与显式配置用）。 */
export class StaticSecretSource implements SecretSource {
  constructor(private readonly secret: Buffer) {}

  supports(_authority: string): boolean {
    return true;
  }

  async get(_authority: string): Promise<Buffer> {
    return this.secret;
  }
}

export interface DshMonitorOptions {
  /** 密钥来源链，按顺序取第一个 supports() 为真的。 */
  readonly secretSources: readonly SecretSource[];
  /**
   * 可选：插件上报的精确等待信号。
   * 键是 sessionId，值是插件的 `pendingInteraction` / `errorMessage`。
   * 未注入时退化为 `plan.pending` 近似路径（D2 的"插件失效自动退回"）。
   */
  readonly pluginStateFor?: (sessionId: string) =>
    | { pendingInteraction?: 'approval' | 'plan-review' | 'question'; errorMessage?: string }
    | undefined;
}

/** 一次轮询的结果摘要，供测试与诊断。 */
export interface DshPollOutcome {
  readonly ok: boolean;
  readonly status?: TaskStatus;
  readonly sessionCount?: number;
  readonly errorCode?: DshAuthErrorCode;
  /** 本轮的判定时刻（测试可注入，便于时间相关断言）。 */
  readonly at: number;
}

export class DshMonitor extends MonitorAdapter {
  private readonly cfg: DshMonitorConfig;
  private readonly options: DshMonitorOptions;

  private client: DshClient | null = null;
  /** 当前使用的密钥来源（401 时需要让它失效重取）。 */
  private source: SecretSource | undefined;
  /** 是否已经因认证被拒而失效过一次凭据（避免每轮都跑 SSH）。 */
  private credentialsInvalidated = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  /** 连续失败次数（成功即清零）。 */
  private failureCount = 0;
  /** 是否已经因为连续失败而报过 unknown（避免重复上报刷屏）。 */
  private reportedUnknown = false;

  /** 最近一次成功轮询时刻，用于心跳超时判定。 */
  private lastSuccessAt = 0;
  /** 当前是否正在执行一轮（防止慢轮询叠加）。 */
  private polling = false;

  /** 最近一次聚合结果，供诊断/面板。 */
  private lastOutcome: DshPollOutcome = { ok: false, at: 0 };

  /** 每个会话的最近状态，供面板逐会话展示（D6）。 */
  private readonly sessionStatuses = new Map<string, TaskStatus>();

  constructor(ctx: MonitorContext, options: DshMonitorOptions) {
    super(ctx);
    if (ctx.task.monitor.type !== 'dsh') {
      throw new Error(`DshMonitor 收到非 dsh 配置: ${ctx.task.monitor.type}`);
    }
    this.cfg = ctx.task.monitor;
    this.options = options;
  }

  /** 供测试/面板读取逐会话状态。 */
  get sessionBreakdown(): ReadonlyMap<string, TaskStatus> {
    return this.sessionStatuses;
  }

  get outcome(): DshPollOutcome {
    return this.lastOutcome;
  }

  override async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    this.setRunning(true);
    this.failureCount = 0;
    this.reportedUnknown = false;
    this.lastSuccessAt = Date.now();

    // 立即跑一轮：不要把首次判定推迟一个轮询间隔（否则灯会先灰一下）
    void this.pollOnce();

    this.log.info(
      `已启动 dsh 监控 authority=${this.cfg.authority} interval=${this.intervalMs}ms` +
        (this.cfg.sshHost === undefined ? '' : ` sshHost=${this.cfg.sshHost}`),
    );
  }

  override async stop(): Promise<void> {
    // 幂等（架构契约）：重复调用不报错，也不能残留定时器
    this.markDisposed();
    this.setRunning(false);
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.client = null;
  }

  /**
   * 健康判定：进程还在跑即健康。
   * 「连不上 dsh」属于**业务状态**（转 unknown），不是适配器不健康 ——
   * 若在这里返回 false，frame 会把适配器重建掉，反而丢失失败计数。
   */
  override isHealthy(): boolean {
    return this.isRunning && !this.isDisposed;
  }

  private get intervalMs(): number {
    return this.cfg.intervalMs ?? 5_000;
  }

  private get heartbeatTimeoutMs(): number {
    return this.cfg.heartbeatTimeoutMs ?? 120_000;
  }

  /**
   * 确保 client 就绪（取密钥 + 建客户端）。密钥缺失时抛错，由调用方计入失败。
   *
   * 会把当前使用的来源记在 `this.source`，供 401 时失效重取（D5 的远端兜底）。
   */
  private async ensureClient(): Promise<DshClient> {
    if (this.client !== null) {
      return this.client;
    }
    const source = this.options.secretSources.find((s) => s.supports(this.cfg.authority));
    if (source === undefined) {
      throw new Error(`没有可用的密钥来源支持 ${this.cfg.authority}`);
    }
    this.source = source;
    const secret = await source.get(this.cfg.authority);
    this.client = new DshClient({
      authority: this.cfg.authority,
      secret,
      timeoutMs: this.cfg.timeoutMs ?? 8_000,
    });
    return this.client;
  }

  /**
   * 认证被拒（401/403）后丢弃已缓存的密钥与客户端，让下一轮重新取。
   *
   * 这是 D5 远端兜底的触发点：本机密钥对隧道实例不适用时，
   * `LocalCredentialsSource.invalidate()` 会清掉本机密钥缓存，
   * 下一次 `get()` 就会走我们为它配的远端 SSH 兜底。
   *
   * 只失效一次：若换来源后仍然 401，说明确实是别的问题（如 token 失效），
   * 不该每轮都去跑一次 SSH。
   */
  private invalidateCredentials(): void {
    if (this.credentialsInvalidated || this.source === undefined) {
      return;
    }
    this.credentialsInvalidated = true;
    const invalidatable = this.source as { invalidate?: () => void };
    invalidatable.invalidate?.();
    this.client = null;
    this.log.info(
      `认证被拒，已丢弃缓存的密钥与客户端，下一轮重新取（${
        this.cfg.sshHost === undefined ? '未配置 sshHost，将重读本机密钥' : `将尝试 sshHost=${this.cfg.sshHost}`
      }）`,
    );
  }

  /**
   * 跑一轮轮询。
   *
   * 刻意做成 public：测试要能确定性地驱动单轮，而不必等定时器。
   * @returns 本轮结果（同时写入 lastOutcome）
   */
  async pollOnce(now: number = Date.now()): Promise<DshPollOutcome> {
    // 防叠加：上一轮还没回来就跳过本轮（慢轮询不该堆积）
    if (this.polling) {
      return this.lastOutcome;
    }
    this.polling = true;
    try {
      const client = await this.ensureClient();
      const result = await client.listSessions();

      if (!result.ok) {
        return this.recordFailure(result.code, result.message, now);
      }

      const items = result.value?.items ?? [];
      return this.recordSuccess(items, now);
    } catch (err) {
      // 密钥读取失败等 —— 同样只是失败计数，绝不抛出
      const message = err instanceof Error ? err.message : String(err);
      return this.recordFailure('credentials/missing', message, now);
    } finally {
      this.polling = false;
      this.scheduleNext();
    }
  }

  /** 成功一轮：逐会话判定 → 聚合 → 上报。 */
  private recordSuccess(items: readonly DshSessionListItem[], now: number): DshPollOutcome {
    this.failureCount = 0;
    this.reportedUnknown = false;
    this.lastSuccessAt = now;

    const statuses: TaskStatus[] = [];
    this.sessionStatuses.clear();

    for (const item of items) {
      // 跳过占位的空白会话（dsh 里 blank 表示"新建但还没内容"）
      if (item.blank === true) continue;

      const sessionId = item.sessionId ?? '';

      // ① 先算**轮询侧**状态（只用 session/list 拿得到的信息）
      const polled = deriveFromListItem(item, now, {
        allowPlanPendingHeuristic: this.cfg.allowPlanPendingHeuristic,
      });

      // ② 再叠加插件的**精确**信号（D2 仲裁）。
      //    顺序不能反：mergeExactIntoPolled 内含「轮询已判 failed 时不许被
      //    waiting 覆盖」的保护（PRD §4.4 failed 一票否决），
      //    若先合并精确值再判定，那条保护就失效了。
      const exact =
        sessionId === '' ? undefined : this.options.pluginStateFor?.(sessionId);
      const status = mergeExactIntoPolled(polled, exact);

      if (sessionId !== '') {
        this.sessionStatuses.set(sessionId, status);
      }
      statuses.push(status);
    }

    const aggregated = aggregate(statuses);

    this.lastOutcome = {
      ok: true,
      status: aggregated,
      sessionCount: statuses.length,
      at: now,
    };

    // 上报聚合态。message 里带上会话数与在跑的会话数，便于面板一眼看出规模。
    const runningCount = statuses.filter((s) => s === 'running' || s === 'waiting').length;
    this.emitStatus(
      aggregated,
      `dsh ${this.cfg.authority}：${statuses.length} 会话` +
        (runningCount > 0 ? `，${runningCount} 个活跃` : ''),
    );
    return this.lastOutcome;
  }

  /** 失败一轮：累加计数、退避；超上限转 unknown。 */
  private recordFailure(code: DshAuthErrorCode, message: string, now: number): DshPollOutcome {
    this.failureCount += 1;
    this.lastOutcome = { ok: false, errorCode: code, at: now };

    // 认证失败要能一眼区分（PRD 惯例：401/403 单独记日志，不要和其他错误混为一谈）
    const isAuth = code === 'auth/unauthorized' || code === 'auth/forbidden';
    if (isAuth) {
      this.log.warn(
        `dsh ${this.cfg.authority} 认证失败（${code}）—— ` +
          (this.cfg.sshHost === undefined
            ? '若该端口是 SSH 隧道，需配置 sshHost 从远端取密钥'
            : `将尝试从 ${this.cfg.sshHost} 取密钥`),
      );
      // D5：本机密钥对隧道实例不适用（实测必 401）。
      // 丢掉缓存，下一轮走远端兜底 —— 只做一次，避免每轮跑 SSH。
      this.invalidateCredentials();
    } else {
      this.log.warn(`dsh ${this.cfg.authority} 轮询失败（${code}）：${message}`);
    }

    if (this.failureCount >= MAX_RESTART_ATTEMPTS) {
      // 与 process 型同行为：连续失败超上限 -> 判定监控源失联
      if (!this.reportedUnknown) {
        this.reportedUnknown = true;
        this.log.warn(
          `dsh ${this.cfg.authority} 连续失败 ${this.failureCount} 次（最后：${code}），判定监控源失联`,
        );
        this.emitStatus('unknown', `连续 ${this.failureCount} 次轮询失败（${code}）`);
      }
    } else if (this.failureCount > 0) {
      // 未到上限：仍然上报一次心跳，避免框架误判适配器死了
      this.emitHeartbeat();
      // 首次失败就点亮失败态，让用户尽早看到问题（而不是等 5 次）
      if (this.failureCount === 1) {
        this.emitStatus('failed', `轮询失败（${code}）：${message}`);
      }
    }

    return this.lastOutcome;
  }

  /** 安排下一轮。失败时按 RESTART_BACKOFF_MS 退避，成功时用配置间隔。 */
  private scheduleNext(): void {
    if (this.isDisposed) {
      return;
    }
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    let delay = this.intervalMs;
    if (this.failureCount > 0) {
      // 连续失败时按 1s/2s/4s/8s/16s/30s 退避（复用既有常量，不另造序列）
      const idx = Math.min(this.failureCount - 1, RESTART_BACKOFF_MS.length - 1);
      delay = Math.max(delay, RESTART_BACKOFF_MS[idx] ?? delay);
    }

    this.pollTimer = setTimeout(
      // safeRun 包裹：回调里任何异常都不许逃逸成 uncaughtException
      this.safeRun('dsh.poll', () => {
        if (this.isDisposed) return;
        void this.pollOnce();
      }),
      delay,
    );
    this.pollTimer.unref?.();
  }

  /** 供框架/测试：最近一次成功轮询距今多久。 */
  silentForMs(now: number = Date.now()): number {
    return now - this.lastSuccessAt;
  }

  /** 心跳是否已超时（框架之外的自检口径，与 WebhookMonitor 对齐）。 */
  isHeartbeatTimedOut(now: number = Date.now()): boolean {
    return this.silentForMs(now) > this.heartbeatTimeoutMs;
  }
}

/**
 * 聚合一组会话状态成端口灯色。
 * 空集合返回 idle（一个没有会话的 dsh = 空闲，不是失联）。
 */
export function aggregate(states: readonly TaskStatus[]): TaskStatus {
  if (states.length === 0) return 'idle';
  let best: TaskStatus = states[0] ?? 'idle';
  for (const s of states) {
    if (AGGREGATE_PRIORITY[s] < AGGREGATE_PRIORITY[best]) {
      best = s;
    }
  }
  return best;
}
