import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const helperPath=resolve('scripts/start-desktop.mjs');
const fixtures:string[]=[];
afterEach(()=>{for(const root of fixtures.splice(0)){
  if(!resolve(root).startsWith(resolve(tmpdir())+'\\')&&!resolve(root).startsWith(resolve(tmpdir())+'/'))throw new Error('Unexpected fixture path');
  rmSync(root,{recursive:true,force:true});
}});
async function setup(){
  const root=mkdtempSync(join(tmpdir(),'ai launch test-'));fixtures.push(root);
  const temporary=join(root,'temp');mkdirSync(temporary);
  const electron=join(root,'node_modules/electron');mkdirSync(join(electron,'dist'),{recursive:true});
  mkdirSync(join(root,'dist/main'),{recursive:true});
  mkdirSync(join(root,'dist/renderer'),{recursive:true});
  writeFileSync(join(root,'dist/main/index.js'),'fixture');
  writeFileSync(join(root,'dist/renderer/overlay.html'),'fixture');
  writeFileSync(join(root,'package.json'),'{}');
  writeFileSync(join(electron,'package.json'),JSON.stringify({version:'33.4.11',main:'index.js'}));
  writeFileSync(join(electron,'index.js'),"module.exports=require('node:path').join(__dirname,'dist','electron.exe');");
  writeFileSync(join(electron,'dist/electron.exe'),'fixture executable');
  writeFileSync(join(electron,'dist/version'),'33.4.11');
  writeFileSync(join(root,'config.desktop.example.yaml'),'tasks: []');
  const calls:Array<{bin:string,args:string[],env:Record<string,string>}>=[];
  const outputs:string[]=[];
  const run=(bin:string,args:string[],options:{env:Record<string,string>})=>{
    calls.push({bin,args,env:options.env});return {status:0};
  };
  const {runDesktopLaunch}=await import(helperPath);
  const options={root,tempDir:temporary,nodeVersion:'24.16.0',env:{ELECTRON_RUN_AS_NODE:'1'},args:[],run,log:(s:string)=>outputs.push(s),error:(s:string)=>outputs.push(s)};
  return {root,temporary,electron,calls,outputs,options,start:runDesktopLaunch};
}

it('provides the double-click entry and an importable desktop launch helper', () => {
  expect(existsSync(resolve('启动指示灯.cmd'))).toBe(true);
  expect(existsSync(resolve('scripts/start-desktop.mjs'))).toBe(true);
});

it('keeps existing config and invokes the existing start script with clean environment',async()=>{
  const f=await setup();writeFileSync(join(f.root,'config.local.yaml'),'personal config');
  expect(await f.start(f.options)).toBe(0);
  expect(readFileSync(join(f.root,'config.local.yaml'),'utf8')).toBe('personal config');
  const launched=f.calls.find(c=>c.args.includes(join(f.root,'scripts/start.mjs')));
  expect(launched?.args.slice(-2)).toEqual(['--config','./config.local.yaml']);
  expect(launched?.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
});

it('creates only a missing local config from the desktop template',async()=>{
  const f=await setup();expect(await f.start(f.options)).toBe(0);
  expect(readFileSync(join(f.root,'config.local.yaml'),'utf8')).toBe('tasks: []');
});

it('builds a missing dist before starting and preserves a build failure',async()=>{
  const f=await setup();rmSync(join(f.root,'dist'),{recursive:true});
  const buildRun=(bin:string,args:string[],options:{env:Record<string,string>})=>{
    if(args.includes('npm.cmd run build'))return {status:9};return f.options.run(bin,args,options);
  };
  expect(await f.start({...f.options,run:buildRun})).toBe(9);
  expect(f.calls.some(c=>c.args.includes(join(f.root,'scripts/start.mjs')))).toBe(false);
});

it('copies the same Electron version to temp when the bundled runtime cannot run, and reuses only intact copies',async()=>{
  const f=await setup();
  const probe=(bin:string,args:string[],options:{env:Record<string,string>})=>{
    if(args[0]==='--version'&&bin===join(f.electron,'dist/electron.exe'))return {status:1};
    return f.options.run(bin,args,options);
  };
  expect(await f.start({...f.options,run:probe,args:['--check']})).toBe(0);
  const receiptPath=join(f.root,'logs/desktop-runtime.json');
  const first=JSON.parse(readFileSync(receiptPath,'utf8')).runtimeDir as string;
  expect(first.startsWith(f.temporary)).toBe(true);
  expect(readFileSync(join(first,'electron.exe'),'utf8')).toBe('fixture executable');
  expect(await f.start({...f.options,run:probe,args:['--check']})).toBe(0);
  expect(JSON.parse(readFileSync(receiptPath,'utf8')).runtimeDir).toBe(first);
  writeFileSync(join(first,'electron.exe'),'changed');
  expect(await f.start({...f.options,run:probe,args:['--check']})).toBe(0);
  expect(JSON.parse(readFileSync(receiptPath,'utf8')).runtimeDir).not.toBe(first);
  expect(existsSync(join(f.root,'config.local.yaml'))).toBe(false);
});

it('fails clearly for old Node, missing dependencies, unknown arguments or unusable runtime',async()=>{
  const f=await setup();
  expect(await f.start({...f.options,nodeVersion:'20.0.0'})).toBe(1);
  expect(await f.start({...f.options,args:['--unknown']})).toBe(1);
  expect(await f.start({...f.options,run:()=>({status:null,error:new Error('blocked')})})).toBe(1);
  rmSync(join(f.root,'node_modules'),{recursive:true});
  expect(await f.start(f.options)).toBe(1);
});

it('preserves the real launcher exit code',async()=>{
  const f=await setup();
  expect(await f.start({...f.options,run:(bin:string,args:string[],options:{env:Record<string,string>})=>
    args.includes(join(f.root,'scripts/start.mjs'))?{status:7}:f.options.run(bin,args,options)})).toBe(7);
});

it('refuses a mismatched runtime version',async()=>{
  const f=await setup();
  writeFileSync(join(f.electron,'dist/version'),'32.0.0');
  expect(await f.start(f.options)).toBe(1);
});
it('refuses a zero-exit build with missing output',async()=>{
  const f=await setup();
  rmSync(join(f.root,'dist'),{recursive:true});
  expect(await f.start(f.options)).toBe(1);
  expect(f.calls.some(c=>c.args.includes(join(f.root,'scripts/start.mjs')))).toBe(false);
});

it.runIf(process.platform==='win32')('runs the actual cmd wrapper from another directory, including paths with spaces',async()=>{
  const f=await setup();mkdirSync(join(f.root,'scripts'));
  copyFileSync(resolve('启动指示灯.cmd'),join(f.root,'start.cmd'));
  writeFileSync(join(f.root,'scripts/start-desktop.mjs'),"import{writeFileSync}from'node:fs';writeFileSync('wrapper-proof.txt',process.cwd());");
  const child=spawnSync('cmd.exe',['/d','/c','call',`"${join(f.root,'start.cmd')}"`],
    {cwd:tmpdir(),encoding:'utf8',windowsHide:true,windowsVerbatimArguments:true,timeout:10000,input:'\r\n'});
  expect(child.error).toBeUndefined();
  expect(child.status,child.stderr).toBe(0);
  expect(readFileSync(join(f.root,'wrapper-proof.txt'),'utf8')).toBe(f.root);
},15000);
