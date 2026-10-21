import { spawnSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { FocusService, type ExecResult } from '../src/main/focus';
import { buildDshNativeRevealScript } from '../src/main/dsh-native-reveal';
import type { TaskConfig } from '../src/shared/types';

const task: TaskConfig = { id: 'dsh', name: 'dsh', enabled: true,
  monitor: { type: 'dsh', authority: 'auto' },
  jump: { terminal: { type: 'windowProcess', processNames: ['DeepSeek Harness.exe'] } } };
const hidden = { Id: 34092, ProcessName: 'DeepSeek Harness', MainWindowTitle: 'A task — DeepSeek Harness',
  MainWindowHandle: 527050, ClassName: 'Chrome_WidgetWin_1', Visible: false, Owner: 0, ToolWindow: false, Width: 1200, Height: 800 };
const ok = (stdout: string): ExecResult => ({ ok: true, stdout, stderr: '', code: 0 });
function fixture(visible: boolean, reveal: ExecResult | Error = ok('LAMPDSHREVEAL ok=True'), foreground = true) {
  const exec = vi.fn(async (_cmd: string, args: string[]) => {
    const script = args.at(-1) ?? '';
    if (script.includes('LAMPDSHREVEAL')) { if(reveal instanceof Error) throw reveal; return reveal; }
    if (script.includes('LampWindowDiscovery')) return ok(JSON.stringify([hidden]));
    if (script.includes('LAMPVERIFY')) return ok(`LAMPVERIFY ok=${foreground ? 'True' : 'False'}`);
    if (script.includes('LAMPFOCUS')) return ok('LAMPFOCUS ok=True');
    return ok(visible ? JSON.stringify(hidden) : '[]');
  });
  const spawn = vi.fn(() => true);
  return { service: new FocusService({ spawner: { exec, spawn }, tasks: () => [task] }), exec, spawn };
}

it.each([false, true])('uses dsh itself to reveal the existing main window (visible=%s)', async (visible) => {
  const { service, exec, spawn } = fixture(visible);
  expect((await service.focusTerminal(task, task.jump)).ok).toBe(true);
  expect(exec.mock.calls.some(([,args])=>args.at(-1)?.includes('LAMPDSHREVEAL'))).toBe(true);
  expect(exec.mock.calls.some(([,args])=>/::ShowWindow|AppActivate/u.test(args.at(-1) ?? ''))).toBe(false);
  expect(spawn).not.toHaveBeenCalled();
});

it.each([
  {ok:false,stdout:'',stderr:'timeout',code:null}, ok('LAMPDSHREVEAL ok=False'), new Error('blocked'),
])('never force-shows dsh after native reveal fails %#', async (reveal) => {
  const {service,exec}=fixture(false,reveal);
  expect((await service.focusTerminal(task,task.jump)).ok).toBe(false);
  expect(exec.mock.calls.some(([,args])=>/::ShowWindow|AppActivate/u.test(args.at(-1) ?? ''))).toBe(false);
});

it('does not report success without foreground confirmation', async () => {
  const {service}=fixture(false,ok('LAMPDSHREVEAL ok=True'),false);
  expect((await service.focusTerminal(task,task.jump)).ok).toBe(false);
});

it('validates HWND ownership and reads the existing process executable before handoff', async () => {
  const {service,exec}=fixture(false);
  await service.focusTerminal(task,task.jump);
  const script=exec.mock.calls.find(([,args])=>args.at(-1)?.includes('LAMPDSHREVEAL'))?.[1].at(-1) ?? '';
  expect(script).toContain('GetWindowThreadProcessId');
  expect(script).toContain('34092');
  expect(script).toContain('[IntPtr]527050');
  expect(script).toContain('DeepSeek Harness.exe');
  expect(script).toContain('WaitForExit');
});

it('keeps Win32 focus and PID guards for other desktop tools', async () => {
  const other: TaskConfig = { ...task, monitor: {type:'webhook',listen:'127.0.0.1',path:'/hook'},
    jump:{terminal:{type:'windowProcess',processNames:['ExampleEditor.exe']}} };
  const exec=vi.fn(async (_cmd:string,args:string[])=>ok(args.at(-1)?.includes('LAMPFOCUS') ? 'LAMPFOCUS ok=True' :
    JSON.stringify({...hidden,ProcessName:'ExampleEditor',MainWindowTitle:'ExampleEditor'})));
  const service=new FocusService({spawner:{exec,spawn:vi.fn(()=>true)},tasks:()=>[other]});
  expect((await service.focusTerminal(other,other.jump)).ok).toBe(true);
  const activation=exec.mock.calls.find(([,args])=>args.at(-1)?.includes('LAMPFOCUS'))?.[1].at(-1) ?? '';
  expect(activation).toContain('GetWindowThreadProcessId');
  expect(activation).toContain('$ownerPid -ne 34092');
  expect(activation).toContain('::ShowWindow');
  expect(exec.mock.calls.some(([,args])=>args.at(-1)?.includes('LAMPDSHREVEAL'))).toBe(false);
});

it.each([0,-1,1.5,Number.NaN,Number.MAX_SAFE_INTEGER+1])('rejects invalid identity %s before building a command', value=>{
  expect(()=>buildDshNativeRevealScript(value,527050)).toThrow('Invalid');
  expect(()=>buildDshNativeRevealScript(34092,value)).toThrow('Invalid');
});

it.runIf(process.platform==='win32')('executes the real stale-owner guard without launching dsh',()=>{
  const child=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',buildDshNativeRevealScript(process.pid,1)],
    {windowsHide:true,encoding:'utf8',timeout:10000});
  expect(child.error).toBeUndefined();
  expect(child.status).not.toBe(0);
  expect(child.stderr).toContain('dsh window owner changed');
  expect(child.stdout).not.toContain('LAMPDSHREVEAL ok=True');
},15000);
