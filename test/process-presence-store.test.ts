import { expect, it } from 'vitest';
import { TaskStore } from '../src/main/store';
import { isTaskVisible } from '../src/shared/visibility';
import type { TaskConfig, TaskPatch } from '../src/shared/types';
const task: TaskConfig={id:'dsh',name:'dsh',enabled:true,monitor:{type:'dsh',authority:'auto'}};
// Additional runtime fields are structurally legal input before the contract is added.
const presencePatch=(present:boolean):TaskPatch & {processPresent:boolean}=>({status:'idle',message:'程序未运行，等待启动',processPresent:present});
it('confirmed absence clears an old failure and excludes the task from lights, counts and hidden errors',()=>{
  const store=new TaskStore([task]);store.apply('dsh',{status:'failed',message:'connection refused',error:'old'});
  store.apply('dsh',presencePatch(false));
  const state=store.getTask('dsh')!;const snap=store.getSnapshot();
  expect(isTaskVisible(state)).toBe(false);
  expect(state.unread).toBe(false);expect(state.error).toBeUndefined();
  expect(snap.aggregate).toBe('idle');expect(snap.displayTasks).toEqual([]);
  expect(snap.counts.idle).toBe(0);expect(snap.hiddenCount).toBe(0);expect(state.enabled).toBe(true);
});
it('closing suppresses old completion replay, but a new completion after reopening is valid',()=>{
  let now=1000;const store=new TaskStore([task],{now:()=>now});
  store.apply('dsh',{status:'success',completionAt:900});
  store.apply('dsh',presencePatch(false));now=1100;
  store.apply('dsh',{processPresent:true} as TaskPatch & {processPresent:boolean});
  store.apply('dsh',{status:'success',completionAt:900});
  expect(store.getTask('dsh')?.status).toBe('idle');
  store.apply('dsh',{status:'running'});store.apply('dsh',{status:'success',completionAt:1100});
  expect(store.getTask('dsh')?.status).toBe('success');
});
it('present metadata alone does not wash a real failure into success',()=>{
  const store=new TaskStore([task]);store.apply('dsh',{status:'failed'});
  store.apply('dsh',{processPresent:true} as TaskPatch & {processPresent:boolean});
  store.apply('dsh',{status:'success'});
  expect(store.getTask('dsh')?.status).toBe('failed');
});
