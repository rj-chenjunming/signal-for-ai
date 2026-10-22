/**
 * SPEC-024 / AC-15、AC-16：目标 Markdown 导出内容的纯函数测试。
 */

import { describe, expect, it } from 'vitest';

import { buildGoalsMarkdown } from '../src/main/goals-export';
import type { Goal, GoalsView } from '../src/shared/types';

const generatedAt = new Date(2026, 9, 22, 11, 30).getTime();

function makeEntry(at: number, kind: 'progress' | 'issue' | 'done', text: string) {
  return { id: `e-${at}-${kind}`, at, kind, text };
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'g1',
    title: '目标 A',
    progress: 40,
    status: 'active',
    createdAt: new Date(2026, 9, 21, 10, 0).getTime(),
    updatedAt: new Date(2026, 9, 22, 9, 0).getTime(),
    entries: [],
    ...overrides,
  };
}

describe('buildGoalsMarkdown', () => {
  it('按「进行中在前、已完成在后」输出，并包含状态、进度与时间', () => {
    const view: GoalsView = {
      goals: [
        makeGoal({
          entries: [
            makeEntry(new Date(2026, 9, 21, 12, 0).getTime(), 'issue', '第二条'),
            makeEntry(new Date(2026, 9, 21, 11, 0).getTime(), 'progress', '第一条'),
          ],
        }),
        makeGoal({
          id: 'g2',
          title: '目标 B',
          progress: 100,
          status: 'done',
          completedAt: new Date(2026, 9, 22, 8, 0).getTime(),
          entries: [makeEntry(new Date(2026, 9, 22, 8, 0).getTime(), 'done', '标记完成')],
        }),
      ],
    };

    const md = buildGoalsMarkdown(view, generatedAt);
    expect(md.startsWith('# 目标清单')).toBe(true);
    expect(md).toContain('导出时间：2026-10-22 11:30');
    expect(md).toContain('## 进行中');
    expect(md).toContain('## 已完成');
    expect(md.indexOf('## 进行中')).toBeLessThan(md.indexOf('## 已完成'));
    expect(md).toContain('### 目标 A');
    expect(md).toContain('状态：进行中');
    expect(md).toContain('进度：40%');
    expect(md).toContain('创建：2026-10-21 10:00');
    expect(md).toContain('完成：2026-10-22 08:00');
    expect(md).toContain('· 进展 · 第一条');
    expect(md).toContain('· 问题 · 第二条');
    expect(md).toContain('· 完成 · 标记完成');

    // 时间线按从旧到新输出，便于阅读
    expect(md.indexOf('· 进展 · 第一条')).toBeLessThan(md.indexOf('· 问题 · 第二条'));
  });

  it('空列表输出合法 Markdown 与「暂无目标」说明', () => {
    const md = buildGoalsMarkdown({ goals: [] }, generatedAt);
    expect(md.startsWith('# 目标清单')).toBe(true);
    expect(md).toContain('暂无目标');
    expect(md).not.toContain('## 进行中');
  });

  it('把标题与记录内容中的换行压成空格，避免破坏 Markdown 结构', () => {
    const view: GoalsView = {
      goals: [
        makeGoal({
          title: '第一行\n第二行',
          entries: [
            makeEntry(new Date(2026, 9, 21, 11, 0).getTime(), 'progress', '进展\n换行'),
          ],
        }),
      ],
    };
    const md = buildGoalsMarkdown(view, generatedAt);
    expect(md).toContain('### 第一行 第二行');
    expect(md).toContain('进展 换行');
    expect(md.split('\n').some((line) => line === '第二行')).toBe(false);
  });
});
