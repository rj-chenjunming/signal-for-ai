import { expect, it, vi } from 'vitest';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createPresenceReader, ProcessPresenceMonitor } from '../src/main/monitors/process-presence';
import { CodexMonitor } from '../src/main/monitors/codex';
import type { MonitorContext } from '../src/main/monitors/base';
import { compileRules } from '../src/main/monitors/pattern';
import { TaskStore } from '../src/main/store';
import type { TaskConfig } from '../src/shared/types';

it.skipIf(process.platform !== 'win32')('Windows real hidden process + real session IO: absent / running / exit / reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-signal-presence-'));
  const exe = join(dir, `ai-signal-fixture-${process.pid}.exe`);
  let child: ChildProcess | undefined;
  let monitor: ProcessPresenceMonitor | undefined;
  const stopChild = async () => {
    const old = child; child = undefined;
    if (old && old.exitCode === null && old.signalCode === null) {
      const exited = once(old, 'exit'); old.stdin!.end(); await exited;
    }
  };
  const startChild = async () => {
    child = spawn(exe, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0));console.log("ready")'],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    await once(child.stdout!, 'data');
  };
  try {
    await copyFile(process.execPath, exe);
    const task: TaskConfig = { id: 'fixture', name: 'Owned process IO fixture', enabled: true,
      monitor: { type: 'codex', sessionsDir: dir, activeWithinMs: 30000, intervalMs: 500 },
      jump: { terminal: { type: 'windowProcess', processNames: [basename(exe)] } } };
    const store = new TaskStore([task]);
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), logError: vi.fn() };
    const ctx: MonitorContext = { task, logger, rules: compileRules([]),
      timeouts: { startTimeoutMs: 5000, staleTimeoutMs: 30000, waitingTimeoutMs: 30000 },
      ackedCompletionAt: () => store.getTask(task.id)?.ackedCompletionAt ?? 0,
      sink: (id, event) => {
        if (event.kind === 'presence') store.apply(id, { processPresent: event.present,
          ...(!event.present ? { status: 'idle', message: '未运行，等待启动' } as const : {}) });
        else if (event.kind === 'status') store.apply(id, event);
      } };
    const reader = createPresenceReader();
    monitor = new ProcessPresenceMonitor(ctx, { names: [basename(exe)], reader: () => reader(true), intervalMs: 60000,
      source: sink => new CodexMonitor({ ...ctx, sink }, task.monitor as Extract<TaskConfig['monitor'], { type: 'codex' }>) });
    await monitor.start(); expect(store.getTask(task.id)?.processPresent).toBe(false);
    await startChild();
    const activity = () => JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 'owned-fixture' } }) + '\n';
    await writeFile(join(dir, 'rollout-live.jsonl'), activity());
    await monitor.pollOnce(); expect(store.getTask(task.id)).toMatchObject({ processPresent: true, status: 'running' });
    expect(monitor.hasActiveSource).toBe(true);
    await stopChild(); await monitor.pollOnce();
    expect(store.getTask(task.id)).toMatchObject({ processPresent: false, status: 'idle', unread: false });
    expect(store.getSnapshot().aggregate).toBe('idle'); expect(store.getSnapshot().displayTasks).toEqual([]);
    expect(monitor.hasActiveSource).toBe(false);
    await startChild(); await writeFile(join(dir, 'rollout-live.jsonl'), activity());
    await monitor.pollOnce(); expect(store.getTask(task.id)).toMatchObject({ processPresent: true, status: 'running' });
  } finally {
    await monitor?.stop(); await stopChild();
    const target = relative(tmpdir(), dir);
    if (!target || target.startsWith('..') || isAbsolute(target) || !basename(dir).startsWith('ai-signal-presence-')) throw new Error('Unsafe fixture cleanup path');
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);
