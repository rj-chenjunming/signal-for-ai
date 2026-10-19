/**
 * Codex rollout 只读增量采集。只解释结构化生命周期，不输出正文或读取认证目录。
 * 分块追平后只读新增字节，保留开始证据；截断/替换丢弃旧游标。
 */
import { open, opendir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MonitorAdapter, type MonitorContext } from './base';
import type { CodexMonitorConfig, TaskStatus } from '../../shared/types';

const MAX_FILES = 32;
const MAX_BYTES = 512 * 1024;
const MAX_LINE_BYTES = 256 * 1024;
interface SessionState {
  status: 'running' | 'success' | 'failed' | 'idle' | 'unknown';
  at: number;
  turnId?: string;
  startedAt?: number;
}
interface Candidate { path: string; mtime: number }
interface SessionCursor {
  identity: string;
  size: number;
  fingerprint: string;
  offset: number;
  pending: Buffer;
  skippingLine: boolean;
  state: SessionState;
  /** 新增正文尚未追平时保持上次可靠观测，不能因分块预算自造失联。 */
  publishedState?: SessionState;
}

async function recentFiles(root: string): Promise<Candidate[]> {
  const files: Candidate[] = [];
  let entries = 0;
  async function walk(dir: string, depth: number): Promise<void> {
    const handle = await opendir(dir);
    for await (const entry of handle) {
      if (++entries > 5000) throw new Error('目录项超过 5000，请缩小 sessionsDir');
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= 6) throw new Error('目录超过 6 层，请缩小 sessionsDir');
        await walk(path, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push({ path, mtime: (await stat(path)).mtimeMs });
      }
      // 不跟随符号链接，不扫描 auth 文件或压缩/未知格式。
    }
  }
  await walk(root, 0);
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reduceLine(state: SessionState, line: string, now: number): SessionState {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return state; }
  if (!object(raw) || raw.type !== 'event_msg' || !object(raw.payload) || typeof raw.timestamp !== 'string') return state;
  const at = Date.parse(raw.timestamp);
  if (!Number.isFinite(at) || at <= 0 || at > now + 5000 || at < state.at) return state;
  const payload = raw.payload;
  const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : undefined;
  if (payload.type === 'task_started' || payload.type === 'turn_started') {
    return { status: 'running', at, turnId, startedAt: at };
  }
  if (turnId && state.turnId && turnId !== state.turnId) return state;
  if (payload.type === 'task_complete' || payload.type === 'turn_complete') {
    return { ...state, status: payload.error != null ? 'failed' : 'success', at, turnId: turnId ?? state.turnId };
  }
  if (payload.type === 'turn_aborted') return { ...state, status: 'idle', at };
  if (payload.type === 'token_count' && state.status === 'running') return { ...state, at };
  return state;
}

async function readSession(path: string, now: number, previous?: SessionCursor): Promise<{ cursor: SessionCursor; caughtUp: boolean; reset: boolean }> {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
    // Windows 可能在关闭写句柄时才刷新 mtime。用有界首尾摘要识别同长度重写，
    // 不能仅因时间刷新就重置长回合；样本也计入每轮读取预算。
    const sample = Buffer.alloc(Math.min(info.size, 256));
    if (info.size <= 256) {
      if (sample.length) await handle.read(sample, 0, sample.length, 0);
    } else {
      await handle.read(sample, 0, 128, 0);
      await handle.read(sample, 128, 128, info.size - 128);
    }
    const fingerprint = createHash('sha256').update(sample).digest('hex');
    const reset = previous === undefined || previous.identity !== identity || info.size < previous.size ||
      (info.size === previous.size && fingerprint !== previous.fingerprint);
    const cursor: SessionCursor = reset ? {
      identity, size: info.size, fingerprint, offset: 0,
      pending: Buffer.alloc(0), skippingLine: false, state: { status: 'unknown', at: 0 },
    } : { ...previous, size: info.size, fingerprint };
    const buffer = Buffer.alloc(Math.min(info.size - cursor.offset, MAX_BYTES - sample.length));
    const { bytesRead } = buffer.length ? await handle.read(buffer, 0, buffer.length, cursor.offset) : { bytesRead: 0 };
    cursor.offset += bytesRead;
    let start = 0;
    for (let end = buffer.indexOf(10); end >= 0 && end < bytesRead; end = buffer.indexOf(10, start)) {
      if (!cursor.skippingLine && cursor.pending.length + end - start <= MAX_LINE_BYTES) {
        const line = Buffer.concat([cursor.pending, buffer.subarray(start, end)]).toString('utf8');
        cursor.state = reduceLine(cursor.state, line, now);
      }
      cursor.pending = Buffer.alloc(0);
      cursor.skippingLine = false;
      start = end + 1;
    }
    // 保存短半行的原始字节，避免 UTF-8 字符在块边界被拆坏。超长正文只跳过这一行。
    if (!cursor.skippingLine) {
      if (cursor.pending.length + bytesRead - start <= MAX_LINE_BYTES) {
        cursor.pending = Buffer.concat([cursor.pending, buffer.subarray(start, bytesRead)]);
      } else {
        cursor.pending = Buffer.alloc(0);
        cursor.skippingLine = true;
      }
    }
    const caughtUp = cursor.offset === info.size;
    if (caughtUp) cursor.publishedState = cursor.state;
    return { cursor, caughtUp, reset };
  } finally { await handle.close(); }
}

export class CodexMonitor extends MonitorAdapter {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private baselineAt = 0;
  private readonly seenStarts = new Map<string, number>();
  /** 只将本监控实际观测为活跃的回合纳入失联保护，历史遗留不压掉新完成。 */
  private readonly observedStarts = new Map<string, number>();
  private readonly cursors = new Map<string, SessionCursor>();
  constructor(ctx: MonitorContext, private readonly config: CodexMonitorConfig) { super(ctx); }

  async start(): Promise<void> {
    if (this.isRunning || this.isDisposed) return;
    this.setRunning(true);
    this.baselineAt = Date.now();
    await this.pollOnce();
    if (!this.isRunning) return;
    this.timer = setInterval(() => { void this.pollOnce(); }, this.config.intervalMs ?? 2000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.setRunning(false);
    this.markDisposed();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
    this.cursors.clear();
    this.seenStarts.clear();
    this.observedStarts.clear();
  }

  async pollOnce(): Promise<void> {
    if (!this.isRunning) return;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.poll().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async poll(): Promise<void> {
    try {
      const now = Date.now();
      const files = await recentFiles(this.config.sessionsDir ?? join(homedir(), '.codex', 'sessions'));
      const paths = new Set(files.map(file => file.path));
      for (const path of this.cursors.keys()) if (!paths.has(path)) this.cursors.delete(path);
      for (const path of this.seenStarts.keys()) if (!paths.has(path)) this.seenStarts.delete(path);
      for (const path of this.observedStarts.keys()) if (!paths.has(path)) this.observedStarts.delete(path);
      // 等全部读取结算，保证 stop 后没有仍持有句柄的兄弟读取或迟到缓存写入。
      const reads = await Promise.allSettled(files.map(async file => ({ ...file, ...await readSession(file.path, now, this.cursors.get(file.path)) })));
      if (!this.isRunning) return;
      const failure = reads.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      const rows = reads.map(result => {
        if (result.status === 'rejected') throw result.reason;
        const row = result.value;
        this.cursors.set(row.path, row.cursor);
        if (row.reset) this.seenStarts.delete(row.path);
        return { ...row, state: row.cursor.publishedState ?? { status: 'unknown', at: 0 } as SessionState };
      });
      const freshness = this.config.activeWithinMs ?? 300000;
      const ready = rows.filter(r => r.cursor.publishedState !== undefined);
      const running = ready.filter(r => r.state.status === 'running' && now - r.state.at <= freshness);
      for (const row of running) {
        if (row.state.startedAt !== undefined) this.observedStarts.set(row.path, row.state.startedAt);
      }
      const uncertain = rows.some(r => !r.caughtUp && r.cursor.publishedState === undefined && (
        this.observedStarts.has(r.path) || (r.cursor.state.status === 'running' && now - r.cursor.state.at <= freshness)
      )) || ready.some(r => this.observedStarts.has(r.path) && (
        r.state.status === 'unknown' ||
        (r.state.status === 'running' && this.observedStarts.get(r.path) === r.state.startedAt && now - r.state.at > freshness)
      ));
      const failed = ready.some(r => r.state.status === 'failed' && r.state.at > this.baselineAt);
      const completed = Math.max(0, ...ready.filter(r => r.state.status === 'success' && r.state.startedAt !== undefined).map(r => r.state.at));
      const resolved = ready.some(r => r.state.status === 'idle' || (r.state.status === 'success' && r.state.startedAt !== undefined));
      let status: TaskStatus;
      let message: string;
      if (running.length) { status = 'running'; message = `${running.length} 个 Codex 本地会话执行中`; }
      else if (failed) { status = 'failed'; message = 'Codex 回合终止错误'; }
      else if (uncertain) { status = 'unknown'; message = 'Codex 已观测的回合活动已陈旧或不可读'; }
      else if (completed > this.baselineAt && completed > (this.ctx.ackedCompletionAt?.() ?? 0)) {
        status = 'success'; message = 'Codex 回合完成，点击确认';
      } else if (resolved) { status = 'idle'; message = 'Codex 本地会话无执行中回合'; }
      else { status = 'unknown'; message = 'Codex 无可靠本地事件或活动已陈旧'; }

      // 两次轮询间完整发生的回合也有明确 start 证据，按真实顺序交给状态机。
      // 仅看到 complete 时绝不伪造 running 来绕过 unknown/failed 的转移保护。
      const freshStart = ready.some(r => r.state.startedAt !== undefined &&
        r.state.startedAt > (this.seenStarts.get(r.path) ?? 0) &&
        (r.state.startedAt >= this.baselineAt || (r.state.status === 'success' && r.state.at > this.baselineAt)));
      if (freshStart && (status === 'success' || status === 'failed' || status === 'idle')) this.emitStatus('running', 'Codex 已观测到新回合开始');
      for (const row of ready) if (row.state.startedAt !== undefined) this.seenStarts.set(row.path, row.state.startedAt);
      this.emit({ kind: 'status', status, message, at: now, ...(status === 'success' ? { completionAt: completed } : {}) });
    } catch (error) {
      if (!this.isRunning) return;
      // 不把原始日志行/正文带入诊断输出。
      const code = object(error) && typeof error.code === 'string' ? error.code : '读取失败或扫描超限';
      this.emitStatus('unknown', `Codex 本地会话不可读（${code}）`);
    }
  }
}
