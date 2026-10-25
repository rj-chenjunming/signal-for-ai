/**
 * 灯带形态的 store 层测试（设计决策 D6 / D9）。
 *
 * 为什么在 store 层测：形态判定（单灯 vs 灯带）与端口标签推导都在这里，
 * 渲染层只是照做。把这两件事锁死，渲染层就不会拿到错的数据。
 */

import { describe, expect, it } from 'vitest';
import { TaskStore, derivePortLabel } from '../src/main/store';
import type { TaskConfig } from '../src/shared/types';

function dshTask(id: string, authority: string, enabled = true): TaskConfig {
  return {
    id,
    name: `dsh ${authority}`,
    enabled,
    monitor: { type: 'dsh', authority },
  };
}

function logTask(id: string, enabled = true): TaskConfig {
  return {
    id,
    name: '日志任务',
    enabled,
    monitor: { type: 'log', paths: ['D:/x/*.log'], rules: [] },
  };
}

describe('derivePortLabel', () => {
  it('dsh 型取 authority 的端口号', () => {
    expect(derivePortLabel(dshTask('a', '127.0.0.1:3080'))).toBe('3080');
    expect(derivePortLabel(dshTask('b', '127.0.0.1:13080'))).toBe('13080');
    expect(derivePortLabel(dshTask('c', 'localhost:9999'))).toBe('9999');
  });

  it('非 dsh 型退回 taskId', () => {
    expect(derivePortLabel(logTask('my-log-task'))).toBe('my-log-task');
  });

  it('dsh 但 authority 异常时退回 taskId（不崩，也不用垃圾字符串当标签）', () => {
    // 没有冒号 → 拿不到端口号 → 退回 taskId。
    // 刻意不把整个 'nocolon' 当标签：那会让灯带上显示一个谁也看不懂的串。
    expect(
      derivePortLabel({ id: 'broken', name: 'x', enabled: true, monitor: { type: 'dsh', authority: 'nocolon' } as never }),
    ).toBe('broken');
    // 连 authority 都没有 → 同样退回 taskId
    expect(
      derivePortLabel({ id: 'nope', name: 'x', enabled: true, monitor: { type: 'dsh' } as never }),
    ).toBe('nope');
    // 冒号在末尾（端口为空串）→ 也退回 taskId
    expect(
      derivePortLabel({ id: 'tail', name: 'x', enabled: true, monitor: { type: 'dsh', authority: '127.0.0.1:' } as never }),
    ).toBe('tail');
  });

  /* ------------------------------------------------------------------------
   * ★ shortLabel：显式短标签优先于"从端口号推导"
   *
   * 为什么需要：dsh 桌面客户端的本地服务在 19387，但用户心里叫它
   * "本地客户端" —— 灯带上显示 `19387` 完全对不上号。
   * ---------------------------------------------------------------------- */
  it('★ shortLabel 优先于端口号', () => {
    const t = { ...dshTask('dsh-local', '127.0.0.1:19387'), shortLabel: '本地客户端' };
    expect(derivePortLabel(t)).toBe('本地客户端');
  });

  it('★ shortLabel 对非 dsh 型也生效（覆盖 taskId）', () => {
    expect(derivePortLabel({ ...logTask('workbuddy'), shortLabel: 'WB' })).toBe('WB');
  });

  it('shortLabel 两端空白被裁掉', () => {
    expect(derivePortLabel({ ...dshTask('a', '127.0.0.1:3080'), shortLabel: '  web  ' })).toBe('web');
  });

  it('shortLabel 为空/空白时退回正常推导（不显示空标签）', () => {
    // 空标签会让灯带上出现"一行只有圆点没有字"，比显示端口号更差
    expect(derivePortLabel({ ...dshTask('a', '127.0.0.1:3080'), shortLabel: '' })).toBe('3080');
    expect(derivePortLabel({ ...dshTask('a', '127.0.0.1:3080'), shortLabel: '   ' })).toBe('3080');
    expect(derivePortLabel({ ...logTask('t1'), shortLabel: '' })).toBe('t1');
  });
});

describe('Snapshot.stripMode —— 与 OverlayWindow 的口径必须一致', () => {
  const opts = { logger: { warn: () => undefined, error: () => undefined } };

  it('单个启用任务 -> 灯带（SPEC-040：单工具也要显示图标）', () => {
    const store = new TaskStore([dshTask('a', '127.0.0.1:3080')], opts);
    expect(store.getSnapshot().stripMode).toBe(true);
  });

  it('两个启用任务 -> 灯带（stripMode=true）', () => {
    const store = new TaskStore(
      [dshTask('a', '127.0.0.1:3080'), dshTask('b', '127.0.0.1:13080')],
      opts,
    );
    expect(store.getSnapshot().stripMode).toBe(true);
  });

  it('只有 1 个启用、其余禁用 -> 灯带（禁用任务不占行位）', () => {
    const store = new TaskStore(
      [
        dshTask('a', '127.0.0.1:3080', true),
        dshTask('b', '127.0.0.1:13080', false),
        dshTask('c', '127.0.0.1:13081', false),
      ],
      opts,
    );
    // 这条仍是防错位的关键：形态判定必须数"可显示"任务，
    // 数错就会出现窗口按灯带开、内容按单灯渲染（或反之）。
    // SPEC-040：可显示 1 行也用灯带——单工具的图标必须显示出来。
    expect(store.getSnapshot().stripMode).toBe(true);
  });

  it('三个启用任务（混合类型）-> 灯带', () => {
    const store = new TaskStore(
      [dshTask('a', '127.0.0.1:3080'), dshTask('b', '127.0.0.1:13080'), logTask('c')],
      opts,
    );
    expect(store.getSnapshot().stripMode).toBe(true);
  });

  it('没有任何任务 -> 单灯，不崩', () => {
    const store = new TaskStore([], opts);
    const snap = store.getSnapshot();
    expect(snap.stripMode).toBe(false);
    expect(snap.tasks).toEqual([]);
  });
});

describe('TaskState.portLabel —— 供灯带每一行显示', () => {
  const opts = { logger: { warn: () => undefined, error: () => undefined } };

  it('每个任务的 portLabel 在初始状态就填好', () => {
    const store = new TaskStore(
      [dshTask('a', '127.0.0.1:3080'), dshTask('b', '127.0.0.1:13080'), logTask('c')],
      opts,
    );
    const labels = store.getSnapshot().tasks.map((t) => `${t.taskId}=${t.portLabel ?? ''}`);
    expect(labels).toContain('a=3080');
    expect(labels).toContain('b=13080');
    expect(labels).toContain('c=c');
  });

  it('portLabel 不受状态变化影响（状态更新后仍在）', () => {
    const store = new TaskStore([dshTask('a', '127.0.0.1:3080')], opts);
    store.apply('a', { status: 'running', message: '跑起来了' });
    const task = store.getSnapshot().tasks.find((t) => t.taskId === 'a');
    expect(task?.portLabel).toBe('3080');
    expect(task?.status).toBe('running');
  });

  it('禁用任务也有 portLabel（面板里照常显示）', () => {
    const store = new TaskStore([dshTask('a', '127.0.0.1:3080', false)], opts);
    const task = store.getSnapshot().tasks.find((t) => t.taskId === 'a');
    expect(task?.portLabel).toBe('3080');
  });
});
