import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MonitorHost, hashMonitorConfig, type MonitorHostOptions } from '../src/main/monitors/host';
import { CodexMonitor } from '../src/main/monitors/codex';
import type { MonitorContext, MonitorEvent } from '../src/main/monitors/base';
import { validateConfig } from '../src/main/config';
import { TaskStore } from '../src/main/store';
import type { Logger } from '../src/main/logger';
import type { TaskConfig } from '../src/shared/types';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), logError: vi.fn() } as unknown as Logger;
const task = (): TaskConfig => ({ id: 'codex', name: 'Codex', enabled: true,
  monitor: { type: 'codex', sessionsDir: '/never-read' },
  jump: { terminal: { type: 'windowProcess', processNames: ['ChatGPT.exe'] } } });
let names: string[];
let contexts: MonitorContext[];
let hosts: MonitorHost[];
let reader: ReturnType<typeof vi.fn< (fresh?: boolean) => Promise<readonly string[]> >>;
let start: ReturnType<typeof vi.spyOn>;
let stop: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers(); names = []; contexts = []; hosts = [];
  reader = vi.fn(async () => names);
  start = vi.spyOn(CodexMonitor.prototype, 'start').mockImplementation(async function (this: CodexMonitor) {
    const ctx = (this as unknown as { ctx: MonitorContext }).ctx;
    contexts.push(ctx); ctx.sink(ctx.task.id, { kind: 'status', status: 'running', at: Date.now() });
  });
  stop = vi.spyOn(CodexMonitor.prototype, 'stop').mockResolvedValue();
});
afterEach(async () => { for (const host of hosts) await host.stopAll(); vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture(t = task()) {
  const { config } = validateConfig({ version: 1, app: { pollIntervalMs: 1000 }, tasks: [t] });
  const store = new TaskStore(config.tasks);
  const opts: MonitorHostOptions & { presenceReader: typeof reader } = { config, store, logger, presenceReader: reader };
  const host = new MonitorHost(opts); hosts.push(host);
  return { host, store, config };
}
function send(event: MonitorEvent, ctx = contexts.at(-1)!) { ctx.sink(ctx.task.id, event); }
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

it('does not start a desktop data source when its process is absent', async () => {
  const f = fixture(); await f.host.start();
  expect(start).not.toHaveBeenCalled();
  expect(f.store.getTask('codex')).toMatchObject({ enabled: true, status: 'idle', processPresent: false, unread: false });
  expect(f.store.getSnapshot().aggregate).toBe('idle'); expect(f.host.activeCount).toBe(0);
});
it('alive (including hidden windows), exit and reopen maintain exactly one source and drop late events', async () => {
  names = ['chatgpt.EXE']; const f = fixture(); await f.host.start(); const old = contexts[0];
  expect(f.store.getTask('codex')?.status).toBe('running');
  await vi.advanceTimersByTimeAsync(2000); expect(start).toHaveBeenCalledTimes(1);
  names = []; await vi.advanceTimersByTimeAsync(1000);
  expect(stop).toHaveBeenCalledTimes(1); expect(f.store.getTask('codex')?.processPresent).toBe(false);
  send({ kind: 'status', status: 'failed', message: 'late', at: Date.now() }, old); await settle();
  expect(f.store.getTask('codex')?.status).toBe('idle');
  names = ['ChatGPT.exe']; await vi.advanceTimersByTimeAsync(1000);
  expect(start).toHaveBeenCalledTimes(2); expect(f.store.getTask('codex')?.processPresent).toBe(true);
  expect(f.store.getTask('codex')?.status).toBe('running');
  await f.host.setPaused(true); const calls = reader.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5000); expect(reader).toHaveBeenCalledTimes(calls);
  await f.host.setPaused(false); expect(start).toHaveBeenCalledTimes(3);
});
it('fresh presence check suppresses an exit error before the next poll; real failures remain', async () => {
  names = ['ChatGPT.exe']; const f = fixture(); await f.host.start();
  send({ kind: 'status', status: 'failed', message: 'real task failure', at: Date.now() }); await settle();
  expect(f.store.getTask('codex')?.status).toBe('failed');
  names = []; send({ kind: 'status', status: 'unknown', message: 'connection refused', at: Date.now() }); await settle();
  expect(reader).toHaveBeenLastCalledWith(true);
  expect(f.store.getTask('codex')).toMatchObject({ processPresent: false, status: 'idle', unread: false });
});
it('enumeration failure is not absence and cannot wash a real failure', async () => {
  names = ['ChatGPT.exe']; const f = fixture(); await f.host.start();
  send({ kind: 'status', status: 'failed', at: Date.now() }); await settle();
  reader.mockRejectedValue(new Error('tasklist permission denied'));
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.store.getTask('codex')).toMatchObject({ processPresent: true, status: 'failed' });
  expect(stop).not.toHaveBeenCalled(); expect(logger.warn).toHaveBeenCalled();
});
it('stop during initial process query prevents a late data source start', async () => {
  let resolve!: (value: string[]) => void;
  reader.mockImplementation(() => new Promise<string[]>(r => { resolve = r; }));
  const f = fixture(); const starting = f.host.start(); await settle();
  expect(reader).toHaveBeenCalled();
  const stopping = f.host.stopAll(); resolve(['ChatGPT.exe']);
  await Promise.all([starting, stopping]);
  expect(start).not.toHaveBeenCalled(); expect(f.host.activeCount).toBe(0);
});
it('changing process names restarts presence detection, while ordinary title changes do not', async () => {
  names = ['ChatGPT.exe']; const f = fixture(); await f.host.start();
  const next = { ...task(), jump: { terminal: { type: 'windowProcess' as const, processNames: ['Other.exe'] } } };
  expect(hashMonitorConfig(next)).not.toBe(hashMonitorConfig(task()));
  const config = { ...f.config, tasks: [next] }; f.store.syncTasks(config.tasks);
  expect((await f.host.reload(config)).restarted).toEqual(['codex']);
  expect(f.store.getTask('codex')?.processPresent).toBe(false);
  const renamed = { ...next, jump: { terminal: { ...next.jump.terminal, titleContains: 'new title' } } };
  expect(hashMonitorConfig(renamed)).toBe(hashMonitorConfig(next));
});
it('CLI source without a desktop process constraint is monitored without the presence gate', async () => {
  const t = task(); delete t.jump; const f = fixture(t); await f.host.start();
  expect(reader).not.toHaveBeenCalled(); expect(start).toHaveBeenCalledTimes(1);
});

it('initial enumeration failure is diagnostic unknown; recovery starts just one source', async () => {
  reader.mockRejectedValueOnce(new Error('timeout')); names = ['ChatGPT.exe'];
  const f = fixture(); await f.host.start();
  expect(f.store.getTask('codex')).toMatchObject({ status: 'unknown' });
  expect(f.store.getTask('codex')?.processPresent).toBeUndefined(); expect(start).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(start).toHaveBeenCalledTimes(1); expect(f.store.getTask('codex')?.status).toBe('running');
});
it('stop during source start waits for cleanup and ignores its late status', async () => {
  let resolve!: () => void;
  names = ['ChatGPT.exe']; start.mockImplementationOnce(async function (this: CodexMonitor) {
    const ctx = (this as unknown as { ctx: MonitorContext }).ctx;
    contexts.push(ctx); await new Promise<void>(r => { resolve = r; });
    ctx.sink(ctx.task.id, { kind: 'status', status: 'failed', at: Date.now() });
  });
  const f = fixture(); const starting = f.host.start(); await settle();
  expect(start).toHaveBeenCalledTimes(1);
  const stopping = f.host.stopAll(); resolve(); await Promise.all([starting, stopping]);
  expect(f.store.getTask('codex')?.status).toBe('idle'); expect(stop).toHaveBeenCalledTimes(1);
  expect(f.host.activeCount).toBe(0);
});
it('removing an absent task and reloading while paused creates no sources or timers', async () => {
  const f = fixture(); await f.host.start();
  await f.host.reload({ ...f.config, tasks: [] }); const count = reader.mock.calls.length;
  names = ['ChatGPT.exe']; await vi.advanceTimersByTimeAsync(2000); expect(reader).toHaveBeenCalledTimes(count);
  await f.host.setPaused(true); await f.host.reload(f.config);
  expect(start).not.toHaveBeenCalled(); expect(f.host.activeCount).toBe(0);
  await f.host.setPaused(false); expect(start).toHaveBeenCalledTimes(1);
});
