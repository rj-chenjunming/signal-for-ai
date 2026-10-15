/**
 * 规则引擎 —— 正则预编译 + 状态判定 + 编译结果缓存。
 *
 * 依赖: 无（纯 TS）。可在 vitest 中直接验证（架构 T09 验收：`pattern.test.ts` 全绿）。
 *
 * 为什么要有这一层：
 *  1. 用户在 YAML 里写的是正则**字符串**，每次轮询都 `new RegExp()` 会白白重复解析；
 *  2. 用户正则可能写错（非法语法），必须在**编译期**捕获并降级，不能让单个任务把主进程带崩（PRD P0-7）；
 *  3. failed 规则要优先于 running 命中（PRD T11「rules 顺序匹配，failed 优先」），
 *     所以判定需要显式的优先级策略，而不是简单「第一个命中即返回」。
 */

import type { LogRule, TaskStatus } from '../../shared/types';

/* ============================================================================
 * 编译后的规则
 * ==========================================================================*/

export interface CompiledRule {
  /** 该规则的目标状态。 */
  readonly state: TaskStatus;
  /** 用户书写的原始正则字符串（用于日志与错误提示）。 */
  readonly source: string;
  /** 预编译的正则对象。 */
  readonly regex: RegExp;
}

/**
 * 编译结果集合。
 * `errors` 记录被丢弃的非法规则 —— 配置层会把它汇总成托盘气泡提示（架构 §1.7）。
 */
export interface CompiledRules {
  readonly rules: readonly CompiledRule[];
  readonly errors: readonly string[];
  /** 命中的规则索引 -> 状态的查表，判定时避免每次遍历字符串。 */
  readonly empty: boolean;
}

/** 空规则集合（无规则时判定恒为 null）。 */
export const EMPTY_COMPILED_RULES: CompiledRules = Object.freeze({
  rules: Object.freeze([]),
  errors: Object.freeze([]),
  empty: true,
});

/**
 * 编译日志规则。
 *
 * @param rules 用户配置的规则数组
 * @param flags  正则标志，默认 'i'（不区分大小写）—— AI CLI 的关键字大小写极不统一，
 *               PRD 示例里全部用了 (?i) 前缀，但用户未必记得写，这里再兜一层。
 */
export function compileRules(rules: readonly LogRule[], flags = 'i'): CompiledRules {
  const compiled: CompiledRule[] = [];
  const errors: string[] = [];

  for (const [index, rule] of rules.entries()) {
    if (!rule || typeof rule.match !== 'string' || rule.match.length === 0) {
      errors.push(`rules[${index}] 缺少 match 正则，已丢弃`);
      continue;
    }
    try {
      compiled.push({
        state: rule.state,
        source: rule.match,
        regex: new RegExp(rule.match, flags),
      });
    } catch (err) {
      // 非法正则只丢这一条规则，其余规则照常生效（PRD P0-7 非法项不崩溃）。
      errors.push(
        `rules[${index}] 正则非法（${rule.match}）：${(err as Error).message}，已丢弃`,
      );
    }
  }

  if (compiled.length === 0) {
    return { rules: [], errors, empty: true };
  }
  return { rules: compiled, errors, empty: false };
}

/* ============================================================================
 * 状态判定
 * ==========================================================================*/

/** 单行判定结果。 */
export interface RuleMatch {
  status: TaskStatus;
  /** 命中的规则（供 message 摘要与调试）。 */
  rule: CompiledRule;
  /** 实际匹配的文本片段（截断后）。 */
  sample: string;
}

/**
 * 判定优先级（架构 T11：rules 顺序匹配，failed 优先）。
 *
 * PRD §5.1 的语义分层：failed 是「已出问题」，必须压过一切进行中/等待态；
 * 其余状态按配置顺序（用户可以把 success 规则写在前面）。
 */
function compareMatch(a: RuleMatch, b: RuleMatch): number {
  if (a.status === 'failed' && b.status !== 'failed') return -1;
  if (b.status === 'failed' && a.status !== 'failed') return 1;
  return 0; // 同为 failed 或同为非 failed 时，保持配置顺序（Array.sort 稳定）
}

/**
 * 对一段文本判定状态。
 *
 * @param text   待判定文本（单行或多行）
 * @param rules  编译后的规则
 * @returns 命中的最高优先级规则；无命中返回 null
 */
export function judgeStatus(text: string, rules: CompiledRules): RuleMatch | null {
  if (rules.empty || !text) {
    return null;
  }
  const matches: RuleMatch[] = [];
  for (const rule of rules.rules) {
    // 用 exec 而非 test，是为了拿到 match[0] 做 message 摘要。
    const found = rule.regex.exec(text);
    if (found) {
      matches.push({ status: rule.state, rule, sample: found[0].slice(0, 200) });
    }
  }
  if (matches.length === 0) {
    return null;
  }
  matches.sort(compareMatch);
  return matches[0]!;
}

/** 批量判定：按行判定后，返回最后一条有效判定（越新的行越代表当前状态）。 */
export function judgeStatusBatch(
  lines: readonly string[],
  rules: CompiledRules,
): RuleMatch | null {
  if (rules.empty) {
    return null;
  }
  // 【为什么不能写成 latest = hit】
  // 无条件覆盖会让"最后一条命中"赢，于是
  //   ["fatal crash", "task done"] -> success
  // 把崩溃报成完成，这是最危险的一类误报（假绿灯，比红灯误报严重得多）。
  // 正确语义：failed 一票否决并立即锁定；非 failed 之间才看最后一条，
  // 因为日志的时间顺序天然由后一行代表"最新进展"。
  let latest: RuleMatch | null = null;
  for (const line of lines) {
    const hit = judgeStatus(line, rules);
    if (!hit) {
      continue;
    }
    if (hit.status === 'failed') {
      return hit; // failed 优先：一旦出现立即定案，不再看后面的行
    }
    latest = hit;
  }
  return latest;
}

/**
 * 判断一行是否是「授权/交互提示」的回声。
 *
 * 用于 waiting -> running 的判定（PRD §5.4「日志新增**非授权行** / webhook 恢复」）：
 * 监控器需要区分「新行继续输出 = 恢复运行」与「又一行授权提示 = 仍在等待」。
 * 复用同一份规则集，避免两处规则不同步。
 */
export function isWaitingEcho(line: string, rules: CompiledRules): boolean {
  if (rules.empty) {
    return false;
  }
  for (const rule of rules.rules) {
    if (rule.state === 'waiting' && rule.regex.test(line)) {
      return true;
    }
  }
  return false;
}

/* ============================================================================
 * 去重节流（PRD P1-5 / 架构 §8.5）
 * ==========================================================================*/

/**
 * 同键去抖节流器。
 *
 * 语义（架构 §8.5）：
 *  - 首次调用返回 true（放行）；
 *  - 窗口内的重复调用返回 false（去抖），但累加 count 用于徽标 `×N`；
 *  - `resetTask(taskId)` 在任务回到 running 时清空该任务的全部记录，
 *    这样「完成 → 重新开始 → 再完成」能正常再次通知。
 *
 * 抽成独立类是为了让它**不依赖 Electron**，可在 vitest 中确定性验证。
 */
export class Debouncer {
  private readonly records = new Map<string, { lastNotifyAt: number; count: number }>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * @returns { allowed: 是否放行; count: 放行后到目前为止累计触发次数（>=1） }
   */
  check(key: string): { allowed: boolean; count: number } {
    const at = this.now();
    const rec = this.records.get(key);
    if (rec && at - rec.lastNotifyAt < this.windowMs) {
      rec.count += 1;
      return { allowed: false, count: rec.count };
    }
    this.records.set(key, { lastNotifyAt: at, count: 1 });
    return { allowed: true, count: 1 };
  }

  /** 只读查询累计次数（不改变状态）。 */
  countOf(key: string): number {
    return this.records.get(key)?.count ?? 0;
  }

  /** 清空某个任务的全部去抖记录（收到 running 时调用）。 */
  resetTask(taskId: string): void {
    for (const key of [...this.records.keys()]) {
      if (key.startsWith(`${taskId}:`)) {
        this.records.delete(key);
      }
    }
  }

  clear(): void {
    this.records.clear();
  }

  get size(): number {
    return this.records.size;
  }
}
