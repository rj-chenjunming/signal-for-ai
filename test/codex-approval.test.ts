import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexMonitor } from '../src/main/monitors/codex';
import { TaskStore } from '../src/main/store';
import { compileRules } from '../src/main/monitors/pattern';
import { validateConfig } from '../src/main/config';
import type { TaskConfig } from '../src/shared/types';
import type { MonitorEvent } from '../src/main/monitors/base';

let dir: string, now: number, hooks: string, rollout: string;
let monitors: CodexMonitor[];
const key = 'a'.repeat(64), otherKey = 'b'.repeat(64);
const life = (type: string, turn = 't1') => JSON.stringify({ type: 'event_msg', timestamp: new Date(now).toISOString(), payload: { type, turn_id: turn } }) + '\n';
const meta = (session = 's1') => JSON.stringify({ type: 'session_meta', payload: { id: session } }) + '\n';
const record = (event = 'approval_requested', extra = {}) => JSON.stringify({ version: 1, event, sessionId: 's1', turnId: 't1', toolKey: key, at: now, ...extra }) + '\n';
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), logError: vi.fn() };
function fixture() {
  const { config } = validateConfig({ version: 1, tasks: [{ id: 'codex', name: 'Codex', enabled: true, monitor: { type: 'codex', sessionsDir: dir, approvalEventsFile: hooks, intervalMs: 500, activeWithinMs: 10000 } }] });
  const task: TaskConfig = config.tasks[0];
  const events: MonitorEvent[] = [];
  const store = new TaskStore([task]);
  const monitor = new CodexMonitor({ task, logger, rules: compileRules([]), timeouts: { startTimeoutMs: 1000, staleTimeoutMs: 30000, waitingTimeoutMs: 30000 }, sink: (id, ev) => { events.push(ev); if (ev.kind === 'status') store.apply(id, { ...ev, isSignal: true }); } }, task.monitor as ConstructorParameters<typeof CodexMonitor>[1]);
  monitors.push(monitor);
  return { monitor, events, store, status: () => store.getTask('codex')?.status };
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lamp-approval-'));
  // Separate suffix: the hook ledger must never be treated as a rollout.
  hooks = join(dir, 'hooks.events'); rollout = join(dir, 'session.jsonl');
  now = Date.now(); monitors = [];
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  await writeFile(rollout, meta() + life('task_started'));
});
afterEach(async () => { await Promise.all(monitors.map(m => m.stop())); vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

describe('SPEC-011 配置', () => {
  it('保留有效事件路径，非法值有警告', () => {
    const valid = validateConfig({ version: 1, tasks: [{ id: 'c', monitor: { type: 'codex', approvalEventsFile: ' C:/lamp/events ' } }] });
    expect(valid.config.tasks[0].monitor).toHaveProperty('approvalEventsFile', 'C:/lamp/events');
    const bad = validateConfig({ version: 1, tasks: [{ id: 'c', monitor: { type: 'codex', approvalEventsFile: 12 } }] });
    expect(bad.warnings.join(' ')).toContain('approvalEventsFile');
  });
});
describe('SPEC-011 真实文件 + TaskStore 审批状态', () => {
  it('同回合审批黄灯优先于并行蓝灯，匹配返回后恢复且不重放', async () => {
    await writeFile(join(dir, 'parallel.jsonl'), meta('s2') + life('task_started', 't2'));
    const f = fixture(); await f.monitor.start(); expect(f.status()).toBe('running');
    now += 100; await writeFile(hooks, record()); await f.monitor.pollOnce(); expect(f.status()).toBe('waiting');
    await appendFile(hooks, record('tool_returned', { toolKey: otherKey })); await f.monitor.pollOnce(); expect(f.status()).toBe('waiting');
    now += 100; await appendFile(hooks, record('tool_returned')); await f.monitor.pollOnce(); expect(f.status()).toBe('running');
    await f.monitor.pollOnce(); expect(f.status()).toBe('running');
  });
  it('相同输入并发按计数，普通活动不能清掉等待', async () => {
    const f = fixture(); await f.monitor.start();
    now += 100; await writeFile(hooks, record() + record()); await f.monitor.pollOnce(); expect(f.status()).toBe('waiting');
    await appendFile(hooks, record('tool_returned')); await appendFile(rollout, life('token_count')); await f.monitor.pollOnce(); expect(f.status()).toBe('waiting');
    await appendFile(hooks, record('tool_returned')); await f.monitor.pollOnce(); expect(f.status()).toBe('running');
  });
  it('跨 session/turn 和只有审批没有开始证据均不能洗黄', async () => {
    await writeFile(rollout, meta() + life('token_count'));
    const f = fixture(); await f.monitor.start(); expect(f.status()).toBe('unknown');
    now += 100; await writeFile(hooks, record()); await f.monitor.pollOnce(); expect(f.status()).toBe('unknown');
    await appendFile(rollout, life('task_started', 't2')); await f.monitor.pollOnce(); expect(f.status()).toBe('running');
    await appendFile(hooks, record('approval_requested', { sessionId: 'other', turnId: 't2' })); await f.monitor.pollOnce(); expect(f.status()).toBe('running');
  });
  it('真实开始与审批在两轮间发生可从 unknown 恢复黄，不凭完成洗绿', async () => {
    await writeFile(rollout, meta() + life('token_count')); const f = fixture(); await f.monitor.start();
    now += 100; await appendFile(rollout, life('task_started')); await writeFile(hooks, record()); await f.monitor.pollOnce(); expect(f.status()).toBe('waiting');
  });
  it.each(['turn', 'session'])('清理 %s 后恢复，回合完成照常留绿', async scope => {
    const f = fixture(); await f.monitor.start(); now += 100;
    await writeFile(hooks, record()); await f.monitor.pollOnce(); expect(f.status()).toBe('waiting');
    now += 100; await appendFile(hooks, record('clear', { scope })); await f.monitor.pollOnce(); expect(f.status()).toBe('running');
    now += 100; await appendFile(rollout, life('task_complete')); await f.monitor.pollOnce(); expect(f.status()).toBe('success');
  });
  it('等待跨过活动新鲜度仍黄，匹配返回刷新执行证据，等待超时为 unknown', async () => {
    const f = fixture(); await f.monitor.start(); now += 100;
    await writeFile(hooks, record()); await f.monitor.pollOnce(); expect(f.status()).toBe('waiting');
    now += 11000; await f.monitor.pollOnce(); expect(f.status()).toBe('waiting');
    await appendFile(hooks, record('tool_returned')); await f.monitor.pollOnce(); expect(f.status()).toBe('running');
    now += 100; await appendFile(hooks, record()); await f.monitor.pollOnce(); expect(f.status()).toBe('waiting');
    now += 30001; await f.monitor.pollOnce(); expect(f.status()).toBe('unknown');
  });
  it('缺少文件时保留原监控并诊断未连接，已等待后丢失文件为 unknown', async () => {
    const f = fixture(); await f.monitor.start(); expect(f.status()).toBe('running');
    expect(f.events.at(-1)).toMatchObject({ message: expect.stringContaining('Hook 尚未连接') });
    now += 100; await writeFile(hooks, record()); await f.monitor.pollOnce(); expect(f.status()).toBe('waiting');
    await rm(hooks); await f.monitor.pollOnce(); expect(f.status()).toBe('unknown');
  });
  it('坏记录/半行不生效，补齐后等待；清空文件不能保留旧等待', async () => {
    const f = fixture(); await f.monitor.start(); now += 100; const row = record();
    await writeFile(hooks, '{broken}\n' + row.slice(0, -1)); await f.monitor.pollOnce(); expect(f.status()).toBe('running');
    await appendFile(hooks, '\n'); await f.monitor.pollOnce(); expect(f.status()).toBe('waiting');
    await writeFile(hooks, ''); await f.monitor.pollOnce(); expect(f.status()).toBe('unknown');
  });
  it('回合结束即使未收到工具返回也能清等待，新回合不继承', async () => {
    const f = fixture(); await f.monitor.start(); now += 100;
    await writeFile(hooks, record()); await f.monitor.pollOnce(); expect(f.status()).toBe('waiting');
    now += 100; await appendFile(rollout, life('turn_aborted')); await f.monitor.pollOnce(); expect(f.status()).toBe('idle');
    now += 100; await appendFile(rollout, life('task_started', 't2')); await f.monitor.pollOnce(); expect(f.status()).toBe('running');
    await f.monitor.stop(); const count = f.events.length;
    await appendFile(hooks, record('approval_requested', { turnId: 't2' })); await f.monitor.pollOnce(); expect(f.events).toHaveLength(count);
  });
  it('未来和旧审批不作为新等待，超量状态明确降级', async () => {
    const f = fixture(); await f.monitor.start();
    await writeFile(hooks, record('approval_requested', { at: now + 60000 }) + record('approval_requested', { at: now - 31000 })); await f.monitor.pollOnce(); expect(f.status()).toBe('running');
    now += 100; await appendFile(hooks, Array.from({ length: 129 }, (_, i) => record('approval_requested', { sessionId: `s${i}` })).join(''));
    await f.monitor.pollOnce(); expect(f.status()).toBe('unknown');
  });
  it('丢失审批证据后，无关会话的新记录不能把当前回合洗蓝', async () => {
    const f = fixture(); await f.monitor.start(); now += 100;
    await writeFile(hooks, record()); await f.monitor.pollOnce(); expect(f.status()).toBe('waiting');
    await writeFile(hooks, ''); await f.monitor.pollOnce(); expect(f.status()).toBe('unknown');
    now += 100; await appendFile(hooks, record('approval_requested', { sessionId: 'other' })); await f.monitor.pollOnce(); expect(f.status()).toBe('unknown');
    now += 100; await appendFile(rollout, life('turn_aborted')); await f.monitor.pollOnce(); expect(f.status()).toBe('idle');
  });
  it('晚到的旧审批不能覆盖已经收到的回合清理', async () => {
    const f = fixture(); await f.monitor.start(); const old = now + 10; now += 100;
    await writeFile(hooks, record('clear', { scope: 'turn' }) + record('approval_requested', { at: old }));
    await f.monitor.pollOnce(); expect(f.status()).toBe('running');
  });
  it('单回合过量工具也有上界，明确降级', async () => {
    const f = fixture(); await f.monitor.start(); now += 100;
    await writeFile(hooks, Array.from({ length: 129 }, (_, i) => record('approval_requested', { toolKey: i.toString(16).padStart(64, '0') })).join(''));
    await f.monitor.pollOnce(); expect(f.status()).toBe('unknown');
  });
});
