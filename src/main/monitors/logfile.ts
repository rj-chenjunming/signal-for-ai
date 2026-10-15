/**
 * log 型监控适配器 —— 日志增量轮询 + 正则规则映射。
 *
 * 依赖: monitors/log-tail（零依赖 glob + 增量读取）、monitors/base、monitors/pattern。
 *
 * 状态语义（PRD P0-9 / §5.4）：
 *  - 首次只读末尾 `fromEndBytes`（默认 64KB），**历史内容不作为信号**；
 *  - 后续只读新增字节，按 rules 判定；
 *  - `idleAfterSilenceMs` 静默超时 -> idle（防长尾任务被误判 running，PRD P1-4）；
 *  - 文件被截断/轮转 -> 不崩，按新文件处理（PRD T11 验收）。
 *
 * 【重要设计】waiting -> running 的判定不能只看「有新行」：
 * PRD §5.4 要求「日志新增**非授权行**」才回running。所以这里用 isWaitingEcho 区分。
 */

import {
  DEFAULT_IDLE_AFTER_SILENCE_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_START_END_BYTES,
} from '../../shared/constants';
import type { LogMonitorConfig, TaskStatus } from '../../shared/types';
import { MonitorAdapter, type MonitorContext } from './base';
import { isWaitingEcho, judgeStatusBatch, type RuleMatch } from './pattern';
import { createCursor, globFiles, splitLines, tailRead, type TailCursor } from './log-tail';

export interface LogMonitorOptions {
  /** 轮询间隔（由 app.pollIntervalMs 注入）。 */
  pollIntervalMs: number;
  /** 单次读取的最大字节数上限，防止日志暴涨读爆内存。 */
  maxReadBytes: number;
}

const DEFAULT_OPTIONS: LogMonitorOptions = {
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  maxReadBytes: 1024 * 1024,
};

export class LogMonitor extends MonitorAdapter {
  private readonly cfg: LogMonitorConfig;
  private readonly opts: LogMonitorOptions;
  private timer: NodeJS.Timeout | null = null;

  /** 文件 -> 游标。 */
  private readonly cursors = new Map<string, TailCursor>();
  /** 未完成的半行缓冲（跨文件共享一份，避免行被拆到两个文件里）。 */
  private pending = '';
  /** 本任务最近一次有效信号的时刻，用于 idleAfterSilenceMs。 */
  private lastActivityAt = Date.now();
  /** 最近一次上报的状态，用于去重。 */
  private lastStatus: TaskStatus | null = null;
  /** 是否已经完成过首次扫描。 */
  private primed = false;

  constructor(ctx: MonitorContext, options: Partial<LogMonitorOptions> = {}) {
    super(ctx);
    if (ctx.task.monitor.type !== 'log') {
      throw new Error(`LogMonitor 收到非 log 配置: ${ctx.task.monitor.type}`);
    }
    this.cfg = ctx.task.monitor;
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }

  override async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    if (this.cfg.paths.length === 0) {
      throw new Error('log 监控缺少 paths');
    }
    if (this.cfg.rules.length === 0) {
      throw new Error('log 监控缺少 rules，无法判定状态');
    }
    this.setRunning(true);

    // 先做一次「只建立游标不触发」的预热，避免把启动前的历史日志判成 running。
    this.warmup();

    const debounceMs = this.cfg.debounceMs ?? 0;
    const tick = (): void => {
      if (this.isDisposed) {
        return;
      }
      if (Date.now() - this.lastActivityAt < debounceMs) {
        return; // debounce 窗口内不处理高频日志
      }
      this.safeRun('log.poll', () => this.poll())();
    };

    this.timer = setInterval(tick, this.opts.pollIntervalMs);
  }

  /** 预热：建立所有已存在文件的游标，历史内容不产生状态变化。 */
  private warmup(): void {
    try {
      for (const file of this.resolveFiles()) {
        if (this.cursors.has(file)) {
          continue;
        }
        const cursor = createCursor();
        tailRead(file, cursor, this.cfg.fromEndBytes ?? DEFAULT_START_END_BYTES, true);
        this.cursors.set(file, cursor);
      }
      this.primed = true;
      this.log.info(
        `已接管 ${this.cursors.size} 个日志文件（历史内容不作为信号；后续只读新增字节）`,
      );
    } catch (err) {
      this.log.error('日志预热失败（已隔离）', err);
    }
  }

  private resolveFiles(): string[] {
    const seen = new Set<string>();
    for (const pattern of this.cfg.paths) {
      for (const file of globFiles(pattern)) {
        seen.add(file);
      }
    }
    return [...seen];
  }

  /** 一轮轮询。 */
  private poll(): void {
    const files = this.resolveFiles();
    const newlyMatched = this.primeNewFiles(files);

    let sawNewContent = false;
    let matched: RuleMatch | null = null;

    for (const file of files) {
      const cursor = this.cursors.get(file);
      if (!cursor) {
        continue;
      }
      const result = tailRead(
        file,
        cursor,
        Math.min(this.opts.maxReadBytes, (this.cfg.fromEndBytes ?? DEFAULT_START_END_BYTES) * 4),
      );
      if (result.text.length === 0) {
        continue;
      }
      sawNewContent = true;

      if (result.rotated) {
        this.log.info(`日志轮转/截断：${baseName(file)}（按新文件处理，不崩）`);
        this.pending = '';
      }

      const { lines, pending } = splitLines(result.text, this.pending);
      this.pending = pending;
      if (lines.length === 0) {
        continue;
      }

      // PRD §5.4：只有非授权行才让 waiting -> running
      const nonAuthLines = lines.filter((line) => !isWaitingEcho(line, this.ctx.rules));
      const candidates = nonAuthLines.length > 0 ? nonAuthLines : lines;
      const hit = judgeStatusBatch(candidates, this.ctx.rules);
      if (hit) {
        matched = hit;
      } else if (nonAuthLines.length === 0 && lines.length > 0) {
        // 本轮全是授权提示 -> 保持/进入 waiting
        this.markActivity();
        this.emitStatusOnce('waiting', excerpt(lines[lines.length - 1]!));
      }
    }

    if (matched) {
      this.markActivity();
      this.emitStatusOnce(matched.status, `命中规则「${matched.rule.source}」：${matched.sample}`);
    } else if (sawNewContent) {
      // 有新行但没命中任何规则 -> 视为仍在运行（PRD P0-9 语义：日志在动就是活着）
      this.markActivity();
      this.emitStatusOnce('running');
    }

    if (newlyMatched) {
      this.log.info('发现新的日志文件并已建立游标');
    }

    this.checkSilence();
  }

  /** 为新出现的文件建立游标（不把其历史内容当信号）。 */
  private primeNewFiles(files: readonly string[]): boolean {
    let any = false;
    for (const file of files) {
      if (this.cursors.has(file)) {
        continue;
      }
      const cursor = createCursor();
      tailRead(file, cursor, this.cfg.fromEndBytes ?? DEFAULT_START_END_BYTES, true);
      this.cursors.set(file, cursor);
      any = true;
    }
    // 清理已消失文件的游标，防止 Map 无限增长
    const alive = new Set(files);
    for (const known of [...this.cursors.keys()]) {
      if (!alive.has(known)) {
        this.cursors.delete(known);
      }
    }
    return any;
  }

  /** 静默超时 -> idle（PRD P1-4 idleAfterSilenceMs，防长尾误判）。 */
  private checkSilence(): void {
    const silenceMs = this.cfg.idleAfterSilenceMs ?? DEFAULT_IDLE_AFTER_SILENCE_MS;
    if (this.cfg.idleAfterSilenceMs === undefined) {
      return; // 用户未配置则不启用静默转 idle（交给 staleTimeoutMs兜底）
    }
    if (Date.now() - this.lastActivityAt >= silenceMs) {
      if (this.lastStatus === 'idle') {
        return;
      }
      this.log.info(`静默 ${silenceMs}ms 无新行，转idle`);
      this.emitStatus('idle', `静默超过 ${Math.round(silenceMs / 1000)}s`);
      this.lastStatus = 'idle';
    }
  }

  private markActivity(): void {
    this.lastActivityAt = Date.now();
  }

  private emitStatusOnce(status: TaskStatus, message?: string): void {
    this.markActivity();
    if (this.lastStatus === status) {
      this.emitHeartbeat(); // 同状态续心跳，防 stale 误判
      return;
    }
    this.lastStatus = status;
    this.emitStatus(status, message);
  }

  override async stop(): Promise<void> {
    this.markDisposed();
    this.setRunning(false);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.cursors.clear();
    this.pending = '';
  }

  /** 供诊断：当前接管的日志文件数。 */
  get watchedFileCount(): number {
    return this.cursors.size;
  }

  /** 供诊断：是否已完成预热。 */
  get isPrimed(): boolean {
    return this.primed;
  }
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function excerpt(line: string, max = 120): string {
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}
