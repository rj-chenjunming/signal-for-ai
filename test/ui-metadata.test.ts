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

describe('SPEC-019 dsh Web 图标', () => {
  it('dsh 任务按配置的浏览器 URL 跳转字段使用 dsh-web，桌面 dsh 保持不变', () => {
    const configs: TaskConfig[] = [
      { id: 'local', name: 'dsh 本地', enabled: true, monitor: { type: 'dsh', authority: 'auto' }, jump: { cwd: '/fixture' } },
      { id: 'web', name: 'dsh web', enabled: true, monitor: { type: 'dsh', authority: '127.0.0.1:13080' }, jump: { cwd: '/fixture', openUrl: 'http://127.0.0.1:13080', openUrlViaExtension: true } },
      { id: 'web-title', name: 'dsh web title', enabled: true, monitor: { type: 'dsh', authority: '127.0.0.1:13080' }, jump: { openUrlTitleMatch: 'dsh' } },
      { id: 'codex', name: 'GPT', enabled: true, monitor: { type: 'codex' } },
    ];
    const store = new TaskStore(configs);
    expect(store.getTask('local')).toMatchObject({ toolKind: 'dsh' });
    expect(store.getTask('web')).toMatchObject({ toolKind: 'dsh-web' });
    expect(store.getTask('web-title')).toMatchObject({ toolKind: 'dsh-web' });
    expect(store.getTask('codex')).toMatchObject({ toolKind: 'codex' });
  });
  it('热重载在 dsh 与 dsh-web 之间同步图标，并保留运行与完成元数据', () => {
    const cfg: TaskConfig = { id: 'task', name: '工具', enabled: true, monitor: { type: 'dsh', authority: 'auto' }, jump: { cwd: '/fixture' } };
    const store = new TaskStore([cfg]);
    store.apply('task', { status: 'running' });
    store.apply('task', { status: 'success', completionAt: 456 });
    store.syncTasks([{ ...cfg, jump: { cwd: '/fixture', openUrl: 'http://127.0.0.1:13080' } }]);
    expect(store.getTask('task')).toMatchObject({ toolKind: 'dsh-web', status: 'success', lastCompletionAt: 456, unread: true });
    store.syncTasks([{ ...cfg, jump: { cwd: '/fixture' } }]);
    expect(store.getTask('task')).toMatchObject({ toolKind: 'dsh', status: 'success', lastCompletionAt: 456, unread: true });
  });
});
