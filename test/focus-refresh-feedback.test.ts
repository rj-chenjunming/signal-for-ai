import { expect, it, vi } from 'vitest';
import { FocusService } from '../src/main/focus';
import type { SpawnExecutor } from '../src/main/focus';
import type { TaskConfig } from '../src/shared/types';
const task: TaskConfig = { id: 'dsh', name: 'dsh', enabled: true, monitor: { type: 'dsh', authority: 'auto' }, jump: { terminal: { type: 'windowProcess', processNames: ['DeepSeek Harness.exe'] } } };
const windowJson = (hwnd: number) => JSON.stringify({ Id: hwnd + 1, ProcessName: 'DeepSeek Harness', MainWindowTitle: 'DeepSeek Harness', MainWindowHandle: hwnd });

it('SPEC-022: uses the cached HWND without re-enumerating', async () => {
  const exec = vi.fn(async (_command: string, args: string[]) => {
    const script = args.join(' ');
    const stdout = script.includes('LAMPDSHREVEAL') ? 'LAMPDSHREVEAL ok=True'
      : script.includes('Get-Process') ? windowJson(100) : 'LAMPFOCUS ok=True';
    return { ok: true, stdout, stderr: '', code: 0 };
  });
  const spawner: SpawnExecutor = { spawn: vi.fn(() => true), exec };
  const service = new FocusService({ spawner, tasks: () => [task] });
  await service.refreshWindows();
  exec.mockClear();

  expect((await service.focusTerminal(task, task.jump)).ok).toBe(true);
  const joined = exec.mock.calls.map(([, args]) => args.join(' '));
  expect(joined.some((s) => s.includes('Get-Process |'))).toBe(false);
  expect(joined.some((s) => s.includes('LAMPDSHREVEAL') && s.includes('[IntPtr]100'))).toBe(true);
});

it('SPEC-022: stale cached HWND refreshes once and retries the new HWND', async () => {
  let hwnd = 100;
  let revealCalls = 0;
  const exec = vi.fn(async (_command: string, args: string[]) => {
    const script = args.join(' ');
    if (script.includes('LAMPDSHREVEAL')) {
      revealCalls += 1;
      return { ok: true, stdout: `LAMPDSHREVEAL ok=${revealCalls > 1 ? 'True' : 'False'}`, stderr: '', code: 0 };
    }
    if (script.includes('Get-Process |')) {
      return { ok: true, stdout: windowJson(hwnd), stderr: '', code: 0 };
    }
    return { ok: true, stdout: 'LAMPFOCUS ok=True', stderr: '', code: 0 };
  });
  const spawner: SpawnExecutor = { spawn: vi.fn(() => true), exec };
  const service = new FocusService({ spawner, tasks: () => [task] });
  await service.refreshWindows(); // 缓存里是 100
  hwnd = 200; // 模拟应用已重启：下一次枚举得到新 HWND
  exec.mockClear();

  expect((await service.focusTerminal(task, task.jump)).ok).toBe(true);
  const enumerations = exec.mock.calls.filter(([, args]) => args.join(' ').includes('Get-Process |'));
  expect(enumerations).toHaveLength(1);
  const reveals = exec.mock.calls
    .filter(([, args]) => args.join(' ').includes('LAMPDSHREVEAL'))
    .map(([, args]) => args.join(' '));
  expect(reveals[0]).toContain('[IntPtr]100');
  expect(reveals[1]).toContain('[IntPtr]200');
});

it('missing dsh main window gets an actionable message, never fake directory setup', async () => {
  const spawn = vi.fn(() => true);
  const service = new FocusService({ spawner: { spawn, exec: async () => ({ ok: true, stdout: '[]', stderr: '', code: 0 }) }, tasks: () => [task] });
  const result = await service.focusTerminal(task, task.jump);
  expect(result.ok).toBe(false);
  expect(result.detail).toContain('未找到 dsh 主窗口');
  expect(result.detail).not.toMatch(/cwd|logFile/);
  expect(spawn).not.toHaveBeenCalled();
});
