import { describe, expect, it } from 'vitest';
import { TaskStore } from '../src/main/store';
import type { TaskConfig } from '../src/shared/types';

const task: TaskConfig = { id: 'tool', name: '工具', enabled: true, monitor: { type: 'webhook', listen: '127.0.0.1', path: '/hook/tool' } };
function fixture() {
  let now = 1_000_000;
  const store = new TaskStore([task], { now: () => now, timeouts: { staleTimeoutMs: 1000 } });
  return { store, advance: (ms: number) => { now += ms; } };
}

describe('SPEC-002/AC-01 持续监控与连续任务', () => {
  it.each(['running', 'waiting'] as const)('相同 %s 信号续心跳但不重复广播', (status) => {
    const { store, advance } = fixture();
    store.apply('tool', { status, message: '仍在执行', isSignal: true });
    const version = store.getSnapshot().version;
    for (let i = 0; i < 4; i++) {
      advance(600);
      expect(store.apply('tool', { status, message: '仍在执行', isSignal: true })).toBeNull();
      store.tick();
      expect(store.getTask('tool')?.status).toBe(status);
    }
    expect(store.getSnapshot().version).toBe(version);
    advance(1001);
    store.tick();
    expect(store.getTask('tool')?.status).toBe('unknown');
  });

  it('非信号更新不能给任务续命', () => {
    const { store, advance } = fixture();
    store.apply('tool', { status: 'running', isSignal: true });
    advance(1100);
    store.apply('tool', { status: 'running', isSignal: false });
    store.tick();
    expect(store.getTask('tool')?.status).toBe('unknown');
  });

  it.each(['running', 'waiting'] as const)('上一轮完成后新 %s 信号立即生效', (status) => {
    const { store } = fixture();
    store.apply('tool', { status: 'success', completionAt: 100, isSignal: true });
    store.apply('tool', { status, isSignal: true });
    expect(store.getTask('tool')?.status).toBe(status);
  });

  it('未点击时连续完成，确认最新水位，旧完成不复亮', () => {
    const { store } = fixture();
    store.apply('tool', { status: 'success', completionAt: 100, isSignal: true });
    store.apply('tool', { status: 'success', completionAt: 200, isSignal: true });
    store.apply('tool', { status: 'success', completionAt: 150, isSignal: true });
    store.markRead('tool');
    expect(store.getTask('tool')?.ackedCompletionAt).toBe(200);
    expect(store.apply('tool', { status: 'success', completionAt: 200, isSignal: true })).toBeNull();
    expect(store.getTask('tool')?.status).toBe('idle');
  });

  it('初始采集失败可进入 unknown，不能仍显示空闲', () => {
    const { store } = fixture();
    store.apply('tool', { status: 'unknown', message: '数据源不可读', isSignal: true });
    expect(store.getTask('tool')?.status).toBe('unknown');
    expect(store.apply('tool', { status: 'success', isSignal: true })).toBeNull();
  });
});
