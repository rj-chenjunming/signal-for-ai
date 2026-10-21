import { expect, it, vi } from 'vitest';
import { FocusService, type ExecResult } from '../src/main/focus';
import type { TaskConfig } from '../src/shared/types';

const task: TaskConfig = {
  id: 'dsh', name: 'dsh', enabled: true,
  monitor: { type: 'dsh', authority: 'auto' },
  jump: { terminal: { type: 'windowProcess', processNames: ['DeepSeek Harness.exe'] } },
};
const hidden = {
  Id: 34092, ProcessName: 'DeepSeek Harness', MainWindowHandle: 527050,
  MainWindowTitle: 'A task — DeepSeek Harness', ClassName: 'Chrome_WidgetWin_1',
  Visible: false, Owner: 0, ToolWindow: false, Width: 1296, Height: 828,
};
const ok = (stdout: string): ExecResult => ({ ok: true, stdout, stderr: '', code: 0 });
function fixture(discovery: ExecResult | Error = ok(JSON.stringify([hidden]))) {
  const exec = vi.fn(async (_command: string, args: string[]) => {
    const script = args.at(-1) ?? '';
    if (script.includes('LampWindowDiscovery')) {
      if (discovery instanceof Error) throw discovery;
      return discovery;
    }
    if (script.includes('LAMPDSHREVEAL')) return ok('LAMPDSHREVEAL ok=True');
    if (script.includes('LAMPWORKBUDDYREVEAL')) return ok('LAMPWORKBUDDYREVEAL ok=True');
    if (script.includes('LAMPVERIFY')) return ok('LAMPVERIFY ok=True');
    if (script.includes('LAMPFOCUS')) return ok('LAMPFOCUS ok=True');
    return ok('[]');
  });
  const spawn = vi.fn(() => true);
  const service = new FocusService({ spawner: { exec, spawn }, tasks: () => [task] });
  return { service, exec, spawn };
}

it('restores the unique hidden dsh main HWND when MainWindowHandle enumeration is empty', async () => {
  const { service, exec, spawn } = fixture();
  const result = await service.focusTerminal(task, task.jump);
  expect(result.ok).toBe(true);
  expect(exec.mock.calls.some(([, args]) => args.at(-1)?.includes('[IntPtr]527050'))).toBe(true);
  expect(spawn).not.toHaveBeenCalled();
});

it.each([
  { ProcessName: 'chrome' }, { Owner: 42 }, { ToolWindow: true },
  { ClassName: 'Chrome_WidgetWin_0' }, { MainWindowTitle: '' },
  { MainWindowTitle: 'unrelated helper' }, { Width: 0 }, { Height: -1 },
  { Id: -1 }, { Id: 1.5 }, { MainWindowHandle: 0 }, { MainWindowHandle: -2 },
  { MainWindowHandle: 2.5 }, { Visible: true },
])('rejects unsafe hidden candidate %j', async (patch) => {
  const { service, exec, spawn } = fixture(ok(JSON.stringify([{ ...hidden, ...patch }])));
  expect((await service.focusTerminal(task, task.jump)).ok).toBe(false);
  expect(exec.mock.calls.some(([, args]) => /LAMPFOCUS|LAMPDSHREVEAL/u.test(args.at(-1) ?? ''))).toBe(false);
  expect(spawn).not.toHaveBeenCalled();
});

it.each([
  ok('[]'), ok('{bad json'), ok(JSON.stringify([hidden, { ...hidden, MainWindowHandle: 527051 }])),
  { ok: false, stdout: JSON.stringify([hidden]), stderr: 'timeout', code: null }, new Error('blocked'),
])('fails closed for absent, ambiguous or unavailable hidden discovery %#', async (discovery) => {
  const { service, exec } = fixture(discovery);
  const result = await service.focusTerminal(task, task.jump);
  expect(result.ok).toBe(false);
  expect(result.detail).toContain('未找到 dsh 主窗口');
  expect(exec.mock.calls.some(([, args]) => /LAMPFOCUS|LAMPDSHREVEAL/u.test(args.at(-1) ?? ''))).toBe(false);
});

it('does not enumerate hidden windows for an unrestricted title-only target', async () => {
  const { service, exec } = fixture();
  await service.focusTerminal(task, { terminal: { type: 'windowTitle', match: 'DeepSeek' } });
  expect(exec.mock.calls.some(([, args]) => args.at(-1)?.includes('LampWindowDiscovery'))).toBe(false);
});

it('discovers a hidden window for a windowTitle target with processNames and uses the dsh entry', async () => {
  const titleTask: TaskConfig = {
    ...task,
    jump: { terminal: { type: 'windowTitle', match: 'DeepSeek Harness', processNames: ['DeepSeek Harness.exe'] } },
  };
  const { service, exec } = fixture();
  expect((await service.focusTerminal(titleTask, titleTask.jump)).ok).toBe(true);
  expect(exec.mock.calls.some(([, args]) => args.at(-1)?.includes('LampWindowDiscovery'))).toBe(true);
  const reveal = exec.mock.calls.find(([, args]) => args.at(-1)?.includes('LAMPDSHREVEAL'))?.[1].at(-1) ?? '';
  expect(reveal).toContain('[IntPtr]527050');
});

it('keeps Win32 activation for a non-native process discovered through a windowTitle target', async () => {
  const editorTask: TaskConfig = {
    id: 'editor', name: 'Editor', enabled: true,
    monitor: { type: 'webhook', listen: '127.0.0.1', path: '/hook/editor' },
    jump: { terminal: { type: 'windowTitle', match: 'Editor', processNames: ['ExampleEditor.exe'] } },
  };
  const discovery = ok(JSON.stringify([{ ...hidden, ProcessName: 'ExampleEditor', MainWindowTitle: 'Editor — workspace' }]));
  const { service, exec, spawn } = fixture(discovery);
  expect((await service.focusTerminal(editorTask, editorTask.jump)).ok).toBe(true);
  expect(exec.mock.calls.some(([, args]) => args.at(-1)?.includes('LampWindowDiscovery'))).toBe(true);
  const focus = exec.mock.calls.find(([, args]) => args.at(-1)?.includes('LAMPFOCUS'))?.[1].at(-1) ?? '';
  expect(focus).toContain('::ShowWindow');
  expect(exec.mock.calls.some(([, args]) => /LAMPDSHREVEAL|LAMPWORKBUDDYREVEAL/u.test(args.at(-1) ?? ''))).toBe(false);
  expect(spawn).not.toHaveBeenCalled();
});

it('keeps the native WorkBuddy route for a hidden windowTitle target', async () => {
  const wbTask: TaskConfig = {
    id: 'workbuddy', name: 'WorkBuddy', enabled: true,
    monitor: { type: 'webhook', listen: '127.0.0.1', path: '/hook/workbuddy' },
    jump: { terminal: { type: 'windowTitle', match: 'WorkBuddy', processNames: ['WorkBuddy.exe'] } },
  };
  const discovery = ok(JSON.stringify([{ ...hidden, ProcessName: 'WorkBuddy', MainWindowTitle: 'WorkBuddy' }]));
  const { service, exec } = fixture(discovery);
  expect((await service.focusTerminal(wbTask, wbTask.jump)).ok).toBe(true);
  expect(exec.mock.calls.some(([, args]) => args.at(-1)?.includes('LAMPWORKBUDDYREVEAL'))).toBe(true);
  expect(exec.mock.calls.some(([, args]) => args.at(-1)?.includes('LAMPDSHREVEAL'))).toBe(false);
});

it('keeps Win32 foreground recovery for a visible windowTitle dsh target', async () => {
  const titleTask: TaskConfig = {
    ...task,
    jump: { terminal: { type: 'windowTitle', match: 'DeepSeek Harness', processNames: ['DeepSeek Harness.exe'] } },
  };
  const visible = {
    Id: 34092, ProcessName: 'DeepSeek Harness', MainWindowTitle: 'A task — DeepSeek Harness',
    MainWindowHandle: 527050, ClassName: 'Chrome_WidgetWin_1', Visible: true, Owner: 0, ToolWindow: false, Width: 1200, Height: 800,
  };
  const exec = vi.fn(async (_command: string, args: string[]) => {
    const script = args.at(-1) ?? '';
    if (script.includes('LampWindowDiscovery')) return ok('[]');
    if (script.includes('LAMPDSHREVEAL')) return ok('LAMPDSHREVEAL ok=True');
    if (script.includes('LAMPFOCUS')) return ok('LAMPFOCUS ok=True');
    return ok(JSON.stringify([visible]));
  });
  const service = new FocusService({ spawner: { exec, spawn: vi.fn(() => true) }, tasks: () => [task] });
  expect((await service.focusTerminal(titleTask, titleTask.jump)).ok).toBe(true);
  expect(exec.mock.calls.some(([, args]) => args.at(-1)?.includes('LAMPFOCUS'))).toBe(true);
  expect(exec.mock.calls.some(([, args]) => args.at(-1)?.includes('LAMPDSHREVEAL'))).toBe(false);
});

it('honors case-insensitive configured process names and an explicit title filter', async () => {
  const { service } = fixture(ok(JSON.stringify([{ ...hidden, MainWindowTitle: 'Selected workspace' }])));
  expect((await service.focusTerminal(task, { terminal: { type: 'windowProcess',
    processNames: ['DEEPSEEK HARNESS.EXE'], titleContains: 'selected workspace' } })).ok).toBe(true);
  expect((await service.focusTerminal(task, { terminal: { type: 'windowProcess',
    processNames: ['DEEPSEEK HARNESS.EXE'], titleContains: 'different workspace' } })).ok).toBe(false);
});

it('keeps configured directory fallback when hidden lookup cannot find a window', async () => {
  const { service, spawn } = fixture(ok('[]'));
  const result = await service.focusTerminal(task, { ...task.jump, cwd: 'C:/test/project' });
  expect(result.ok).toBe(true);
  expect(result.detail).toContain('项目目录');
  expect(spawn).toHaveBeenCalledWith('explorer.exe', ['C:/test/project'], expect.any(Number));
});

it('requires foreground confirmation even after discovering the hidden main window', async () => {
  const exec = vi.fn(async (_command: string, args: string[]) => {
    const script = args.at(-1) ?? '';
    if (script.includes('LampWindowDiscovery')) return ok(JSON.stringify([hidden]));
    if (script.includes('LAMPDSHREVEAL')) return ok('LAMPDSHREVEAL ok=True');
    if (script.includes('LAMPVERIFY')) return ok('LAMPVERIFY ok=False');
    if (script.includes('LAMPFOCUS')) return ok('LAMPFOCUS ok=False');
    return ok('[]');
  });
  const service = new FocusService({ spawner: { exec, spawn: vi.fn(() => true) }, tasks: () => [task] });
  const result = await service.focusTerminal(task, task.jump);
  expect(result.ok).toBe(false);
  expect(result.detail).toContain('未能切回 dsh');
});

it('checks HWND ownership against the discovered PID before restoring it', async () => {
  const { service, exec } = fixture();
  await service.focusTerminal(task, task.jump);
  const script = exec.mock.calls.find(([, args]) => args.at(-1)?.includes('LAMPDSHREVEAL'))?.[1].at(-1) ?? '';
  expect(script).toContain('GetWindowThreadProcessId');
  expect(script).toContain('$ownerPid -ne 34092');
  expect(script.indexOf('$ownerPid -ne 34092')).toBeLessThan(script.indexOf('Start-Process'));
});

it('does not fall back to AppActivate when the hidden HWND was recycled to another PID', async () => {
  const exec = vi.fn(async (_command: string, args: string[]) => {
    const script = args.at(-1) ?? '';
    if (script.includes('LampWindowDiscovery')) return ok(JSON.stringify([hidden]));
    if (script.includes('LAMPDSHREVEAL')) return {ok:false,stdout:'',stderr:'dsh window owner changed',code:1};
    if (script.includes('LAMPFOCUS')) return ok('LAMPFOCUS stale=True');
    return ok('[]');
  });
  const service = new FocusService({ spawner: { exec, spawn: vi.fn(() => true) }, tasks: () => [task] });
  expect((await service.focusTerminal(task, task.jump)).ok).toBe(false);
  expect(exec.mock.calls.some(([, args]) => args.at(-1)?.includes('AppActivate'))).toBe(false);
});
