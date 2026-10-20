/**
 * Codex rollout 只读增量采集。只解释结构化生命周期，不输出正文或读取认证目录。
 * 分块追平后只读新增字节，保留开始证据；截断/替换丢弃旧游标。
 */
import { opendir, stat } from 'node:fs/promises';
import { readJsonl, type JsonlCursor } from './jsonl-state';
import { approvalId, emptyApprovals, reduceApproval, type ApprovalLedger } from './codex-approval';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MonitorAdapter, type MonitorContext } from './base';
import type { CodexMonitorConfig, TaskStatus } from '../../shared/types';

const MAX_FILES = 32;
interface SessionState {
  status: 'running' | 'success' | 'failed' | 'idle' | 'unknown';
  at: number;
  turnId?: string;
  startedAt?: number;
  sessionId?: string;
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
  if (object(raw) && raw.type === 'session_meta' && object(raw.payload) && typeof raw.payload.id === 'string') return { ...state, sessionId: raw.payload.id };
  if (!object(raw) || raw.type !== 'event_msg' || !object(raw.payload) || typeof raw.timestamp !== 'string') return state;
  const at = Date.parse(raw.timestamp);
  if (!Number.isFinite(at) || at <= 0 || at > now + 5000 || at < state.at) return state;
  const payload = raw.payload;
  const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : undefined;
  if (payload.type === 'task_started' || payload.type === 'turn_started') {
    return { status: 'running', at, turnId, startedAt: at, sessionId: state.sessionId };
  }
  if (turnId && state.turnId && turnId !== state.turnId) return state;
  if (payload.type === 'task_complete' || payload.type === 'turn_complete') {
    return { ...state, status: payload.error != null ? 'failed' : 'success', at, turnId: turnId ?? state.turnId };
  }
  if (payload.type === 'turn_aborted') return { ...state, status: 'idle', at };
  if (payload.type === 'token_count' && state.status === 'running') return { ...state, at };
  return state;
}



export class CodexMonitor extends MonitorAdapter {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private baselineAt = 0;
  private readonly seenStarts = new Map<string, number>();
  /** 只将本监控实际观测为活跃的回合纳入失联保护，历史遗留不压掉新完成。 */
  private readonly observedStarts = new Map<string, number>();
  private readonly cursors = new Map<string, JsonlCursor<SessionState>>();
  private approvalCursor?: JsonlCursor<ApprovalLedger>;
  private readonly lostApprovals = new Map<string, number>();
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
    this.approvalCursor = undefined;
    this.lostApprovals.clear();
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
      const reads = await Promise.allSettled(files.map(async file => ({ ...file, ...await readJsonl<SessionState>(file.path, now, () => ({ status: 'unknown', at: 0 }), reduceLine, this.cursors.get(file.path)) })));
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
      let hookMissing = false;
      let hookError = false;
      let approvals = emptyApprovals();
      if (this.config.approvalEventsFile) {
        const pending = [...(this.approvalCursor?.publishedState?.turns.values() ?? [])].filter(t => t.pending.size > 0);
        const markLost = () => { for (const turn of pending) this.lostApprovals.set(approvalId(turn.sessionId, turn.turnId), turn.at); };
        try {
          const result = await readJsonl(this.config.approvalEventsFile, now, emptyApprovals,
            (state, line, at) => reduceApproval(state, line, at, this.ctx.timeouts.waitingTimeoutMs), this.approvalCursor);
          if (!this.isRunning) return;
          this.approvalCursor = result.cursor;
          approvals = result.cursor.publishedState ?? emptyApprovals();
          if (result.reset) markLost();
          for (const [key, at] of this.lostApprovals) {
            const turn = approvals.turns.get(key);
            const sessionId = (JSON.parse(key) as string[])[0];
            if ((turn && turn.at >= at) || Math.max(approvals.cleared.get(key) ?? 0, approvals.cleared.get(approvalId(sessionId, '*')) ?? 0) >= at) this.lostApprovals.delete(key);
          }
          hookError = approvals.overflow || (!result.caughtUp && result.cursor.publishedState === undefined);
        } catch (error) {
          if (!this.isRunning) return;
          hookMissing = object(error) && error.code === 'ENOENT';
          hookError = !hookMissing;
          markLost();
        }
      }
      const bound = (state: SessionState) => state.sessionId && state.turnId && state.startedAt !== undefined
        ? approvals.turns.get(approvalId(state.sessionId, state.turnId)) : undefined;
      const active = ready.filter(r => r.state.status === 'running' && r.state.startedAt !== undefined);
      const waiting = active.filter(r => {
        const turn = bound(r.state);
        return turn && [...turn.pending.values()].some(item => item.at >= r.state.startedAt! && now - item.at <= this.ctx.timeouts.waitingTimeoutMs);
      });
      const expired = active.some(r => [...(bound(r.state)?.pending.values() ?? [])].some(item => item.at >= r.state.startedAt! && now - item.at > this.ctx.timeouts.waitingTimeoutMs));
      const running = ready.filter(r => r.state.status === 'running' && now - Math.max(r.state.at, bound(r.state)?.activityAt ?? 0) <= freshness);
      const activeKeys = new Set(active.filter(r => r.state.sessionId && r.state.turnId).map(r => approvalId(r.state.sessionId!, r.state.turnId!)));
      for (const key of this.lostApprovals.keys()) if (!activeKeys.has(key)) this.lostApprovals.delete(key);
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
      if (hookError || this.lostApprovals.size || expired) { status = 'unknown'; message = 'Codex 授权 Hook 不可读、证据丢失或等待超时'; }
      else if (waiting.length) { status = 'waiting'; message = `${waiting.length} 个 Codex 回合等待授权（工具返回后恢复）`; }
      else if (running.length) { status = 'running'; message = `${running.length} 个 Codex 本地会话执行中`; }
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
      if (freshStart && (status === 'success' || status === 'failed' || status === 'idle' || status === 'waiting')) this.emitStatus('running', 'Codex 已观测到新回合开始');
      if (hookMissing) message += '；授权 Hook 尚未连接';
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
