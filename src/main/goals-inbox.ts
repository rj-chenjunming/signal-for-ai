/**
 * 目标进展本地同步（SPEC-027）—— 文件收件箱导入。
 *
 * 设计：外部工具只往 `goal-inbox.jsonl` 追加一行 JSON；应用轮询导入，
 * 不引入网络端口与鉴权。导入失败的行落到 `.failed.jsonl`，不阻塞后续。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Goal } from '../shared/types';
import type { GoalsStore } from './goals-store';

export interface GoalsInboxLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface DrainGoalInboxOptions {
  inboxPath: string;
  store: GoalsStore;
  logger?: GoalsInboxLogger;
}

export interface DrainGoalInboxResult {
  applied: number;
  failed: number;
}

/** 单行上限（防止误写大文件/二进制）。 */
const MAX_LINE_BYTES = 8 * 1024;
/** 与 GoalsStore 的时间线文本上限保持一致。 */
const MAX_TEXT_LENGTH = 500;

type LineOutcome = { ok: true } | { ok: false; reason: string };

/** 把收件箱（含崩溃遗留的 .processing-*）导入目标时间线。 */
export function drainGoalInbox(options: DrainGoalInboxOptions): DrainGoalInboxResult {
  const { inboxPath, store, logger } = options;
  const dir = path.dirname(inboxPath);
  const base = path.basename(inboxPath);

  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { applied: 0, failed: 0 };
  }

  const candidates: string[] = [];
  for (const name of names) {
    if (name === base || name.startsWith(`${base}.processing-`)) {
      candidates.push(path.join(dir, name));
    }
  }

  let applied = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const candidate of candidates) {
    // 先原子改名抢占：CLI 后续追加会落到新的 inbox，不会与本轮读取互相踩。
    const processing = `${candidate}.processing-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    try {
      fs.renameSync(candidate, processing);
    } catch {
      continue; // 被另一个进程抢走 / 已消失
    }

    let content = '';
    try {
      content = fs.readFileSync(processing, 'utf8');
    } catch (err) {
      logger?.warn(`[goals-inbox] 读取失败：${(err as Error).message}`);
      safeUnlink(processing);
      continue;
    }

    for (const line of content.split(/\r?\n/)) {
      if (line.trim().length === 0) {
        continue;
      }
      const outcome = applyLine(store, line);
      if (outcome.ok) {
        applied += 1;
      } else {
        failed += 1;
        failures.push(JSON.stringify({ reason: outcome.reason, raw: line }));
        logger?.warn(`[goals-inbox] 丢弃一行：${outcome.reason}`);
      }
    }
    safeUnlink(processing);
  }

  if (failures.length > 0) {
    try {
      fs.appendFileSync(`${inboxPath}.failed.jsonl`, `${failures.join('\n')}\n`, 'utf8');
    } catch (err) {
      logger?.warn(`[goals-inbox] 写入失败记录失败：${(err as Error).message}`);
    }
  }

  return { applied, failed };
}

/**
 * 定时轮询器：启动时立即 drain 一次，之后每隔 intervalMs 检查。
 * 定时器 unref，不阻止应用退出。
 */
export class GoalInboxPoller {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly options: DrainGoalInboxOptions & { intervalMs?: number },
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    this.drain();
    this.timer = setInterval(() => this.drain(), this.options.intervalMs ?? 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private drain(): void {
    try {
      const result = drainGoalInbox(this.options);
      if (result.applied > 0 || result.failed > 0) {
        this.options.logger?.info(
          `[goals-inbox] 导入 ${result.applied} 条，失败 ${result.failed} 条`,
        );
      }
    } catch (err) {
      this.options.logger?.error(`[goals-inbox] 导入异常：${(err as Error).message}`);
    }
  }
}

/* ============================================================================
 * 单行处理
 * ==========================================================================*/

function applyLine(store: GoalsStore, line: string): LineOutcome {
  if (line.length > MAX_LINE_BYTES) {
    return fail(`单行超过 ${MAX_LINE_BYTES} 字节`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (err) {
    return fail(`JSON 解析失败：${(err as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('行必须是 JSON 对象');
  }

  const record = raw as Record<string, unknown>;
  const kind = record['kind'] === undefined ? 'progress' : record['kind'];
  if (kind !== 'progress' && kind !== 'issue') {
    return fail(`不支持的 kind：${String(kind)}`);
  }

  const text = typeof record['text'] === 'string' ? record['text'].trim() : '';
  if (text.length === 0 || text.length > MAX_TEXT_LENGTH) {
    return fail(`text 需为 1–${MAX_TEXT_LENGTH} 个字符`);
  }

  const goalId = typeof record['goalId'] === 'string' ? record['goalId'].trim() : '';
  const goalTitle = typeof record['goal'] === 'string' ? record['goal'].trim() : '';
  if (!goalId && !goalTitle) {
    return fail('缺少 goal 或 goalId');
  }

  let goal: Goal | undefined;
  if (goalId) {
    goal = store.getView().goals.find((item) => item.id === goalId);
    if (!goal) {
      return fail(`找不到目标：${goalId}`);
    }
  } else {
    const matches = store.getView().goals.filter((item) => item.title === goalTitle);
    if (matches.length === 0) {
      return fail(`找不到目标：${goalTitle}`);
    }
    if (matches.length > 1) {
      return fail(`同名目标不唯一，请改用 goalId：${goalTitle}`);
    }
    goal = matches[0]!;
  }

  const result = store.addEntry(goal.id, kind, text);
  return result.ok ? { ok: true } : fail(result.message);
}

function fail(reason: string): LineOutcome {
  return { ok: false, reason };
}

function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* best effort */
  }
}
