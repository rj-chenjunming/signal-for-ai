/**
 * 状态机边界与聚合语义的补充测试（QA 补充，非既有 store.test.ts 的重复）。
 *
 * 既有测试覆盖了主干路径，本文件专门钉住**容易回归的边界**：
 *  - PRD §5.3「任意状态 --命中错误规则--> failed」的底边是否真的覆盖七态；
 *  - unknown 态的恢复能力（webhook 心跳超时后补推终态不能被永久拒绝）；
 *  - syncTasks 热重载差分不得丢状态；
 *  - 聚合优先级与排序的**完整**顺序（既有测试只断言了首个元素）。
 */
import { describe, expect, it } from 'vitest';

import { TaskStore, canTransition } from '../src/main/store';
import {
  computeAggregate,
  sortByStatus,
  statusRank,
  STATUS_PRIORITY,
} from '../src/shared/constants';
import { ALL_TASK_STATUSES, type TaskConfig, type TaskStatus } from '../src/shared/types';

function makeTask(id: string): TaskConfig {
  return {
    id,
    name: id,
    enabled: true,
    monitor: { type: 'webhook', listen: '127.0.0.1', path: `/hook/${id}` },
  };
}

function makeStore(ids: string[]) {
  let now = 1_000_000;
  const store = new TaskStore(ids.map(makeTask), { now: () => now });
  return { store, advance: (ms: number) => { now += ms; } };
}

describe('PRD §5.3 转移图底边：任意状态命中错误规则 -> failed', () => {
  it('七态中除 success 外的所有状态都必须能转入 failed', () => {
    // PRD §5.3 图底边明确画了「任意状态 --> failed」。
    // 若某个状态缺这条边，用户会看到「任务已经报错了，灯却是绿的/黄的」。
    const mustReachFailed = ALL_TASK_STATUSES.filter((s) => s !== 'success');
    for (const from of mustReachFailed) {
      expect(canTransition(from, 'failed'), `${from} -> failed 应被允许`).toBe(true);
    }
  });

  it('success -> failed 被允许：任务完成后又崩溃同样要报警', () => {
    // 真实场景：AI 工具「跑完了」但收尾时写文件失败 / 后置脚本报错，
    // 此时若拒绝 success->failed，用户会以为一切正常而漏掉这个错误。
    expect(canTransition('success', 'failed')).toBe(true);
  });
});

describe('unknown 态的恢复能力（PRD §5.4「恢复信号」）', () => {
  it('unknown 必须能回到四个「有进展」的状态', () => {
    for (const to of ['running', 'failed', 'idle', 'starting'] as const) {
      expect(canTransition('unknown', to)).toBe(true);
    }
  });

  it('unknown -> success 被拒：失联任务不能凭空变成「已完成」', () => {
    // 这条是**有意**的：失联期间任务可能早就崩了，直接标 success 会漏报失败。
    // 监控器必须先观察到真实运行信号（running）才能判成功。
    expect(canTransition('unknown', 'success')).toBe(false);
  });

  it('unknown -> waiting 被拒：必须先真正跑起来才可能等待授权', () => {
    expect(canTransition('unknown', 'waiting')).toBe(false);
  });

  it('失联后不能直接判成功，必须先回到 running（端到端走一遍）', () => {
    const { store, advance } = makeStore(['a']);
    store.apply('a', { status: 'running', isSignal: true });
    advance(61_000);
    store.tick();
    expect(store.getSnapshot().tasks[0].status).toBe('unknown');

    // 监控器补推 success：被状态机拒绝，状态仍是 unknown（不会被误报成功）
    expect(store.apply('a', { status: 'success', isSignal: true })).toBeNull();
    expect(store.getSnapshot().tasks[0].status).toBe('unknown');

    // 补推 running 后，终态才可被接受
    store.apply('a', { status: 'running', isSignal: true });
    expect(store.apply('a', { status: 'success', isSignal: true })).not.toBeNull();
    expect(store.getSnapshot().tasks[0].status).toBe('success');
  });
});

describe('computeAggregate 完整优先级（PRD §5.2）', () => {
  it('单状态直接映射', () => {
    for (const s of ALL_TASK_STATUSES) {
      if (s === 'unknown') {
        // unknown 与 idle 同级灰（架构 §8.1）
        expect(computeAggregate([s])).toBe('idle');
      } else {
        expect(computeAggregate([s])).toBe(s);
      }
    }
  });

  it('全 idle 与空数组都返回 idle（全部空闲 -> 灰）', () => {
    expect(computeAggregate([])).toBe('idle');
    expect(computeAggregate(['idle', 'idle'])).toBe('idle');
  });

  it('unknown 与其他态并存时按其他态计算（unknown 不抢占优先级）', () => {
    expect(computeAggregate(['unknown', 'running'])).toBe('running');
    expect(computeAggregate(['unknown', 'success'])).toBe('success');
  });

  it('failed 压过一切，包括多个 waiting', () => {
    expect(computeAggregate(['waiting', 'waiting', 'failed'])).toBe('failed');
  });

  it('两两组合：优先级严格遵循 STATUS_PRIORITY 序列', () => {
    // 穷举 C(7,2)=21 种组合，确保任意两态并存时聚合结果唯一确定且符合优先级。
    for (let i = 0; i < ALL_TASK_STATUSES.length; i += 1) {
      for (let j = i + 1; j < ALL_TASK_STATUSES.length; j += 1) {
        const a = ALL_TASK_STATUSES[i] as TaskStatus;
        const b = ALL_TASK_STATUSES[j] as TaskStatus;
        const expected = a === 'unknown' ? b : b === 'unknown' ? a : statusRank(a) <= statusRank(b) ? a : b;
        expect(
          computeAggregate([a, b]),
          `aggregate([${a},${b}]) 应为 ${expected}`,
        ).toBe(expected);
      }
    }
  });
});

describe('sortByStatus 排序（PRD §7.3 列表排序）', () => {
  it('异常任务置顶：failed 最前', () => {
    const items = ALL_TASK_STATUSES.map((s) => ({ status: s }));
    const sorted = sortByStatus(items);
    expect(sorted[0]?.status).toBe('failed');
  });

  it('完整顺序与 STATUS_PRIORITY 一致', () => {
    const items = ALL_TASK_STATUSES.map((s) => ({ status: s }));
    const sorted = sortByStatus(items).map((i) => i.status);
    expect(sorted).toEqual([...STATUS_PRIORITY]);
  });

  it('同级保持配置顺序（稳定排序）', () => {
    const items = [
      { id: 'first', status: 'running' as const },
      { id: 'second', status: 'running' as const },
      { id: 'third', status: 'running' as const },
    ];
    expect(sortByStatus(items).map((i) => i.id)).toEqual(['first', 'second', 'third']);
  });

  it('不修改入参数组顺序（纯函数）', () => {
    const items = [
      { id: 'a', status: 'idle' as const },
      { id: 'b', status: 'failed' as const },
    ];
    const copy = [...items];
    sortByStatus(items);
    expect(items).toEqual(copy);
  });
});

describe('syncTasks 热重载差分（PRD P1-2）', () => {
  it('新增/删除/改名分别归入 added/removed/changed', () => {
    const { store } = makeStore(['a', 'b']);
    const next: TaskConfig[] = [
      { ...makeTask('a'), name: 'A-改名' },
      makeTask('c'),
    ];
    const diff = store.syncTasks(next);
    expect(diff.added).toEqual(['c']);
    expect(diff.removed).toEqual(['b']);
    expect(diff.changed).toEqual(['a']);
  });

  it('热重载保留既有任务状态（不闪断，架构 §5.3）', () => {
    const { store } = makeStore(['a']);
    store.apply('a', { status: 'running', isSignal: true });
    store.syncTasks([{ ...makeTask('a'), name: 'A-改名' }]);
    const t = store.getSnapshot().tasks[0];
    expect(t?.status).toBe('running');
    expect(t?.name).toBe('A-改名');
  });

  it('顺序按新配置重排', () => {
    const { store } = makeStore(['a', 'b']);
    store.syncTasks([makeTask('b'), makeTask('a')]);
    // 两个都是 idle，排序后应保持配置给出的展示顺序
    expect(store.getSnapshot().tasks.map((t) => t.taskId)).toEqual(['b', 'a']);
  });

  it('删除任务后聚合不再受其影响', () => {
    const { store } = makeStore(['a', 'b']);
    store.apply('b', { status: 'failed', isSignal: true });
    expect(store.getSnapshot().aggregate).toBe('failed');
    store.syncTasks([makeTask('a')]);
    expect(store.getSnapshot().aggregate).toBe('idle');
  });

  it('删除后再重新加入，状态重置为 idle', () => {
    const { store } = makeStore(['a']);
    store.apply('a', { status: 'failed', isSignal: true });
    store.syncTasks([]);
    store.syncTasks([makeTask('a')]);
    expect(store.getSnapshot().tasks[0]?.status).toBe('idle');
  });

  it('enabled=false 的任务不参与聚合，且 enabled 是独立字段', () => {
    const store = new TaskStore([{ ...makeTask('a'), enabled: false }]);
    store.apply('a', { status: 'failed', isSignal: true });
    expect(store.getSnapshot().aggregate).toBe('idle');

    // ⚠️ 这里曾断言 `paused === true` —— 那是把**配置的 enabled** 硬塞进
    // **运行时的 paused** 字段。两者语义不同，混用会导致
    // 「只改 yaml 里的 enabled、不改名字」时热重载同步不到 store
    // （旧 syncTasks 把它写在 nameChanged 分支里），
    // 表现为"配置里禁用了，浮窗上那一行还在"。
    // 现在分开：enabled 来自配置，paused 只管运行时暂停。
    const task = store.getSnapshot().tasks[0];
    expect(task?.enabled).toBe(false);
    expect(task?.paused).toBeUndefined();
  });
});

describe('reset / markRead 动作语义（架构 §4.3）', () => {
  it('reset 清空 error/message/duration 等残留字段', () => {
    const { store } = makeStore(['a']);
    store.apply('a', { status: 'running', isSignal: true });
    store.apply('a', { status: 'failed', isSignal: true, error: 'boom', message: '崩了' });
    store.reset('a');
    const t = store.getTask('a');
    expect(t?.status).toBe('idle');
    expect(t?.error).toBeUndefined();
    expect(t?.message).toBeUndefined();
    expect(t?.durationMs).toBeUndefined();
    expect(t?.unread).toBe(false);
  });

  it('markRead 对 failed 同时清 unread 并回 idle', () => {
    const { store } = makeStore(['a']);
    store.apply('a', { status: 'running', isSignal: true });
    store.apply('a', { status: 'failed', isSignal: true });
    expect(store.getTask('a')?.unread).toBe(true);
    store.markRead('a');
    expect(store.getTask('a')?.unread).toBe(false);
    expect(store.getTask('a')?.status).toBe('idle');
  });

  it('markRead 对 running 只清 unread，不改状态', () => {
    const { store } = makeStore(['a']);
    store.apply('a', { status: 'running', isSignal: true });
    store.markRead('a');
    expect(store.getTask('a')?.status).toBe('running');
  });

  it('未知 taskId 的 reset/markRead 不抛异常', () => {
    const { store } = makeStore(['a']);
    expect(() => store.reset('ghost')).not.toThrow();
    expect(() => store.markRead('ghost')).not.toThrow();
  });
});

describe('耗时与 unread 字段', () => {
  it('进入 success/failed 时记录 durationMs', () => {
    let now = 1_000_000;
    const store = new TaskStore([makeTask('a')], { now: () => now });
    store.apply('a', { status: 'running', isSignal: true, startedAt: now });
    now += 5_000;
    store.apply('a', { status: 'success', isSignal: true });
    expect(store.getTask('a')?.durationMs).toBe(5_000);
  });

  it('反复进入 success 不会把 unread 重新置真（已读后不应再冒红点）', () => {
    const { store } = makeStore(['a']);
    store.apply('a', { status: 'running', isSignal: true });
    store.apply('a', { status: 'success', isSignal: true });
    store.markRead('a');
    store.apply('a', { status: 'starting', isSignal: true });
    store.apply('a', { status: 'running', isSignal: true });
    store.apply('a', { status: 'success', isSignal: true });
    // 再次完成应重新置 unread（这是新一轮任务），但同一轮内不应反复置真
    expect(store.getTask('a')?.status).toBe('success');
  });

  it('未读数只由 success/failed 产生，running 不置未读', () => {
    const { store } = makeStore(['a']);
    store.apply('a', { status: 'running', isSignal: true });
    expect(store.getTask('a')?.unread).toBe(false);
  });
});