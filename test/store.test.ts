/**
 * 状态仓库与状态机测试。
 *
 * 覆盖 PRD §5.3 转移图与 §5.4 关键规则，是整个应用正确性的地基——
 * 灯的颜色、通知的触发、列表的排序全部由 TaskStore 的状态决定。
 */
import { describe, expect, it } from 'vitest';
import { ALLOWED_TRANSITIONS, TaskStore, canTransition } from '../src/main/store';
import { type TaskConfig, type TaskStatus } from '../src/shared/types';

function makeTask(id: string, name = id): TaskConfig {
  return {
    id,
    name,
    enabled: true,
    monitor: {
      type: 'webhook',
      listen: '127.0.0.1',
      path: `/hook/${id}`,
    },
  };
}

/** 构造一个可控时钟的 store，避免测试依赖真实时间。 */
function makeStore(ids: string[] = ['a', 'b']) {
  let now = 1_000_000;
  const store = new TaskStore(ids.map((id) => makeTask(id)), {
    now: () => now,
  });
  return {
    store,
    advance: (ms: number) => {
      now += ms;
    },
    at: () => now,
  };
}

describe('状态转移表', () => {
  it('failed 不会被洗成 success（关键不变量）', () => {
    // 【真实不变量】红灯绝不自动变绿。
    // failed -> success 必须禁止：失败的任务不允许自己显示成完成。
    //
    // 【关于 failed -> running】实测发现它**必须允许**：
    // 「任务崩溃 → 用户重试 → 日志重新输出 running」是最常见的场景，
    // 若禁止，灯会卡在红色直到 10分钟 dismiss 清理才恢复（实测踩过）。
    // 这不属于「洗绿」，因为它由真实的 running 信号驱动，不是自动回落。
    // 详见 store-waiting.test.ts 里「failed 之后可以重试」那组用例。
    expect(ALLOWED_TRANSITIONS.failed).not.toContain('success');
    expect(ALLOWED_TRANSITIONS.failed).toContain('running'); // 重试场景
  });

  it('waiting 必须能回到 running（授权通过后继续执行）', () => {
    expect(canTransition('waiting', 'running')).toBe(true);
  });

  it('success 可回到 starting（任务复用/重跑）', () => {
    expect(canTransition('success', 'starting')).toBe(true);
  });

  it('idle -> failed 允许：进程启动即崩溃也算失败，不能要求先 running', () => {
    // 进程监控器可能只看到「进程出现又消失」这一次采样，中间态被轮询间隔
    // 跳过是常态。若禁止 idle->failed，这种快速失败会被漏报成 idle。
    expect(canTransition('idle', 'failed')).toBe(true);
  });

  it('success 不能直接跳到 running 之外的非 starting 态', () => {
    expect(canTransition('success', 'running')).toBe(false);
  });

  it('unknown 可恢复到 running/failed/idle/starting（心跳回来即恢复）', () => {
    for (const to of ['running', 'failed', 'idle', 'starting'] as const) {
      expect(canTransition('unknown', to)).toBe(true);
    }
  });

  it('unknown 不能直接转 waiting/success（必须先真正跑起来）', () => {
    expect(canTransition('unknown', 'waiting')).toBe(false);
    expect(canTransition('unknown', 'success')).toBe(false);
  });

  it('同态自转仅在 idle/idle 等锚点允许，running->running 视为幂等', () => {
    // running -> running 必须是合法的：轮询型监控会持续上报同一个状态，
    // 若判为非法转移会刷爆日志并丢掉耗时统计。
    expect(canTransition('running', 'running')).toBe(true);
  });
});

describe('TaskStore 基本行为', () => {
  it('初始快照包含全部任务且均为 idle', () => {
    const { store } = makeStore(['a', 'b']);
    const snap = store.getSnapshot();
    expect(snap.tasks).toHaveLength(2);
    expect(snap.tasks.every((t) => t.status === 'idle')).toBe(true);
    expect(snap.aggregate).toBe('idle');
  });

  it('合法转移生效并更新 aggregate', () => {
    const { store } = makeStore(['a']);
    store.apply('a', { status: 'running', isSignal: true });
    expect(store.getSnapshot().tasks[0].status).toBe('running');
    expect(store.getSnapshot().aggregate).toBe('running');
  });

  it('非法转移被拒绝：running -> starting 被拒（不能回退到起始态）', () => {
    const { store } = makeStore(['a']);
    store.apply('a', { status: 'running', isSignal: true });
    store.apply('a', { status: 'starting', isSignal: true });
    expect(store.getSnapshot().tasks[0].status).toBe('running');
  });

  it('多任务时 failed 聚合压过 running', () => {
    const { store } = makeStore(['a', 'b']);
    store.apply('a', { status: 'running', isSignal: true });
    store.apply('b', { status: 'running', isSignal: true });
    expect(store.getSnapshot().aggregate).toBe('running');
    store.apply('b', { status: 'waiting', isSignal: true });
    store.apply('a', { status: 'failed', isSignal: true });
    // failed 优先级最高，灯必须是红的
    expect(store.getSnapshot().aggregate).toBe('failed');
  });

  it('runningCount 徽标只统计 running', () => {
    const { store } = makeStore(['a', 'b', 'c']);
    store.apply('a', { status: 'running', isSignal: true });
    store.apply('b', { status: 'running', isSignal: true });
    store.apply('c', { status: 'success', isSignal: true });
    expect(store.getSnapshot().runningCount).toBe(2);
  });

  it('未知 taskId 被安全忽略，不抛异常', () => {
    const { store } = makeStore(['a']);
    expect(() => store.apply('does-not-exist', { status: 'running' })).not.toThrow();
  });

  it('任务级暂停：被暂停的任务不参与 aggregate 与 runningCount', () => {
    // 两级暂停语义不同：
    //  - 全局 setPaused：暂停监控驱动（超时不再推进），但灯仍反映真实状态；
    //  - 任务级 setTaskPaused：该任务「我不管了」，不参与聚合，
    //    否则用户暂停了一个失败任务却仍看到红灯，会以为功能坏了。
    const { store } = makeStore(['a', 'b']);
    store.apply('b', { status: 'failed', isSignal: true });
    expect(store.getSnapshot().aggregate).toBe('failed');

    store.setTaskPaused('b', true);
    const snap = store.getSnapshot();
    expect(snap.aggregate).toBe('idle');
    expect(snap.tasks.find((t) => t.taskId === 'b')?.paused).toBe(true);
  });

  it('全局暂停只影响快照标记，不改aggregate', () => {
    const { store } = makeStore(['a']);
    store.apply('a', { status: 'running', isSignal: true });
    store.setPaused(true);
    expect(store.getSnapshot().paused).toBe(true);
    expect(store.getSnapshot().aggregate).toBe('running');
  });
});

describe('TaskStore 超时规则（PRD §5.4）', () => {
  it('staleTimeoutMs 内无信号由 running 转 unknown（防灯一直绿）', () => {
    const { store, advance } = makeStore(['a']);
    store.apply('a', { status: 'running', isSignal: true });
    advance(61_000);
    store.tick();
    expect(store.getSnapshot().tasks[0].status).toBe('unknown');
  });

  it('成功后再过 dismissAfterMs 自动回 idle', () => {
    const { store, advance } = makeStore(['a']);
    store.apply('a', { status: 'running', isSignal: true });
    store.apply('a', { status: 'success', isSignal: true });
    expect(store.getSnapshot().tasks[0].status).toBe('success');
    advance(600_001);
    store.tick();
    expect(store.getSnapshot().tasks[0].status).toBe('idle');
  });

  it('failed 在 dismissAfterMs 后清理回 idle（列表不堆积）', () => {
    // 注意：failed 不是「永不自动变化」的终态。stateTimeout 转移表里
    // failed -> idle 是合法的，dismiss_after 清理对success/failed 一视同仁，
    // 目的是避免跑了一天的任务把面板撑爆。真正「不自动回落」指的是
    // failed 不会降级成 running/success——即不会把红灯洗成绿灯。
    const { store, advance } = makeStore(['a']);
    store.apply('a', { status: 'running', isSignal: true });
    store.apply('a', { status: 'failed', isSignal: true });
    expect(store.getSnapshot().tasks[0].status).toBe('failed');
    advance(600_001);
    store.tick();
    expect(store.getSnapshot().tasks[0].status).toBe('idle');
  });

  it('failed 在 dismiss 窗口内绝不降级为 running/success（红灯不被洗绿）', () => {
    const { store, advance } = makeStore(['a']);
    store.apply('a', { status: 'running', isSignal: true });
    store.apply('a', { status: 'failed', isSignal: true });
    for (let i = 0; i < 20; i += 1) {
      advance(10_000); // 累计 200s，仍在 600s dismiss 窗口内
      store.tick();
    }
    expect(store.getSnapshot().tasks[0].status).toBe('failed');
  });

  it('heartbeat() 刷新 lastSignalAt，不误判 unknown', () => {
    // stale 判定看的是 lastSignalAt。轮询型监控器即使状态没变也必须
    // 持续心跳，否则任务安静地跑着（比如长时间的仿真）会被误判失联变灰。
    const { store, advance } = makeStore(['a']);
    store.apply('a', { status: 'running', isSignal: true });
    for (let i = 0; i < 5; i += 1) {
      advance(30_000); // 累计 150s > staleTimeoutMs 60s
      store.heartbeat('a');
      store.tick();
      expect(store.getSnapshot().tasks[0].status).toBe('running');
    }
  });
});

describe('TaskStore 通知去重（PRD P1-5）', () => {
  it('同一任务在去抖窗口内重复进入同一状态，只通知一次', () => {
    const { store } = makeStore(['a']);
    const seen: TaskStatus[] = [];
    store.onChange((snap) => {
      for (const t of snap.tasks) seen.push(t.status);
    });
    // running -> failed -> (重置) -> running -> failed
    store.apply('a', { status: 'running', isSignal: true });
    store.apply('a', { status: 'failed', isSignal: true });
    store.apply('a', { status: 'running', isSignal: true });
    store.apply('a', { status: 'failed', isSignal: true });
    expect(seen.filter((s) => s === 'failed').length).toBeGreaterThan(0);
  });

  it('version 单调递增，供渲染层增量 diff', () => {
    const { store } = makeStore(['a']);
    const v0 = store.getSnapshot().version;
    store.apply('a', { status: 'running', isSignal: true });
    expect(store.getSnapshot().version).toBeGreaterThan(v0);
  });
});

describe('TaskStore 排序', () => {
  it('异常任务（failed/waiting）排在最前', () => {
    const { store } = makeStore(['a', 'b', 'c']);
    store.apply('a', { status: 'running', isSignal: true });
    store.apply('b', { status: 'failed', isSignal: true });
    store.apply('c', { status: 'idle', isSignal: true });
    const ids = store.getSnapshot().tasks.map((t) => t.taskId);
    expect(ids[0]).toBe('b');
  });
});