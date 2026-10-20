import { describe, expect, it } from 'vitest';
import { TaskStore } from '../src/main/store';
import type { TaskConfig } from '../src/shared/types';

describe('SPEC-012 task presentation metadata', () => {
  it('识别三工具和通用图标，不将所有 SQLite 都当作 WorkBuddy', () => {
    const configs: TaskConfig[] = [
      { id: 'c', name: '编码', enabled: true, monitor: { type: 'codex' } },
      { id: 'd', name: '本地', enabled: true, monitor: { type: 'dsh', authority: 'auto' } },
      { id: 'workbuddy', name: 'WorkBuddy', enabled: true, monitor: { type: 'sqlite', database: '/fixture/db' } },
      { id: 'other', name: 'Other', enabled: true, monitor: { type: 'sqlite', database: '/fixture/db2' } },
    ];
    const store = new TaskStore(configs);
    for (const [taskId, toolKind] of [['c', 'codex'], ['d', 'dsh'], ['workbuddy', 'workbuddy'], ['other', 'generic']]) expect(store.getTask(taskId)).toMatchObject({ toolKind });
  });
  it('热重载更新图标/短标签/动作能力但保留运行与完成元数据', () => {
    const cfg: TaskConfig = { id: 'task', name: '工具', enabled: true, shortLabel: '旧名称', monitor: { type: 'codex' } };
    const store = new TaskStore([cfg]);
    store.apply('task', { status: 'running' }); store.apply('task', { status: 'success', completionAt: 123 });
    expect(store.getTask('task')).toMatchObject({ availableActions: ['focus_terminal', 'retry', 'mark_read'] });
    store.syncTasks([{ ...cfg, shortLabel: '新名称', monitor: { type: 'dsh', authority: 'auto' }, jump: { cwd: '/fixture', logFile: '/fixture/log' } }]);
    expect(store.getTask('task')).toMatchObject({ toolKind: 'dsh', portLabel: '新名称', status: 'success', lastCompletionAt: 123, unread: true, availableActions: ['focus_terminal', 'open_log', 'open_dir', 'retry', 'mark_read'] });
  });
});
