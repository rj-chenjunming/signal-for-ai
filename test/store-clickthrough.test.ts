/**
 * D10「锁定/穿透」的 store 层测试。
 *
 * 这个开关有三处必须同步（store 快照字段 / overlay 真实行为 / 配置文件），
 * store 这一处最容易漏 —— 漏了的表现是「托盘菜单勾了，但窗口没锁」
 * 或反过来「窗口锁了，菜单没勾」，都很难查。
 */

import { describe, expect, it } from 'vitest';
import { TaskStore } from '../src/main/store';
import type { AppConfig, TaskConfig } from '../src/shared/types';
import { DEFAULT_APP_SETTINGS, DEFAULT_LAMP_SETTINGS, DEFAULT_NOTIFY_SETTINGS, DEFAULT_STATE_TIMEOUT, DEFAULT_COLOR_OVERRIDES } from '../src/shared/constants';

const opts = { logger: { warn: () => undefined, error: () => undefined } };

function dshTask(id: string, authority: string): TaskConfig {
  return { id, name: `dsh ${authority}`, enabled: true, monitor: { type: 'dsh', authority } };
}

function appConfig(clickThrough: boolean): AppConfig {
  return {
    app: { ...DEFAULT_APP_SETTINGS },
    lamp: { ...DEFAULT_LAMP_SETTINGS, clickThrough },
    notify: { ...DEFAULT_NOTIFY_SETTINGS },
    defaults: { stateTimeout: { ...DEFAULT_STATE_TIMEOUT }, colors: { ...DEFAULT_COLOR_OVERRIDES } },
    tasks: [dshTask('a', '127.0.0.1:3080')],
  } as AppConfig;
}

describe('Snapshot.clickThrough —— D10 开关的状态来源', () => {
  it('默认 false（不锁，可点击）', () => {
    const store = new TaskStore([dshTask('a', '127.0.0.1:3080')], opts);
    expect(store.getSnapshot().clickThrough).toBe(false);
  });

  it('setClickThrough(true) 后快照跟着变（托盘勾选状态读它）', () => {
    const store = new TaskStore([dshTask('a', '127.0.0.1:3080')], opts);
    store.setClickThrough(true);
    expect(store.getSnapshot().clickThrough).toBe(true);
    store.setClickThrough(false);
    expect(store.getSnapshot().clickThrough).toBe(false);
  });

  it('setClickThrough 值未变时不空转提交（避免无意义快照失效）', () => {
    const store = new TaskStore([dshTask('a', '127.0.0.1:3080')], opts);
    const before = store.getSnapshot().version;
    store.setClickThrough(false); // 本来 false
    expect(store.getSnapshot().version).toBe(before);
    store.setClickThrough(true);
    expect(store.getSnapshot().version).toBeGreaterThan(before);
  });

  it('fromAppConfig 会带上 lamp.clickThrough 的初值（重启后设置仍生效）', () => {
    const locked = TaskStore.fromAppConfig(appConfig(true), opts);
    expect(locked.getSnapshot().clickThrough).toBe(true);

    const unlocked = TaskStore.fromAppConfig(appConfig(false), opts);
    expect(unlocked.getSnapshot().clickThrough).toBe(false);
  });

  it('syncClickThrough 用于配置热重载（用户直接改 yaml 的场景）', () => {
    const store = TaskStore.fromAppConfig(appConfig(false), opts);
    store.syncClickThrough(true);
    expect(store.getSnapshot().clickThrough).toBe(true);
  });

  it('clickThrough 变化不影响任务状态（只是外观开关）', () => {
    const store = new TaskStore([dshTask('a', '127.0.0.1:3080')], opts);
    store.apply('a', { status: 'running' });
    store.setClickThrough(true);
    expect(store.getSnapshot().tasks[0]?.status).toBe('running');
    expect(store.getSnapshot().aggregate).toBe('running');
  });
});
