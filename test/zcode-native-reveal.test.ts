import { expect, it, vi } from 'vitest';
import { FocusService, type ExecResult } from '../src/main/focus';
import { buildNativeWindowRevealScript } from '../src/main/native-window-reveal';
import type { TaskConfig } from '../src/shared/types';

const task: TaskConfig = { id: 'zcode', name: 'ZCode', enabled: true,
  monitor: { type: 'zcode', dbPath: 'C:/fixture/.zcode/cli/db/db.sqlite' },
  jump: { terminal: { type: 'windowProcess', processNames: ['ZCode.exe'] } } };
const hidden = { Id: 31188, ProcessName: 'ZCode', MainWindowTitle: 'ZCode',
  MainWindowHandle: 631912, ClassName: 'Chrome_WidgetWin_1', Visible: false, Owner: 0, ToolWindow: false, Width: 1400, Height: 900 };
const ok = (stdout: string): ExecResult => ({ ok: true, stdout, stderr: '', code: 0 });
function expectGuardedRestoreOnly(script: string): void {
  expect(script).not.toMatch(/AppActivate/u);
  expect([...script.matchAll(/::ShowWindow\(/gu)]).toHaveLength(1);
  expect(script).toMatch(/if \(\[LampNativeOwner\]::IsIconic\(\$nativeHandle\)\) \{\s*\[void\]\[LampNativeOwner\]::ShowWindow\(\$nativeHandle, 9\)\s*(?:Start-Sleep[^\n]*\n)?\s*\}/u);
  expect(script.indexOf('Start-Process')).toBeLessThan(script.indexOf('IsIconic($nativeHandle)'));
  expect(script.indexOf('IsIconic($nativeHandle)')).toBeLessThan(script.indexOf('::ShowWindow('));
  expect(script.indexOf('::ShowWindow(')).toBeLessThan(script.indexOf('LAMPZCODEREVEAL ok=True'));
}
function fixture(visible: boolean, reveal: ExecResult | Error = ok('LAMPZCODEREVEAL ok=True'), foreground = true) {
  const exec = vi.fn(async (_cmd: string, args: string[]) => {
    const script = args.at(-1) ?? '';
    if (script.includes('LAMPZCODEREVEAL')) { if (reveal instanceof Error) throw reveal; return reveal; }
    if (script.includes('LampWindowDiscovery')) return ok(JSON.stringify([hidden]));
    if (script.includes('LAMPVERIFY')) return ok(`LAMPVERIFY ok=${foreground ? 'True' : 'False'}`);
    if (script.includes('LAMPFOCUS')) return ok('LAMPFOCUS ok=True');
    return ok(visible ? JSON.stringify(hidden) : '[]');
  });
  const spawn = vi.fn(() => true);
  return { service: new FocusService({ spawner: { exec, spawn }, tasks: () => [task] }), exec, spawn };
}

it.each([false, true])('uses ZCode itself to reveal the existing main window (visible=%s)', async (visible) => {
  const { service, exec, spawn } = fixture(visible);
  expect((await service.focusTerminal(task, task.jump)).ok).toBe(true);
  expect(exec.mock.calls.some(([, args]) => args.at(-1)?.includes('LAMPZCODEREVEAL'))).toBe(true);
  // SPEC-022：前台确认并入原生恢复脚本，不再额外启动 LAMPVERIFY。
  expect(exec.mock.calls.some(([, args]) => args.at(-1)?.includes('LAMPVERIFY'))).toBe(false);
  const reveal = exec.mock.calls.find(([, args]) => args.at(-1)?.includes('LAMPZCODEREVEAL'))?.[1].at(-1) ?? '';
  expectGuardedRestoreOnly(reveal);
  expect(spawn).not.toHaveBeenCalled();
});

it('native reveal script confirms foreground before success marker', () => {
  const script = buildNativeWindowRevealScript(31188, 631912, 'zcode');
  expect(script).toContain('GetForegroundWindow');
  expect(script.indexOf('GetForegroundWindow')).toBeLessThan(script.indexOf('LAMPZCODEREVEAL ok=True'));
});

it('SPEC-042: native reveal never minimizes the ZCode window', () => {
  const script = buildNativeWindowRevealScript(31188, 631912, 'zcode');
  expect(script).not.toContain('ShowWindow($nativeHandle, 6)');
  expect(script).toContain('BringWindowToTop');
  expect(script).toContain('SetForegroundWindow');
  expect(script).toContain('ZCode.exe');
});

it('restores a still-minimized ZCode window after the native handoff', async () => {
  const { service, exec } = fixture(false);
  await service.focusTerminal(task, task.jump);
  const script = exec.mock.calls.find(([, args]) => args.at(-1)?.includes('LAMPZCODEREVEAL'))?.[1].at(-1) ?? '';
  expect(script).toContain('IsIconic($nativeHandle)');
  expectGuardedRestoreOnly(script);
});

it.each([
  { ok: false, stdout: '', stderr: 'timeout', code: null }, ok('LAMPZCODEREVEAL ok=False'), new Error('blocked'),
])('never force-shows ZCode after native reveal fails %#', async (reveal) => {
  const { service, exec } = fixture(false, reveal);
  expect((await service.focusTerminal(task, task.jump)).ok).toBe(false);
  const script = exec.mock.calls.find(([, args]) => args.at(-1)?.includes('LAMPZCODEREVEAL'))?.[1].at(-1) ?? '';
  // The guarded restore sits after the handoff checks, so a failed handoff never shows the window.
  expect(script.indexOf('::ShowWindow(')).toBeGreaterThan(script.indexOf('$relay.WaitForExit'));
});

it('does not report success without foreground confirmation', async () => {
  const { service } = fixture(false, ok('LAMPZCODEREVEAL ok=False'));
  expect((await service.focusTerminal(task, task.jump)).ok).toBe(false);
});

it('validates HWND ownership and reads the existing process executable before handoff', async () => {
  const { service, exec } = fixture(false);
  await service.focusTerminal(task, task.jump);
  const script = exec.mock.calls.find(([, args]) => args.at(-1)?.includes('LAMPZCODEREVEAL'))?.[1].at(-1) ?? '';
  expect(script).toContain('GetWindowThreadProcessId');
  expect(script).toContain('31188');
  expect(script).toContain('[IntPtr]631912');
  expect(script).toContain('ZCode.exe');
  expect(script).toContain('WaitForExit');
});
