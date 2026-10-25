/**
 * 「浮窗里出现的东西默认就该是活着的」这条产品原则的测试。
 *
 * 用户原话：**「如果没活着就没必要显示在浮窗里面了，既然能存在浮窗里面，
 * 那么就应该是活着的」**。
 *
 * 价值在于**可依赖**：看到一行 = 它是活着的，不需要用户再去分辨
 * "灰灯是空闲还是掉线"。
 *
 * 选定的规则（用户确认）：
 *   - 隐藏：`unknown`（失联）、`failed`（失败）
 *   - 显示：`idle` / `starting` / `running` / `waiting` / `success`
 *   - 可显示行数为 0（且无目标行）时整窗缩成单灯；
 *     1 行也用灯带 —— SPEC-040：只监控一个工具时同样要显示它的图标
 *   - 所有监控类型统一适用
 */

import { describe, expect, it } from 'vitest';
import {
  HIDDEN_STATUSES,
  countVisibleTasks,
  isTaskVisible,
  isVisibleStatus,
} from '../src/shared/visibility';
import { TaskStore } from '../src/main/store';
import type { TaskConfig, TaskStatus } from '../src/shared/types';

const ALL_STATUSES: TaskStatus[] = [
  'idle',
  'starting',
  'running',
  'waiting',
  'success',
  'failed',
  'unknown',
];

describe('isVisibleStatus —— 哪些状态代表"活着"', () => {
  it('★ 隐藏「失联」与「失败」（用户选择）', () => {
    expect(isVisibleStatus('unknown')).toBe(false);
    expect(isVisibleStatus('failed')).toBe(false);
    expect(HIDDEN_STATUSES.has('unknown')).toBe(true);
    expect(HIDDEN_STATUSES.has('failed')).toBe(true);
  });

  it('★ 保留其余五态 —— 尤其 idle', () => {
    // idle 必须显示：dsh 端口连接正常但当前没有活跃会话时，
    // 仍要能看到"这个端口在、只是空闲"。若把 idle 也隐藏，
    // 空闲的 dsh 端口会整行消失，反而看不出它在被监控。
    for (const s of ['idle', 'starting', 'running', 'waiting', 'success'] as const) {
      expect(isVisibleStatus(s)).toBe(true);
    }
  });

  it('★ `waiting` 一定要显示 —— 那是本产品最值钱的状态', () => {
    // 卡住等你授权。若它被隐藏，整个产品的核心价值就没了。
    expect(isVisibleStatus('waiting')).toBe(true);
  });

  it('七态全覆盖，且隐藏的恰好是那两个', () => {
    const hidden = ALL_STATUSES.filter((s) => !isVisibleStatus(s));
    expect(hidden.sort()).toEqual(['failed', 'unknown']);
  });
});

describe('isTaskVisible —— 三道过滤', () => {
  it('运行中且未暂停 -> 可见', () => {
    expect(isTaskVisible({ status: 'running' })).toBe(true);
  });

  it('失联/失败 -> 不可见', () => {
    expect(isTaskVisible({ status: 'unknown' })).toBe(false);
    expect(isTaskVisible({ status: 'failed' })).toBe(false);
  });

  it('任务级 paused -> 不可见（哪怕状态是 running）', () => {
    expect(isTaskVisible({ status: 'running', paused: true })).toBe(false);
  });

  it('配置 enabled:false -> 不可见（配置侧估算用）', () => {
    expect(isTaskVisible({ status: 'running', enabled: false })).toBe(false);
    expect(isTaskVisible({ status: 'idle', enabled: false })).toBe(false);
  });

  it('★ 配置侧（没有 status）按"可见"处理', () => {
    // 任务还没跑起来时配置里没有 status，等价于 idle -> 可见。
    // 这样 countVisibleTasks 既能数运行时快照、也能估算初始窗口尺寸。
    expect(isTaskVisible({})).toBe(true);
    expect(isTaskVisible({ enabled: true })).toBe(true);
    expect(isTaskVisible({ enabled: false })).toBe(false);
  });
});

describe('countVisibleTasks', () => {
  it('数出可显示的行数', () => {
    expect(
      countVisibleTasks([
        { status: 'running' },
        { status: 'idle' },
        { status: 'unknown' },
        { status: 'failed' },
      ]),
    ).toBe(2);
  });

  it('全部失联/失败 -> 0（此时应缩成单灯）', () => {
    expect(countVisibleTasks([{ status: 'unknown' }, { status: 'failed' }])).toBe(0);
  });

  it('空数组 -> 0', () => {
    expect(countVisibleTasks([])).toBe(0);
  });
});

describe('TaskStore 集成 —— stripMode 与 displayTasks', () => {
  const task = (id: string, enabled = true): TaskConfig => ({
    id,
    name: id,
    enabled,
    monitor: { type: 'process', match: [{ processNames: ['x.exe'] }] },
  });

  it('★ 两个任务都失联时 -> 缩成单灯（stripMode=false）', () => {
    const store = new TaskStore([task('a'), task('b')]);
    for (const id of ['a', 'b']) {
      for (let i = 0; i < 2; i += 1) {
        store.apply(id, { status: 'failed', isSignal: true });
        store.apply(id, { status: 'unknown', isSignal: true });
      }
    }
    const snap = store.getSnapshot();
    expect(snap.stripMode).toBe(false); // 没有活着的东西 -> 缩成一颗灯
    expect(snap.displayTasks).toHaveLength(0);
    expect(snap.hiddenCount).toBe(2);
  });

  it('★ 一个活一个失联 -> 灯带（1 个活着的也要显示图标，SPEC-040）', () => {
    const store = new TaskStore([task('a'), task('b')]);
    store.apply('a', { status: 'running', isSignal: true });
    for (let i = 0; i < 2; i += 1) {
      store.apply('b', { status: 'failed', isSignal: true });
      store.apply('b', { status: 'unknown', isSignal: true });
    }
    const snap = store.getSnapshot();
    // 可显示行数 1：不再缩成单灯——那会让唯一的工具连图标都没有
    expect(snap.stripMode).toBe(true);
    expect(snap.displayTasks.map((t) => t.taskId)).toEqual(['a']);
    expect(snap.hiddenCount).toBe(1);
  });

  it('★ 两个都活着 -> 灯带', () => {
    const store = new TaskStore([task('a'), task('b')]);
    store.apply('a', { status: 'running', isSignal: true });
    store.apply('b', { status: 'idle', isSignal: true });
    const snap = store.getSnapshot();
    expect(snap.stripMode).toBe(true);
    expect(snap.displayTasks).toHaveLength(2);
    expect(snap.hiddenCount).toBe(0);
  });

  it('★ 隐藏不等于掩盖：失联/失败的任务仍参与总灯聚合', () => {
    // 关键不变量。若把失联/失败任务从聚合里也剔除，
    // 总灯就会变绿 —— 那是"把问题藏起来"，比不显示更危险。
    const store = new TaskStore([task('a'), task('b')]);
    store.apply('a', { status: 'running', isSignal: true });
    // 走 failed -> unknown；注意转移表不允许 failed -> unknown，
    // 所以 b 最终停在 failed —— 两者都是"被隐藏"的状态，不影响本断言目的。
    store.apply('b', { status: 'failed', isSignal: true });
    store.apply('b', { status: 'unknown', isSignal: true });

    const snap = store.getSnapshot();
    const b = snap.tasks.find((t) => t.taskId === 'b');
    // b 的行不显示（失联或失败），但它的状态必须反映在总灯上
    expect(b).toBeDefined();
    expect(isVisibleStatus(b!.status)).toBe(false);
    expect(snap.aggregate).toBe(b!.status); // 聚合里保留了它，没被抹掉
    expect(snap.aggregate).not.toBe('running'); // 绝不能因为隐藏就变成"看起来正常"
  });

  it('displayTasks 与 hiddenCount 互补（合计 = 未暂停任务数）', () => {
    const store = new TaskStore([task('a'), task('b'), task('c')]);
    store.apply('a', { status: 'running', isSignal: true });
    store.apply('b', { status: 'idle', isSignal: true });
    for (let i = 0; i < 2; i += 1) {
      store.apply('c', { status: 'failed', isSignal: true });
      store.apply('c', { status: 'unknown', isSignal: true });
    }
    const snap = store.getSnapshot();
    expect(snap.displayTasks.length + snap.hiddenCount).toBe(3);
  });

  it('配置里 enabled:false 的任务不进 displayTasks', () => {
    const store = new TaskStore([task('a'), task('b', false)]);
    store.apply('a', { status: 'running', isSignal: true });
    const snap = store.getSnapshot();
    expect(snap.displayTasks.map((t) => t.taskId)).toEqual(['a']);
  });

  // -------------------------------------------------------------------------
  // ★ 回归：热重载把 enabled 从 true 改成 false 必须能同步到 store
  // -------------------------------------------------------------------------
  describe('★ syncTasks 必须同步 enabled（"禁用了但浮窗还在显示"的根因）', () => {
    it('只改 enabled、不改名字 -> 也能同步（旧实现同步不到）', () => {
      // 旧实现把 `existing.paused = !cfg.enabled` 写在 `if (nameChanged)` 里，
      // 于是「名字没变、只把 yaml 的 enabled 改成 false」这个最常见的操作
      // 同步不到 store —— 配置里禁用了，浮窗上那一行还在。
      const store = new TaskStore([task('a')]);
      store.apply('a', { status: 'running', isSignal: true });
      expect(store.getSnapshot().displayTasks).toHaveLength(1);

      // 名字保持 'a' 不变，只翻转 enabled
      const outcome = store.syncTasks([task('a', false)]);

      expect(outcome.changed).toContain('a');
      expect(store.getSnapshot().tasks[0]?.enabled).toBe(false);
      // 禁用后该行必须从浮窗消失，且不再影响灯带形态判定
      expect(store.getSnapshot().displayTasks).toHaveLength(0);
      expect(store.getSnapshot().stripMode).toBe(false);
    });

    it('enabled 从 false 改回 true 也能同步（恢复显示）', () => {
      const store = new TaskStore([task('a', false)]);
      expect(store.getSnapshot().displayTasks).toHaveLength(0);

      store.syncTasks([task('a', true)]);
      expect(store.getSnapshot().tasks[0]?.enabled).toBe(true);
      expect(store.getSnapshot().displayTasks).toHaveLength(1);
    });

    it('enabled 未变时不记录为 changed（避免无意义提交）', () => {
      const store = new TaskStore([task('a')]);
      const outcome = store.syncTasks([task('a')]);
      expect(outcome.changed).not.toContain('a');
    });

    it('禁用任务不参与聚合（否则总灯会被一个不监控的任务拉成异常色）', () => {
      const store = new TaskStore([task('a', true), task('b', false)]);
      store.apply('a', { status: 'idle', isSignal: true });
      store.apply('b', { status: 'failed', isSignal: true });
      // b 被禁用 -> 它的 failed 不该把总灯拉红
      expect(store.getSnapshot().aggregate).toBe('idle');
    });
  });
});
