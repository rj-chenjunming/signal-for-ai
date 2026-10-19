/**
 * Codex rollout 只读快照。只解释公开结构化事件，不输出正文或读取认证目录。
 * 每轮有界重放尾部，避免 append/半行/截断/文件替换造成永久错误的读偏移。
 */
import { open, opendir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MonitorAdapter, type MonitorContext } from './base';
import type { CodexMonitorConfig, TaskStatus } from '../../shared/types';

const MAX_FILES = 32;
const MAX_BYTES = 512 * 1024;
interface SessionState {
  status: 'running' | 'success' | 'failed' | 'idle' | 'unknown';
  at: number;
  turnId?: string;
  startedAt?: number;
}
interface Candidate { path: string; mtime: number }

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

async function readSession(path: string, now: number): Promise<SessionState> {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    const offset = Math.max(0, info.size - MAX_BYTES);
    const buffer = Buffer.alloc(Math.min(info.size, MAX_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (offset > 0) lines.shift(); // 尾部截断后的首行不完整
    lines.pop(); // 没有换行的末行留待写完，下轮重新读取
    return lines.reduce((state, line) => reduceLine(state, line, now), { status: 'unknown', at: 0 } as SessionState);
  } finally { await handle.close(); }
}

export class CodexMonitor extends MonitorAdapter {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private baselineAt = 0;
  private readonly seenStarts = new Map<string, number>();
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
      const rows = await Promise.all(files.map(async file => ({ ...file, state: await readSession(file.path, now) })));
      if (!this.isRunning) return;
      const freshness = this.config.activeWithinMs ?? 300000;
      const running = rows.filter(r => r.state.status === 'running' && now - r.state.at <= freshness);
      const uncertain = rows.some(r => r.state.status === 'unknown' || (r.state.status === 'running' && now - r.state.at > freshness));
      const failed = rows.some(r => r.state.status === 'failed' && r.state.at > this.baselineAt);
      const completed = Math.max(0, ...rows.filter(r => r.state.status === 'success').map(r => r.state.at));
      let status: TaskStatus;
      let message: string;
      if (running.length) { status = 'running'; message = `${running.length} 个 Codex 本地会话执行中`; }
      else if (failed) { status = 'failed'; message = 'Codex 回合终止错误'; }
      else if (!rows.length || uncertain) { status = 'unknown'; message = 'Codex 无可靠本地事件或活动已陈旧'; }
      else if (completed > this.baselineAt && completed > (this.ctx.ackedCompletionAt?.() ?? 0)) {
        status = 'success'; message = 'Codex 回合完成，点击确认';
      } else { status = 'idle'; message = 'Codex 本地会话无执行中回合'; }

      // 两次轮询间完整发生的回合也有明确 start 证据，按真实顺序交给状态机。
      // 仅看到 complete 时绝不伪造 running 来绕过 unknown/failed 的转移保护。
      const freshStart = rows.some(r => r.state.startedAt !== undefined && r.state.startedAt >= this.baselineAt && r.state.startedAt > (this.seenStarts.get(r.path) ?? 0));
      if (freshStart && (status === 'success' || status === 'failed' || status === 'idle')) this.emitStatus('running', 'Codex 已观测到新回合开始');
      const paths = new Set(rows.map(r => r.path));
      for (const path of this.seenStarts.keys()) if (!paths.has(path)) this.seenStarts.delete(path);
      for (const row of rows) if (row.state.startedAt !== undefined) this.seenStarts.set(row.path, row.state.startedAt);
      this.emit({ kind: 'status', status, message, at: now, ...(status === 'success' ? { completionAt: completed } : {}) });
    } catch (error) {
      if (!this.isRunning) return;
      // 不把原始日志行/正文带入诊断输出。
      const code = object(error) && typeof error.code === 'string' ? error.code : '读取失败或扫描超限';
      this.emitStatus('unknown', `Codex 本地会话不可读（${code}）`);
    }
  }
}
