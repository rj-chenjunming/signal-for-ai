import { spawnSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { FocusService, type ExecResult } from '../src/main/focus';
import { buildNativeWindowRevealScript, type NativeWindowApp } from '../src/main/native-window-reveal';
import type { TaskConfig } from '../src/shared/types';

const task: TaskConfig={id:'workbuddy',name:'WorkBuddy',enabled:true,
  monitor:{type:'webhook',listen:'127.0.0.1',path:'/hook/workbuddy'},
  jump:{terminal:{type:'windowProcess',processNames:['WorkBuddy.exe']}}};
const window={Id:15320,ProcessName:'WorkBuddy',MainWindowTitle:'WorkBuddy',MainWindowHandle:198210,
  ClassName:'Chrome_WidgetWin_1',Visible:false,Owner:0,ToolWindow:false,Width:1200,Height:800};
const ok=(stdout:string):ExecResult=>({ok:true,stdout,stderr:'',code:0});
function expectGuardedRestoreOnly(script:string):void{
  expect(script).not.toMatch(/AppActivate/u);
  expect([...script.matchAll(/::ShowWindow\(/gu)]).toHaveLength(1);
  expect(script).toMatch(/if \(\[LampNativeOwner\]::IsIconic\(\$nativeHandle\)\) \{\s*\[void\]\[LampNativeOwner\]::ShowWindow\(\$nativeHandle, 9\)\s*(?:Start-Sleep[^\n]*\n)?\s*\}/u);
  expect(script.indexOf('Start-Process')).toBeLessThan(script.indexOf('IsIconic($nativeHandle)'));
  expect(script.indexOf('IsIconic($nativeHandle)')).toBeLessThan(script.indexOf('::ShowWindow('));
  expect(script.indexOf('::ShowWindow(')).toBeLessThan(script.indexOf('LAMPWORKBUDDYREVEAL ok=True'));
}
function fixture(visible:boolean,reveal:ExecResult|Error=ok('LAMPWORKBUDDYREVEAL ok=True'),foreground=true,exists=true){
  const exec=vi.fn(async(_cmd:string,args:string[])=>{
    const script=args.at(-1)??'';
    if(script.includes('LAMPWORKBUDDYREVEAL')){if(reveal instanceof Error)throw reveal;return reveal;}
    if(script.includes('LampWindowDiscovery'))return ok(exists?JSON.stringify([window]):'[]');
    if(script.includes('LAMPVERIFY'))return ok(`LAMPVERIFY ok=${foreground?'True':'False'}`);
    if(script.includes('LAMPFOCUS'))return ok('LAMPFOCUS ok=True');
    return ok(visible&&exists?JSON.stringify(window):'[]');
  });
  const spawn=vi.fn(()=>true);
  return {service:new FocusService({spawner:{exec,spawn},tasks:()=>[task]}),exec,spawn};
}
it.each([true,false])('uses WorkBuddy own entry for the matching existing window (visible=%s)',async visible=>{
  const {service,exec,spawn}=fixture(visible);
  expect((await service.focusTerminal(task,task.jump)).ok).toBe(true);
  const script=exec.mock.calls.find(([,args])=>args.at(-1)?.includes('LAMPWORKBUDDYREVEAL'))?.[1].at(-1)??'';
  expect(script).toContain('GetWindowThreadProcessId');
  expect(script).toContain('WorkBuddy.exe');
  expect(script).toContain('[IntPtr]198210');
  expect(script).toContain('$ownerPid -ne 15320');
  expect(script.indexOf('$ownerPid -ne 15320')).toBeLessThan(script.indexOf('Start-Process'));
  expectGuardedRestoreOnly(script);
  expect(spawn).not.toHaveBeenCalled();
});
it('restores a still-minimized WorkBuddy window after the native handoff',async()=>{
  const {service,exec}=fixture(false);
  await service.focusTerminal(task,task.jump);
  const script=exec.mock.calls.find(([,args])=>args.at(-1)?.includes('LAMPWORKBUDDYREVEAL'))?.[1].at(-1)??'';
  expect(script).toContain('IsIconic($nativeHandle)');
  expect(script.indexOf('Start-Process')).toBeLessThan(script.indexOf('IsIconic($nativeHandle)'));
  expectGuardedRestoreOnly(script);
});
it.each([{ok:false,stdout:'',stderr:'timeout',code:null},ok('LAMPWORKBUDDYREVEAL ok=False'),new Error('blocked')])('fails closed for unavailable native reveal %#',async reveal=>{
  const {service,exec}=fixture(false,reveal);
  const result=await service.focusTerminal(task,task.jump);
  expect(result.ok).toBe(false);
  expect(result.detail).toContain('未能切回 WorkBuddy');
  const script=exec.mock.calls.find(([,args])=>args.at(-1)?.includes('LAMPWORKBUDDYREVEAL'))?.[1].at(-1)??'';
  expect(script.indexOf('::ShowWindow(')).toBeGreaterThan(script.indexOf('$relay.WaitForExit'));
});
it('requires foreground confirmation after the client exits',async()=>{
  const {service}=fixture(false,ok('LAMPWORKBUDDYREVEAL ok=True'),false);
  expect((await service.focusTerminal(task,task.jump)).ok).toBe(false);
});
it('does not launch WorkBuddy when no eligible existing window remains',async()=>{
  const {service,exec,spawn}=fixture(false,ok('LAMPWORKBUDDYREVEAL ok=True'),true,false);
  expect((await service.focusTerminal(task,task.jump)).ok).toBe(false);
  expect(exec.mock.calls.some(([,args])=>args.at(-1)?.includes('LAMPWORKBUDDYREVEAL'))).toBe(false);
  expect(spawn).not.toHaveBeenCalled();
});

it.each(['unknown','constructor','__proto__'])('rejects unknown native app identity %s',name=>{
  expect(()=>buildNativeWindowRevealScript(15320,198210,name as NativeWindowApp)).toThrow('Unsupported');
});
it.runIf(process.platform==='win32')('executes the real WorkBuddy stale-owner guard without launching a client',()=>{
  const child=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',buildNativeWindowRevealScript(process.pid,1,'workbuddy')],
    {windowsHide:true,encoding:'utf8',timeout:10000});
  expect(child.error).toBeUndefined();
  expect(child.status).not.toBe(0);
  expect(child.stderr).toContain('WorkBuddy window owner changed');
  expect(child.stdout).not.toContain('LAMPWORKBUDDYREVEAL ok=True');
},15000);
