/**
 * SPEC-036：常驻 PowerShell 焦点 worker（激活路径）。
 *
 * 批次 1（本批次）：FocusService 集成——在现有 focus.ts 上先写目标行为
 * （worker 优先 / stale 语义保持 / 失败回落），未实现前应因行为缺失而失败（Red）。
 * 批次 2（manager 实现后追加）：协议/生命周期单测 + 真实 PowerShell ping。
 */

import { expect, it, vi } from 'vitest';
import { FocusService } from '../src/main/focus';
import type { SpawnExecutor } from '../src/main/focus';
import type { TaskConfig } from '../src/shared/types';

// 非 dsh/workbuddy 的 windowProcess 目标 → 走 focusExistingWindow → activateViaWin32
// （LampFocus 脚本路径），不触发 native-window-reveal。
const task: TaskConfig = {
  id: 'app',
  name: 'App',
  enabled: true,
  monitor: { type: 'webhook', listen: '127.0.0.1', path: '/fixture' },
  jump: { terminal: { type: 'windowProcess', processNames: ['MyApp'] } },
};
const windowJson = (hwnd: number) =>
  JSON.stringify({ Id: hwnd + 1, ProcessName: 'MyApp', MainWindowTitle: 'MyApp', MainWindowHandle: hwnd });

function makeExec(activateStdout = 'LAMPFOCUS ok=True') {
  return vi.fn(async (_command: string, args: string[]) => {
    const script = args.join(' ');
    if (script.includes('Get-Process |')) {
      return { ok: true, stdout: windowJson(100), stderr: '', code: 0 };
    }
    return { ok: true, stdout: activateStdout, stderr: '', code: 0 };
  });
}

it('SPEC-036/AC-01: activateViaWin32 优先走常驻 worker，不再冷编译 Add-Type', async () => {
  // SPEC-037 起，同一条链路里枚举/隐藏也走 worker，mock 必须按 op 分发。
  const worker = { exec: vi.fn(async (op: string, _params: Record<string, unknown>) => {
    if (op === 'enumerate') return { ok: true, detail: windowJson(100) };
    if (op === 'activate') return { ok: true, detail: 'ok' };
    return { ok: false, detail: 'unknown op' };
  }) };
  const exec = makeExec();
  const spawner: SpawnExecutor = { spawn: vi.fn(() => true), exec };
  const service = new FocusService({ spawner, focusWorker: worker, tasks: () => [task] });

  const result = await service.focusTerminal(task, task.jump);

  expect(result.ok).toBe(true);
  const ops = worker.exec.mock.calls.map(([o]) => o);
  expect(ops).toContain('enumerate');
  expect(ops).toContain('activate');
  const activateCall = worker.exec.mock.calls.find(([o]) => o === 'activate')!;
  expect(activateCall[1]).toMatchObject({ hwnd: 100, pid: 101 });
  // 激活不再经 spawn 路径（LampFocus 脚本 = 每次冷启动 + Add-Type 编译）。
  const activateExecs = exec.mock.calls.filter(([, a]) => a.join(' ').includes('LAMPFOCUS'));
  expect(activateExecs).toHaveLength(0);
});

it('SPEC-036/AC-02: worker 返回 stale window 时保持既有语义（不重试 AppActivate）', async () => {
  const worker = { exec: vi.fn(async (op: string) => {
    if (op === 'enumerate') return { ok: true, detail: windowJson(100) };
    if (op === 'activate') return { ok: false, detail: 'stale window' };
    return { ok: false, detail: 'unknown op' };
  }) };
  const exec = makeExec();
  const spawner: SpawnExecutor = { spawn: vi.fn(() => true), exec };
  const service = new FocusService({ spawner, focusWorker: worker, tasks: () => [task] });

  const result = await service.focusTerminal(task, task.jump);

  expect(result.ok).toBe(false);
  expect(worker.exec.mock.calls.filter(([o]) => o === 'activate')).toHaveLength(1);
  const appActivate = exec.mock.calls.filter(([, a]) => a.join(' ').includes('AppActivate'));
  expect(appActivate).toHaveLength(0);
});

it('SPEC-036/AC-03: worker 失败回落按次 spawn，成功语义不变', async () => {
  const worker = { exec: vi.fn(async () => { throw new Error('worker exited'); }) };
  const exec = makeExec('LAMPFOCUS ok=True');
  const spawner: SpawnExecutor = { spawn: vi.fn(() => true), exec };
  const service = new FocusService({ spawner, focusWorker: worker, tasks: () => [task] });

  const result = await service.focusTerminal(task, task.jump);

  expect(result.ok).toBe(true);
  // 枚举 + 激活各回落一次（SPEC-037 起枚举也走 worker）。
  expect(worker.exec).toHaveBeenCalledTimes(2);
  const activateExecs = exec.mock.calls.filter(([, a]) => a.join(' ').includes('LAMPFOCUS'));
  expect(activateExecs).toHaveLength(1);
});

/* ============================================================================
 * 批次 2：manager 协议与生命周期（注入假流，确定性）
 * ==========================================================================*/

import { EventEmitter } from 'node:events';
import { FocusWorkerManager } from '../src/main/focus-worker';
import type { ChildProcess } from 'node:child_process';

type FakeChild = Omit<ChildProcess, 'killed' | 'kill' | 'stdin' | 'stdout' | 'stderr'> & {
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = { write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => { cb?.(null); return true; }), end: vi.fn() };
  const out = new EventEmitter() as FakeChild['stdout'];
  out.setEncoding = vi.fn();
  child.stdout = out;
  const err = new EventEmitter() as FakeChild['stderr'];
  err.setEncoding = vi.fn();
  child.stderr = err;
  // ChildProcess.killed 在类型上是只读，测试里需要可写以模拟 kill 效果。
  (child as { killed: boolean }).killed = false;
  child.kill = vi.fn(() => { child.killed = true; return true; });
  return child;
}

const waitUntil = async (predicate: () => boolean, timeoutMs = 1000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil 超时');
    await new Promise((resolve) => setImmediate(resolve));
  }
};

interface Harness { manager: FocusWorkerManager; children: FakeChild[]; lastChild: () => FakeChild }

function makeManager(managerOptions: Record<string, unknown> = {}): Harness {
  const children: FakeChild[] = [];
  const manager = new FocusWorkerManager({
    spawnFactory: () => { const c = fakeChild(); children.push(c); return c as unknown as ChildProcess; },
    requestTimeoutMs: 80,
    startTimeoutMs: 400,
    ...managerOptions,
  } as never);
  return { manager, children, lastChild: () => children[children.length - 1]! };
}

async function respondPing(h: Harness): Promise<void> {
  await waitUntil(() => h.lastChild().stdin.write.mock.calls.length >= 1);
  const ping = JSON.parse(h.lastChild().stdin.write.mock.calls[0]![0] as string);
  h.lastChild().stdout.emit('data', `${JSON.stringify({ id: ping.id, ok: true, detail: 'pong' })}\n`);
}

it('SPEC-036: 协议按 id 匹配响应，坏行与陌生 id 被丢弃', async () => {
  const h = makeManager();
  const pending = h.manager.exec('activate', { hwnd: 7, pid: 8 });
  await respondPing(h);
  await waitUntil(() => h.lastChild().stdin.write.mock.calls.length >= 2);
  const request = JSON.parse(h.lastChild().stdin.write.mock.calls[1]![0] as string);
  expect(request).toMatchObject({ op: 'activate', hwnd: 7, pid: 8 });
  h.lastChild().stdout.emit('data', '不是 JSON 的一行\n');
  h.lastChild().stdout.emit('data', `${JSON.stringify({ id: request.id + 99, ok: true, detail: 'wrong' })}\n`);
  h.lastChild().stdout.emit('data', `${JSON.stringify({ id: request.id, ok: true, detail: 'ok title=MyApp' })}\n`);
  await expect(pending).resolves.toEqual({ ok: true, detail: 'ok title=MyApp' });
});

it('SPEC-036/AC-05: 请求超时拒绝并失效；下一次调用重启一次并成功', async () => {
  const h = makeManager();
  const first = h.manager.exec('activate', { hwnd: 7, pid: 8 });
  await respondPing(h);
  await waitUntil(() => h.lastChild().stdin.write.mock.calls.length >= 2);
  // 故意不回激活响应 → 超时
  await expect(first).rejects.toThrow('超时');
  expect(h.lastChild().kill).toHaveBeenCalled();

  const second = h.manager.exec('activate', { hwnd: 7, pid: 8 });
  await respondPing(h);
  await waitUntil(() => h.lastChild().stdin.write.mock.calls.length >= 2);
  const request = JSON.parse(h.lastChild().stdin.write.mock.calls[1]![0] as string);
  h.lastChild().stdout.emit('data', `${JSON.stringify({ id: request.id, ok: true, detail: 'ok' })}\n`);
  await expect(second).resolves.toEqual({ ok: true, detail: 'ok' });
  expect(h.children).toHaveLength(2);
});

it('SPEC-036/AC-04: worker 进程退出使在途请求拒绝，下一次调用自动重启', async () => {
  const h = makeManager();
  const first = h.manager.exec('activate', { hwnd: 7, pid: 8 });
  await respondPing(h);
  await waitUntil(() => h.lastChild().stdin.write.mock.calls.length >= 2);
  h.lastChild().emit('exit', 1);
  await expect(first).rejects.toThrow();

  const second = h.manager.exec('activate', { hwnd: 7, pid: 8 });
  await respondPing(h);
  await waitUntil(() => h.lastChild().stdin.write.mock.calls.length >= 2);
  const request = JSON.parse(h.lastChild().stdin.write.mock.calls[1]![0] as string);
  h.lastChild().stdout.emit('data', `${JSON.stringify({ id: request.id, ok: false, detail: 'not foreground title=x' })}\n`);
  await expect(second).resolves.toEqual({ ok: false, detail: 'not foreground title=x' });
  expect(h.children).toHaveLength(2);
});

it('SPEC-036/AC-06: 真实 PowerShell worker ping（真实进程，Add-Type 编译 + stdio 往返）', async () => {
  if (process.platform !== 'win32') {
    return; // 仅 Windows 语义
  }
  const manager = new FocusWorkerManager({ startTimeoutMs: 30000, logger: { info: () => undefined, warn: () => undefined } });
  try {
    const pong = await manager.exec('ping', {});
    expect(pong.ok).toBe(true);
    expect(pong.detail).toBe('pong');
  } finally {
    manager.kill();
  }
}, 45000);

/* ============================================================================
 * 批次 3（SPEC-037）：枚举 / 隐藏查询 / 原生恢复迁入 worker
 * ==========================================================================*/

const dshTask: TaskConfig = {
  id: 'dsh',
  name: 'dsh',
  enabled: true,
  monitor: { type: 'dsh', authority: 'manual' },
  jump: { terminal: { type: 'windowProcess', processNames: ['DeepSeek Harness'] } },
};
const dshWindowJson = (hwnd: number) =>
  JSON.stringify({ Id: hwnd + 1, ProcessName: 'DeepSeek Harness', MainWindowTitle: 'DeepSeek Harness', MainWindowHandle: hwnd });
const hiddenRowJson = JSON.stringify({
  Id: 101, ProcessName: 'MyApp', MainWindowHandle: 555, MainWindowTitle: 'myapp hidden host',
  ClassName: 'Chrome_WidgetWin_1', Visible: false, Owner: 0, ToolWindow: false, Width: 800, Height: 600,
});
const hiddenTask: TaskConfig = {
  id: 'app',
  name: 'App',
  enabled: true,
  monitor: { type: 'webhook', listen: '127.0.0.1', path: '/fixture' },
  jump: { terminal: { type: 'windowProcess', processNames: ['MyApp'], titleContains: 'myapp hidden host' } },
};

it('SPEC-037/AC-01: refreshWindows 优先 worker 枚举，不再按次 spawn Get-Process', async () => {
  const worker = { exec: vi.fn(async (op: string, _params: Record<string, unknown>) => op === 'enumerate' ? { ok: true, detail: windowJson(100) } : { ok: false, detail: 'unknown op' }) };
  const exec = vi.fn(async (_command: string, _args: string[]) => ({ ok: true, stdout: '[]', stderr: '', code: 0 }));
  const service = new FocusService({ spawner: { spawn: vi.fn(() => true), exec }, focusWorker: worker, tasks: () => [task] });

  const windows = await service.refreshWindows();

  expect(windows).toHaveLength(1);
  expect(windows[0]).toMatchObject({ pid: 101, hwnd: 100, processName: 'MyApp' });
  expect(worker.exec).toHaveBeenCalledWith('enumerate', {});
  expect(exec.mock.calls.filter(([, a]) => a.join(' ').includes('Get-Process |'))).toHaveLength(0);
});

it('SPEC-037/AC-02: findHiddenWindow 优先 worker，fail-closed 解析共享同一实现', async () => {
  const worker = { exec: vi.fn(async (op: string, _params: Record<string, unknown>) => {
    if (op === 'enumerate') return { ok: true, detail: '[]' };
    if (op === 'hidden') return { ok: true, detail: hiddenRowJson };
    if (op === 'activate') return { ok: true, detail: 'ok' };
    return { ok: false, detail: 'unknown op' };
  }) };
  const exec = vi.fn(async (_command: string, _args: string[]) => ({ ok: true, stdout: '[]', stderr: '', code: 0 }));
  const service = new FocusService({ spawner: { spawn: vi.fn(() => true), exec }, focusWorker: worker, tasks: () => [hiddenTask] });

  const result = await service.focusTerminal(hiddenTask, hiddenTask.jump);

  expect(result.ok).toBe(true);
  const ops = worker.exec.mock.calls.map(([op]) => op);
  expect(ops).toContain('hidden');
  expect(ops).toContain('activate');
  expect(exec.mock.calls.filter(([, a]) => a.join(' ').includes('FromBase64String'))).toHaveLength(0);
  expect(exec.mock.calls.filter(([, a]) => a.join(' ').includes('Get-Process |'))).toHaveLength(0);
});

it('SPEC-037/AC-03: revealNativeWindow 优先 worker，成功判据仍为 marker', async () => {
  const worker = { exec: vi.fn(async (op: string, _params: Record<string, unknown>) => {
    if (op === 'enumerate') return { ok: true, detail: dshWindowJson(100) };
    if (op === 'reveal') return { ok: true, detail: 'LAMPDSHREVEAL ok=True' };
    return { ok: false, detail: 'unknown op' };
  }) };
  const exec = vi.fn(async (_command: string, _args: string[]) => ({ ok: true, stdout: '', stderr: '', code: 0 }));
  const service = new FocusService({ spawner: { spawn: vi.fn(() => true), exec }, focusWorker: worker, tasks: () => [dshTask] });

  const result = await service.focusTerminal(dshTask, dshTask.jump);

  expect(result.ok).toBe(true);
  expect(worker.exec).toHaveBeenCalledWith('reveal', expect.objectContaining({ hwnd: 100, pid: 101, app: 'dsh' }));
  expect(exec.mock.calls.filter(([, a]) => a.join(' ').includes('LAMPDSHREVEAL'))).toHaveLength(0);
});

it('SPEC-037/AC-04: worker 不可用时三个路径各自回落按次 spawn', async () => {
  const worker = { exec: vi.fn(async () => { throw new Error('worker exited'); }) };
  const exec = vi.fn(async (_c: string, args: string[]) => {
    const script = args.join(' ');
    if (script.includes('Get-Process |')) return { ok: true, stdout: dshWindowJson(100), stderr: '', code: 0 };
    if (script.includes('LAMPDSHREVEAL')) return { ok: true, stdout: 'LAMPDSHREVEAL ok=True', stderr: '', code: 0 };
    if (script.includes('Get-Process')) return { ok: true, stdout: '[]', stderr: '', code: 0 };
    return { ok: true, stdout: 'LAMPFOCUS ok=True', stderr: '', code: 0 };
  });
  const service = new FocusService({ spawner: { spawn: vi.fn(() => true), exec }, focusWorker: worker, tasks: () => [dshTask] });

  const windows = await service.refreshWindows();
  expect(windows).toHaveLength(1);
  const result = await service.focusTerminal(dshTask, dshTask.jump);
  expect(result.ok).toBe(true);
  expect(exec.mock.calls.filter(([, a]) => a.join(' ').includes('LAMPDSHREVEAL'))).toHaveLength(1);
  expect(exec.mock.calls.filter(([, a]) => a.join(' ').includes('Get-Process |'))).toHaveLength(1);
});

it('SPEC-037/AC-05: manager 写入侧把非 ASCII 参数转义为 Unicode 转义序列（stdin 解码安全）', async () => {
  const h = makeManager();
  const pending = h.manager.exec('hidden', { names: ['中文进程'] });
  await respondPing(h);
  await waitUntil(() => h.lastChild().stdin.write.mock.calls.length >= 2);
  const line = h.lastChild().stdin.write.mock.calls[1]![0] as string;
  // 整行必须可安全地按 ASCII 解码：非 ASCII 一律写成反斜杠 u + 四位十六进制
  expect(line).toContain('\\u4e2d\\u6587');
  expect(Array.from(line).every((ch) => ch.charCodeAt(0) <= 0x7f)).toBe(true);
  const request = JSON.parse(line);
  expect(request.op).toBe('hidden');
  h.lastChild().stdout.emit('data', `${JSON.stringify({ id: request.id, ok: true, detail: '[]' })}\n`);
  await expect(pending).resolves.toEqual({ ok: true, detail: '[]' });
});

it('SPEC-037: 真实 worker 的 enumerate 与 hidden（只读，真实进程）', async () => {
  if (process.platform !== 'win32') {
    return;
  }
  const manager = new FocusWorkerManager({
    startTimeoutMs: 30000, requestTimeoutMs: 15000,
    logger: { info: () => undefined, warn: () => undefined },
  });
  try {
    const enumerated = await manager.exec('enumerate', {});
    expect(enumerated.ok).toBe(true);
    const parsed: unknown = JSON.parse(enumerated.detail);
    expect(Array.isArray(parsed) || typeof parsed === 'object').toBe(true);
    const hidden = await manager.exec('hidden', { names: ['no-such-process-xyz'] });
    expect(hidden.ok).toBe(true);
    expect(JSON.parse(hidden.detail)).toEqual([]);
  } finally {
    manager.kill();
  }
}, 60000);
