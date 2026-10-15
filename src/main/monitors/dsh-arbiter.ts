/**
 * D2 混合方案的仲裁层 —— dsh 侧插件（精确信号）与主动轮询（兜底）的合并。
 *
 * ============================================================================
 * 【为什么需要它】
 * ============================================================================
 * 采集有两条路，各有硬伤，必须合并：
 *
 * | | 主动轮询（DshMonitor） | 插件推送（dsh host 插件） |
 * |---|---|---|
 * | 拿到「等待授权」 | ❌ 拿不到 —— `pendingInteraction` 只在 dsh 客户端内存里 | ✅ **精确** |
 * | 需要装插件 | ✅ 不需要，零侵入 | ❌ 每个实例都要装 |
 * | 远端隧道实例 | ✅ 只要端口能连 | ❌ 远端往往不方便改 |
 * | 时效 | 受轮询间隔限制 | 事件驱动，准实时 |
 *
 * 于是决策 D2 = **插件优先、轮询打底、插件失效自动退回**。
 * 本模块就是把这条降级链落实的地方：插件信号带 TTL，过期后
 * `exactStateFor()` 返回 undefined，DshMonitor 自然退回 `plan.pending` 近似判定。
 *
 * ============================================================================
 * 【为什么按 sessionId 而不是 taskId 索引】
 * ============================================================================
 * 一个 dsh 实例（= 一个 authority = 一个 dsh 型任务）下会有**多个会话**，
 * 等待授权可能发生在其中任意一个。把信号归到 session 粒度，聚合才能真正
 * 反映「这个端口上有个会话卡住了」。taskId 粒度会把「哪个会话」抹掉。
 *
 * @module dsh-arbiter
 */

import type { TaskStatus } from '../../shared/types';

/** 插件上报的等待类型（与 dsh 的 pendingInteraction 三态一致）。 */
export type PluginWaitKind = 'approval' | 'plan-review' | 'question';

/** 插件经 webhook 推来的原始载荷中，本层关心的字段。 */
export interface PluginSignalPayload {
  /**
   * 该信号属于哪个 dsh 实例，形如 `127.0.0.1:3080`。
   * 插件侧需显式上报（`authority` 字段），否则无法归位到对应的 dsh 型任务。
   */
  readonly authority?: unknown;
  /** 会话 id —— 归位到具体会话，避免「哪个会话在等」被抹掉。 */
  readonly sessionId?: unknown;
  /** 内部事件类型：waiting / resumed / status / error / … */
  readonly kind?: unknown;
  /** 等待类型（kind === 'waiting' 时有意义）。 */
  readonly type?: unknown;
  /** `status` 事件的 running 布尔。 */
  readonly running?: unknown;
  /** `error` 事件的错误文本。 */
  readonly message?: unknown;
}

/** 仲裁后给 DshMonitor 的精确信号。 */
export interface ExactSessionSignal {
  readonly pendingInteraction?: PluginWaitKind;
  readonly errorMessage?: string;
}

export interface DshSignalArbiterOptions {
  /**
   * 插件信号的保鲜期（毫秒）。
   *
   * 为什么必须有 TTL：插件可能已经挂了、或 dsh 被关掉了，而最后一条
   * 「等待授权」还挂在内存里。若永不失效，灯会**永远停在黄色** ——
   * 这正是 PRD §5.4「防灯一直是绿的」的镜像问题（防灯一直是黄的）。
   * 默认 180s：足够覆盖人离开一会儿的场景，又不至于长期骗人。
   */
  readonly ttlMs?: number;
  readonly now?: () => number;
  /** 诊断用：信号过期被丢弃时回调（不抛）。 */
  readonly onExpired?: (sessionId: string) => void;
}

/** 一条被记录的等待信号。 */
interface WaitRecord {
  readonly kind: PluginWaitKind;
  readonly at: number;
  /** 归属的 authority，便于排查"信号归到哪儿了"。 */
  readonly authority: string;
}

/** 一条被记录的错误信号。 */
interface ErrorRecord {
  readonly message: string;
  readonly at: number;
}

const DEFAULT_TTL_MS = 180_000;

/** 把未知值收窄成合法的等待类型；非法一律返回 undefined。 */
export function asWaitKind(value: unknown): PluginWaitKind | undefined {
  return value === 'approval' || value === 'plan-review' || value === 'question'
    ? value
    : undefined;
}

/**
 * 插件信号仲裁器。
 *
 * 刻意做成**不依赖任何 IO 的纯内存结构**：便于单测，也让 host 层
 * 的接线保持简单（webhook 载荷进来 -> ingest，DshMonitor 出去 -> exactStateFor）。
 */
export class DshSignalArbiter {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly options: DshSignalArbiterOptions;

  /** sessionId -> 等待信号 */
  private readonly waits = new Map<string, WaitRecord>();
  /** sessionId -> 错误信号 */
  private readonly errors = new Map<string, ErrorRecord>();

  /** 统计（诊断/测试用） */
  private ingestedCount = 0;
  private ignoredCount = 0;

  constructor(options: DshSignalArbiterOptions = {}) {
    this.options = options;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * 吞掉一条插件载荷并更新内部状态。
   *
   * 语义（与插件的实际上报序列对应，见 lamp/plugin/index.js）：
   *   - `kind: 'waiting'` -> 记下等待类型（这是最值钱的一条）
   *   - `kind: 'resumed'` -> **清掉**等待（人类已作答，agent 继续）
   *   - `kind: 'status'`  -> `running === false` 时清掉等待
   *     （会话都停了，之前那个"在等"必然已结束；防止状态残留）
   *   - `kind: 'error'`   -> 记下错误，参与 failed 判定
   *   - `kind: 'removed'` -> 会话消失，清掉它的痕迹
   *   - 其余 kind        -> 忽略（added/activity/snapshot 与等待无关）
   *
   * 任何字段缺失/类型不对都**只忽略这一条**，绝不抛错 ——
   * 插件的载荷来自网络，必须当作不可信输入。
   *
   * @returns 本条是否对状态产生了影响（便于测试与诊断）
   */
  ingest(payload: PluginSignalPayload): boolean {
    this.ingestedCount += 1;

    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
    const authority = typeof payload.authority === 'string' ? payload.authority.trim() : '';

    // 没有 sessionId 就无法归位到会话 —— 忽略，不猜测
    if (sessionId.length === 0) {
      this.ignoredCount += 1;
      return false;
    }

    const kind = typeof payload.kind === 'string' ? payload.kind : '';

    switch (kind) {
      case 'waiting': {
        const wait = asWaitKind(payload.type);
        if (wait === undefined) {
          // 认不出等待类型：宁可不记，也不记一个含糊的"在等"
          this.ignoredCount += 1;
          return false;
        }
        this.waits.set(sessionId, { kind: wait, at: this.now(), authority });
        return true;
      }

      case 'resumed': {
        this.waits.delete(sessionId);
        return true;
      }

      case 'status': {
        // 会话停了 -> 之前的等待必然已结束
        if (payload.running === false) {
          return this.waits.delete(sessionId);
        }
        return false;
      }

      case 'error': {
        const message = typeof payload.message === 'string' ? payload.message : '未知错误';
        this.errors.set(sessionId, { message, at: this.now() });
        return true;
      }

      case 'removed': {
        // 会话消失 -> 清掉痕迹，避免它的"等待"长期占位到 TTL 过期
        const had = this.waits.delete(sessionId);
        this.errors.delete(sessionId);
        return had;
      }

      default:
        this.ignoredCount += 1;
        return false;
    }
  }

  /**
   * 取某会话当前有效的**精确**信号。
   *
   * 关键约定：**过期或不存在时返回 undefined**，调用方据此退回近似判定。
   * 这是「插件失效自动退回」的实现点，也是本模块存在的意义。
   */
  exactStateFor(sessionId: string): ExactSessionSignal | undefined {
    const at = this.now();

    const wait = this.waits.get(sessionId);
    if (wait !== undefined && at - wait.at > this.ttlMs) {
      this.waits.delete(sessionId);
      this.options.onExpired?.(sessionId);
    }

    const err = this.errors.get(sessionId);
    if (err !== undefined && at - err.at > this.ttlMs) {
      this.errors.delete(sessionId);
    }

    const freshWait = this.waits.get(sessionId);
    const freshErr = this.errors.get(sessionId);
    if (freshWait === undefined && freshErr === undefined) {
      return undefined;
    }

    return {
      ...(freshWait === undefined ? {} : { pendingInteraction: freshWait.kind }),
      ...(freshErr === undefined ? {} : { errorMessage: freshErr.message }),
    };
  }

  /**
   * 取某实例下**所有**会话的精确等待信号（面板逐会话展示用）。
   * 返回的 Map 已剔除过期项。
   */
  exactStateForAuthority(authority: string): Map<string, ExactSessionSignal> {
    const out = new Map<string, ExactSessionSignal>();
    for (const [sessionId, wait] of [...this.waits]) {
      if (wait.authority !== authority) continue;
      const exact = this.exactStateFor(sessionId);
      if (exact !== undefined) out.set(sessionId, exact);
    }
    return out;
  }

  /** 会话消失（dsh 报了 removed）时清掉它的痕迹，避免长期占内存。 */
  forget(sessionId: string): void {
    this.waits.delete(sessionId);
    this.errors.delete(sessionId);
  }

  /**
   * 【仅供测试】把所有已记录的信号强行标成过期。
   *
   * 为什么需要它：TTL 过期是时间行为，用真实 sleep 去测会引入 flakiness
   * （慢机器上"刚推入就过期了"，快机器上"还没过期"）。
   * 让测试能确定性地触发过期，比调大 TTL 硬等更可靠。
   */
  __expireAllForTest(): void {
    const stale = this.now() - this.ttlMs - 1;
    for (const [id, wait] of this.waits) {
      this.waits.set(id, { ...wait, at: stale });
    }
    for (const [id, err] of this.errors) {
      this.errors.set(id, { ...err, at: stale });
    }
  }

  /** 当前处于等待中的会话数（跨所有实例）。 */
  get waitingCount(): number {
    const at = this.now();
    let n = 0;
    for (const wait of this.waits.values()) {
      if (at - wait.at <= this.ttlMs) n += 1;
    }
    return n;
  }

  /** 处于等待中且属于某实例的会话数。 */
  waitingCountFor(authority: string): number {
    const at = this.now();
    let n = 0;
    for (const wait of this.waits.values()) {
      if (wait.authority === authority && at - wait.at <= this.ttlMs) n += 1;
    }
    return n;
  }

  /** 诊断快照（不含 PII，只给计数与键）。 */
  stats(): {
    ingested: number;
    ignored: number;
    trackedWaits: number;
    trackedErrors: number;
  } {
    return {
      ingested: this.ingestedCount,
      ignored: this.ignoredCount,
      trackedWaits: this.waits.size,
      trackedErrors: this.errors.size,
    };
  }

  clear(): void {
    this.waits.clear();
    this.errors.clear();
  }
}

/**
 * 把仲裁结果套用到轮询判定出的状态上。
 *
 * 排序刻意如此（每一条都有 PRD 依据）：
 *   1. **轮询已判 failed** -> 保留。PRD §4.4「failed 一票否决」，
 *      不能让一条"在等授权"把已经崩掉的实例粉饰成黄色。
 *   2. **插件报了 error** -> failed（比 waiting 更严重）。
 *   3. **插件报了精确等待** -> waiting（这是本模块的核心增值：
 *      轮询拿不到 pendingInteraction，只能靠 plan.pending 猜）。
 *   4. 其余 -> 原样返回轮询结论（含 unknown：实例失联是更严重的事实）。
 */
export function mergeExactIntoPolled(
  polled: TaskStatus,
  exact: ExactSessionSignal | undefined,
): TaskStatus {
  if (exact === undefined) return polled;

  // ① failed 一票否决（PRD §4.4）—— 不许被"在等授权"覆盖
  if (polled === 'failed') return 'failed';

  // ② 插件报错同样是 failed
  if (exact.errorMessage !== undefined) return 'failed';

  // ③ 精确等待信号：升级为 waiting
  if (exact.pendingInteraction !== undefined) return 'waiting';

  return polled;
}
