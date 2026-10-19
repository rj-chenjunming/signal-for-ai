import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, appendFile, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexMonitor } from '../src/main/monitors/codex';
import { MonitorHost } from '../src/main/monitors/host';
import { TaskStore } from '../src/main/store';
import { validateConfig } from '../src/main/config';
import { compileRules } from '../src/main/monitors/pattern';
import type { MonitorEvent } from '../src/main/monitors/base';
import type { TaskConfig } from '../src/shared/types';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), logError: vi.fn() };
let dir: string;
let now: number;
let monitors: CodexMonitor[];
const event = (type: string, at: number, turn = 't1', extra = {}) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type, turn_id: turn, ...extra } }) + '\n';
const task = (): TaskConfig => ({ id: 'codex', name: 'Codex', enabled: true, monitor: { type: 'codex', sessionsDir: dir, activeWithinMs: 10000, intervalMs: 500 } });
function fixture() {
  const events: MonitorEvent[] = [];
  const store = new TaskStore([task()]);
  const monitor = new CodexMonitor({ task: task(), logger, rules: compileRules([]), timeouts: { startTimeoutMs: 1000, staleTimeoutMs: 30000, waitingTimeoutMs: 30000 }, ackedCompletionAt: () => store.getTask('codex')?.ackedCompletionAt ?? 0, sink: (id, ev) => {
    events.push(ev);
    if (ev.kind === 'status') store.apply(id, { ...ev, isSignal: true });
  } }, { type: 'codex', sessionsDir: dir, activeWithinMs: 10000, intervalMs: 500 });
  monitors.push(monitor);
  return { monitor, events, store, status: () => store.getTask('codex')?.status };
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lamp-codex-'));
  monitors = [];
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(async () => { for (const m of monitors) await m.stop(); vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

describe('SPEC-002 真实 JSONL → 状态仓库', () => {
  it('运行→追加完成→确认不复亮→新轮次', async () => {
    const file = join(dir, 'rollout-a.jsonl');
    await writeFile(file, event('task_started', now));
    const f = fixture(); await f.monitor.start();
    expect(f.status()).toBe('running');
    now += 1000;
    await appendFile(file, event('task_complete', now)); await f.monitor.pollOnce();
    expect(f.status()).toBe('success');
    expect(f.store.getTask('codex')?.lastCompletionAt).toBe(now);
    f.store.markRead('codex'); await f.monitor.pollOnce(); expect(f.status()).toBe('idle');
    now += 1000;
    await appendFile(file, event('turn_started', now, 't2')); await f.monitor.pollOnce(); expect(f.status()).toBe('running');
  });
  it('启动时不重放历史完成', async () => {
    await writeFile(join(dir, 'rollout-a.jsonl'), event('task_started', now - 3000) + event('task_complete', now - 1000));
    const f = fixture(); await f.monitor.start(); expect(f.status()).toBe('idle');
    expect(f.events.some(e => e.kind === 'status' && e.status === 'success')).toBe(false);
  });
  it('半行完成不提前变绿，补齐后完成', async () => {
    const file = join(dir, 'rollout-a.jsonl'); await writeFile(file, event('task_started', now));
    const f = fixture(); await f.monitor.start(); now += 1000;
    const done = event('turn_complete', now);
    await appendFile(file, done.slice(0, -8)); await f.monitor.pollOnce(); expect(f.status()).toBe('running');
    await appendFile(file, done.slice(-8)); await f.monitor.pollOnce(); expect(f.status()).toBe('success');
  });
  it('普通文字、工具错误、未知格式不会判完成', async () => {
    const file = join(dir, 'rollout-a.jsonl'); await writeFile(file, event('task_started', now));
    const f = fixture(); await f.monitor.start();
    await appendFile(file, event('agent_message', now, 't1', { message: 'task complete success failed awaiting approval' }) + event('error', now));
    await f.monitor.pollOnce(); expect(f.status()).toBe('running');
    await writeFile(file, '{bad json}\n' + JSON.stringify({ type: 'response_item', payload: { text: 'success' } }) + '\n');
    await f.monitor.pollOnce(); expect(f.status()).toBe('unknown');
  });
  it.each(['turn_aborted', 'task_complete'])('%s 的取消/终止错误不是成功', async (type) => {
    const file = join(dir, 'rollout-a.jsonl'); await writeFile(file, event('task_started', now));
    const f = fixture(); await f.monitor.start(); now += 1000;
    await appendFile(file, event(type, now, 't1', type === 'task_complete' ? { error: { message: 'terminal error' } } : {}));
    await f.monitor.pollOnce(); expect(f.status()).toBe(type === 'turn_aborted' ? 'idle' : 'failed');
  });
  it('新轮次忽略旧 turn 的迟到完成', async () => {
    const file = join(dir, 'rollout-a.jsonl'); await writeFile(file, event('task_started', now, 't2') + event('task_complete', now + 1, 't1'));
    const f = fixture(); await f.monitor.start(); expect(f.status()).toBe('running');
  });
  it('多会话中仍在运行优先；文件截断后不保留旧绿灯', async () => {
    const a = join(dir, 'rollout-a.jsonl'); const b = join(dir, 'rollout-b.jsonl');
    await writeFile(a, event('task_started', now)); await writeFile(b, event('task_started', now, 't2'));
    const f = fixture(); await f.monitor.start(); now += 1000;
    await appendFile(a, event('task_complete', now)); await f.monitor.pollOnce(); expect(f.status()).toBe('running');
    await rm(b); await f.monitor.pollOnce(); expect(f.status()).toBe('success');
    await writeFile(a, ''); await f.monitor.pollOnce(); expect(f.status()).toBe('unknown');
  });
  it('陈旧运行变 unknown，token_count 提供结构化活动证据', async () => {
    const file = join(dir, 'rollout-a.jsonl'); await writeFile(file, event('task_started', now));
    const f = fixture(); await f.monitor.start(); now += 11000;
    await f.monitor.pollOnce(); expect(f.status()).toBe('unknown');
    await appendFile(file, event('token_count', now)); await f.monitor.pollOnce(); expect(f.status()).toBe('running');
  });
  it('缺失目录/空目录未知，新会话在两轮间开始并结束仍可报告', async () => {
    await rm(dir, { recursive: true }); const f = fixture(); await f.monitor.start(); expect(f.status()).toBe('unknown');
    await mkdir(dir); now += 1000;
    await writeFile(join(dir, 'rollout-a.jsonl'), event('task_started', now) + event('task_complete', now + 1));
    now += 1; await f.monitor.pollOnce(); expect(f.status()).toBe('success');
  });
  it('只看到完成不能从 unknown 凭空恢复成功', async () => {
    const f = fixture(); await f.monitor.start(); now += 1000;
    await writeFile(join(dir, 'rollout-a.jsonl'), event('task_complete', now)); await f.monitor.pollOnce(); expect(f.status()).toBe('unknown');
  });
  it('重复启动只有一个轮询定时器，停止等待在途读取且不再上报，不写源文件', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    const file = join(dir, 'rollout-a.jsonl'); const source = event('task_started', now); await writeFile(file, source);
    const f = fixture(); await f.monitor.start(); await f.monitor.start(); expect(interval).toHaveBeenCalledTimes(1);
    const pending = f.monitor.pollOnce(); const count = f.events.length;
    await f.monitor.stop(); await pending; await f.monitor.stop(); await f.monitor.pollOnce();
    expect(f.events).toHaveLength(count); expect(await readFile(file, 'utf8')).toBe(source); expect(f.monitor.isHealthy()).toBe(false);
  });
  it('宿主创建 Codex 并在暂停/恢复时清理', async () => {
    await writeFile(join(dir, 'rollout-a.jsonl'), event('task_started', now));
    const { config } = validateConfig({ version: 1, tasks: [task()] });
    const store = new TaskStore(config.tasks); const host = new MonitorHost({ config, store, logger });
    try { await host.start(); expect(host.activeCount).toBe(1); expect(store.getTask('codex')?.status).toBe('running'); await host.setPaused(true); expect(host.activeCount).toBe(0); await host.setPaused(false); expect(host.activeCount).toBe(1); }
    finally { await host.stopAll(); }
  });
});
