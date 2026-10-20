import { expect, it, vi } from 'vitest';
import { FocusService } from '../src/main/focus';
import type { SpawnExecutor } from '../src/main/focus';
import type { TaskConfig } from '../src/shared/types';
const task: TaskConfig = { id: 'dsh', name: 'dsh', enabled: true, monitor: { type: 'dsh', authority: 'auto' }, jump: { terminal: { type: 'windowProcess', processNames: ['DeepSeek Harness.exe'] } } };
const windowJson = (hwnd: number) => JSON.stringify({ Id: hwnd + 1, ProcessName: 'DeepSeek Harness', MainWindowTitle: 'DeepSeek Harness', MainWindowHandle: hwnd });
it('re-enumerates the live desktop target before activating a cached HWND', async () => {
  let hwnd = 100;
  const exec = vi.fn(async (_command: string, args: string[]) => {
    const script = args.join(' ');
    const stdout = script.includes('LAMPDSHREVEAL') ? 'LAMPDSHREVEAL ok=True' :
      script.includes('LAMPVERIFY') ? 'LAMPVERIFY ok=True' : script.includes('Get-Process') ? windowJson(hwnd) : 'LAMPFOCUS ok=True';
    return { ok: true, stdout, stderr: '', code: 0 };
  });
  const spawner: SpawnExecutor = { spawn: vi.fn(() => true), exec };
  const service = new FocusService({ spawner, tasks: () => [task] });
  await service.refreshWindows(); hwnd = 200; exec.mockClear();
  expect((await service.focusTerminal(task, task.jump)).ok).toBe(true);
  expect(exec.mock.calls[0][1].join(' ')).toContain('Get-Process');
  const activation = exec.mock.calls.find(([, args]) => args.join(' ').includes('LAMPDSHREVEAL'));
  expect(activation?.[1].join(' ')).toContain('[IntPtr]200');
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
