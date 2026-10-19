/**
 * ★ 完成提醒的「确认闸门」测试。
 *
 * 用户要的形态：**执行完亮绿灯保持不动，点击后跳转并熄灭**。
 *
 * 难点在于 sqlite 型是**轮询**的：点掉之后下一轮（默认 5s）又会从数据库
 * 读到"有会话完成了"，于是绿灯**立刻复亮** —— 点击等于没点。
 *
 * 解法：把"完成"建模成**单调水位**。
 *   - 监控每轮上报带 `completionAt`（最近一次完成的时刻）
 *   - 用户点掉时 `markRead` 把它记进 `ackedCompletionAt`
 *   - store 的闸门丢弃 `completionAt <= ackedCompletionAt` 的上报
 *
 * 于是：同一个完成事件只亮一次；**新任务完成（水位变大）会再次点亮**。
 */

import { describe, expect, it } from 'vitest';
import { TaskStore } from '../src/main/store';
import type { TaskConfig } from '../src/shared/types';

const DONE1 = 1_700_000_000_000;
const DONE2 = DONE1 + 600_000;

const task = (id: string): TaskConfig => ({
  id,
  name: id,
  enabled: true,
  monitor: { type: 'sqlite', database: 'D:/x/y.db' },
});

/** 模拟监控上报一次"完成"。 */
const reportDone = (store: TaskStore, id: string, completionAt: number) =>
  store.apply(
    id,
    { status: 'success', message: '任务已完成，点击查看', completionAt, isSignal: true },
    {},
  );

describe('★★ 确认闸门：点掉之后不会立刻复亮', () => {
  it('★ 首次上报完成 -> 亮绿灯', () => {
    const store = new TaskStore([task('a')]);
    expect(reportDone(store, 'a', DONE1)).not.toBeNull();
    expect(store.getTask('a')?.status).toBe('success');
  });

  it('★★ 点掉（mark_read）之后，**同一个完成再次上报会被丢弃**', () => {
    const store = new TaskStore([task('a')]);
    reportDone(store, 'a', DONE1);
    store.markRead('a');
    expect(store.getTask('a')?.status).toBe('idle');

    // 监控下一轮又读到"有会话完成了" —— 这就是复亮的来源
    const again = reportDone(store, 'a', DONE1);
    expect(again).toBeNull(); // 被闸门丢弃
    expect(store.getTask('a')?.status).toBe('idle'); // 绿灯没有复亮
  });

  it('★ 水位更低或相等的上报同样被丢弃', () => {
    const store = new TaskStore([task('a')]);
    reportDone(store, 'a', DONE1);
    store.markRead('a');
    expect(reportDone(store, 'a', DONE1 - 5_000)).toBeNull();
    expect(store.getTask('a')?.status).toBe('idle');
  });

  it('★★ **更新的**完成要再次亮绿灯（新任务仍需提醒）', () => {
    const store = new TaskStore([task('a')]);
    reportDone(store, 'a', DONE1);
    store.markRead('a');

    // 又跑完一个新任务 -> 水位变大
    expect(reportDone(store, 'a', DONE2)).not.toBeNull();
    expect(store.getTask('a')?.status).toBe('success');
  });

  it('★ 未点掉时重复上报同一个完成：状态没变化，返回 null 但不影响已亮的绿灯', () => {
    const store = new TaskStore([task('a')]);
    reportDone(store, 'a', DONE1);
    // 状态已是 success、message 相同 -> 无变化
    const again = reportDone(store, 'a', DONE1);
    expect(again).toBeNull();
    // 关键：绿灯**仍然亮着**（不是被闸门熄灭）
    expect(store.getTask('a')?.status).toBe('success');
  });

  it('★ markRead 之后再上报旧完成，不会把 unread 又置回 true', () => {
    const store = new TaskStore([task('a')]);
    reportDone(store, 'a', DONE1);
    store.markRead('a');
    reportDone(store, 'a', DONE1);
    expect(store.getTask('a')?.status).toBe('idle');
  });
});

describe('确认水位的记录时机', () => {
  it('★ markRead 必须在把状态打回 idle **之前**记下水位', () => {
    // 若顺序反了（先 idle 再记水位），监控下一轮读到同一个完成、水位却没更新，
    // 绿灯会立刻复亮 —— 这个断言就是防那次回归。
    const store = new TaskStore([task('a')]);
    reportDone(store, 'a', DONE1);
    store.markRead('a');

    const t = store.getTask('a');
    expect(t?.ackedCompletionAt).toBe(DONE1);
  });

  it('ack 水位只增不减（取 max，防止时序错乱把已确认的回退）', () => {
    const store = new TaskStore([task('a')]);
    reportDone(store, 'a', DONE2);
    store.markRead('a');
    expect(store.getTask('a')?.ackedCompletionAt).toBe(DONE2);

    // 再完成一次更早的水位（理论上不该发生，但要防御）
    reportDone(store, 'a', DONE1);
    if ((store.getTask('a')?.status ?? '') === 'success') {
      store.markRead('a');
    }
    expect(store.getTask('a')?.ackedCompletionAt).toBe(DONE2);
  });

  it('普通 success（不带 completionAt）不受闸门影响', () => {
    // 别的监控型（log/webhook）没有水位概念，行为必须和以前一样
    const store = new TaskStore([{ ...task('a'), monitor: { type: 'process', match: [{ processNames: ['x.exe'] }] } }]);
    store.apply('a', { status: 'running', isSignal: true });
    expect(store.apply('a', { status: 'success', isSignal: true })).not.toBeNull();
    expect(store.getTask('a')?.status).toBe('success');
  });
});

// ---------------------------------------------------------------------------
// SPEC-007：dismiss_after 自动熄灭不能让同一个完成重新点亮
// ---------------------------------------------------------------------------
// 现场：WorkBuddy 明明没在跑东西，灯每隔一段时间自己亮绿。
// 根因：success 在 dismissAfterMs（默认 10 分钟）后自动回 idle，但**没有**
// 把这次完成记进 ackedCompletionAt；轮询型监控下一轮又从库里读到同一个
// lastDoneAt > 0 = 0，于是再次上报 success —— 每 10 分钟循环一次。
describe('SPEC-007 自动熄灭（dismiss_after）要同时确认完成水位', () => {
  const makeStore = (ref: { t: number }) => new TaskStore([task('a')], { now: () => ref.t });

  it('AC-01 dismiss 之后状态回 idle，且同一个完成不再复亮', () => {
    const ref = { t: DONE1 + 1_000 };
    const store = makeStore(ref);
    expect(reportDone(store, 'a', DONE1)).not.toBeNull();

    ref.t += 11 * 60_000; // 超过默认 dismissAfterMs（10 分钟）
    const changes = store.tick();
    expect(changes.some((c) => c.taskId === 'a' && c.to === 'idle')).toBe(true);
    expect(store.getTask('a')?.status).toBe('idle');
    expect(store.getTask('a')?.ackedCompletionAt).toBe(DONE1);

    // 监控下一轮照样会上报同一个完成 —— 必须被确认闸门丢掉
    expect(reportDone(store, 'a', DONE1)).toBeNull();
    expect(store.getTask('a')?.status).toBe('idle');
  });

  it('AC-02 dismiss 之后**新的**完成仍然会点亮（没有把功能砍掉）', () => {
    const ref = { t: DONE1 + 1_000 };
    const store = makeStore(ref);
    reportDone(store, 'a', DONE1);

    ref.t += 11 * 60_000;
    store.tick();
    expect(store.getTask('a')?.status).toBe('idle');

    expect(reportDone(store, 'a', DONE2)).not.toBeNull();
    expect(store.getTask('a')?.status).toBe('success');
  });

  it('AC-03 用户主动点击与自动熄灭的效果一致（都不会复亮）', () => {
    const ref = { t: DONE1 + 1_000 };
    const store = makeStore(ref);
    reportDone(store, 'a', DONE1);
    store.markRead('a');
    expect(reportDone(store, 'a', DONE1)).toBeNull();

    expect(reportDone(store, 'a', DONE2)).not.toBeNull();
    expect(store.getTask('a')?.status).toBe('success');
  });
});