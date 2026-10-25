/**
 * SPEC-025：悬浮灯「目标」行的数据与形态判定。
 *
 * Red 目标：目标摘要进入快照后，1 个任务也应为目标行保留灯带形态；
 * 没有进行中目标时不得改变既有单灯/灯带行为。
 */

import { describe, expect, it } from 'vitest';

import { summarizeGoals } from '../src/main/goals-store';
import { TaskStore } from '../src/main/store';
import { shouldShowStrip } from '../src/shared/visibility';
import type { Goal, TaskConfig } from '../src/shared/types';

function goal(overrides: Partial<Goal> & Pick<Goal, 'id'>): Goal {
  return {
    title: `目标 ${overrides.id}`,
    progress: 0,
    status: 'active',
    createdAt: 1761100000000,
    updatedAt: 1761100000000,
    entries: [],
    ...overrides,
  };
}

function webhookTask(id: string): TaskConfig {
  return {
    id,
    name: id,
    enabled: true,
    monitor: { type: 'webhook', listen: '127.0.0.1', path: `/hook/${id}` },
  };
}

describe('summarizeGoals', () => {
  it('空列表返回全 0', () => {
    expect(summarizeGoals({ goals: [] })).toEqual({ active: 0, done: 0, progress: 0 });
  });

  it('只统计进行中目标，平均进度四舍五入', () => {
    const summary = summarizeGoals({
      goals: [
        goal({ id: 'a', progress: 40 }),
        goal({ id: 'b', progress: 60 }),
        goal({ id: 'c', progress: 20 }),
        goal({ id: 'd', progress: 100, status: 'done', completedAt: 1 }),
      ],
    });
    expect(summary).toEqual({ active: 3, done: 1, progress: 40 });
  });

  it('平均进度按四舍五入取整', () => {
    expect(
      summarizeGoals({ goals: [goal({ id: 'a', progress: 50 }), goal({ id: 'b', progress: 51 })] })
        .progress,
    ).toBe(51);
    expect(
      summarizeGoals({
        goals: [
          goal({ id: 'a', progress: 33 }),
          goal({ id: 'b', progress: 33 }),
          goal({ id: 'c', progress: 33 }),
        ],
      }).progress,
    ).toBe(33);
  });

  it('全部完成时 active=0 且 progress=0', () => {
    expect(
      summarizeGoals({
        goals: [
          goal({ id: 'a', status: 'done', progress: 100, completedAt: 1 }),
          goal({ id: 'b', status: 'done', progress: 100, completedAt: 2 }),
        ],
      }),
    ).toEqual({ active: 0, done: 2, progress: 0 });
  });
});

describe('shouldShowStrip', () => {
  // SPEC-040：阈值 ≥2 → ≥1。只监控一个工具时也要显示它的图标，
  // 单灯形态保留给"没有任何活着的东西"（0 行且无目标行）。
  it('任务 ≥1 就用灯带（SPEC-040：单工具也显示图标）', () => {
    expect(shouldShowStrip(0, 0)).toBe(false);
    expect(shouldShowStrip(1, 0)).toBe(true);
    expect(shouldShowStrip(2, 0)).toBe(true);
  });

  it('有目标行时强制灯带（0/1 个任务也能显示目标行）', () => {
    expect(shouldShowStrip(0, 1)).toBe(true);
    expect(shouldShowStrip(1, 1)).toBe(true);
    expect(shouldShowStrip(3, 1)).toBe(true);
  });
});

describe('TaskStore 与目标摘要（SPEC-025）', () => {
  it('没有目标摘要时按任务数定形态（1 个任务也灯带，SPEC-040）', () => {
    const store = new TaskStore([webhookTask('one')]);
    expect(store.getSnapshot().goalsSummary).toBeUndefined();
    expect(store.getSnapshot().stripMode).toBe(true);
  });

  it('有进行中目标时，即使只有 1 个任务也进入灯带并把摘要带进快照', () => {
    const store = new TaskStore([webhookTask('one')]);
    store.setGoalsSummary({ active: 1, done: 0, progress: 40 });
    const snapshot = store.getSnapshot();
    expect(snapshot.goalsSummary).toEqual({ active: 1, done: 0, progress: 40 });
    expect(snapshot.stripMode).toBe(true);
  });

  it('摘要不变时不重复推送版本', () => {
    const store = new TaskStore([webhookTask('one')]);
    store.setGoalsSummary({ active: 1, done: 0, progress: 40 });
    const version = store.getSnapshot().version;
    store.setGoalsSummary({ active: 1, done: 0, progress: 40 });
    expect(store.getSnapshot().version).toBe(version);
  });

  it('进行中目标清零后回到无目标规则（1 个任务仍灯带，SPEC-040）', () => {
    const store = new TaskStore([webhookTask('one')]);
    store.setGoalsSummary({ active: 1, done: 0, progress: 40 });
    store.setGoalsSummary({ active: 0, done: 1, progress: 0 });
    expect(store.getSnapshot().stripMode).toBe(true);
    expect(store.getSnapshot().goalsSummary).toEqual({ active: 0, done: 1, progress: 0 });
  });

  it('2 个可显示任务在无目标时仍是灯带', () => {
    const store = new TaskStore([webhookTask('one'), webhookTask('two')]);
    expect(store.getSnapshot().stripMode).toBe(true);
  });
});
