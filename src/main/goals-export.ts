/**
 * 目标清单 Markdown 导出（SPEC-024 / AC-15、AC-16）。
 *
 * 纯函数：不碰 Electron / 文件系统，便于单测。
 * 输出顺序：进行中在前、已完成在后；每条目标的时间线按**从旧到新**排列（便于阅读）。
 */

import type { Goal, GoalEntryKind, GoalsView } from '../shared/types';
import { formatGoalTime } from './goals-store';

/** 单条时间线的类型文案。 */
const ENTRY_KIND_LABEL: Record<GoalEntryKind, string> = {
  progress: '进展',
  issue: '问题',
  done: '完成',
};

/** 把可能含换行的用户文本压成单行，避免破坏 Markdown 结构。 */
function inline(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function renderGoal(goal: Goal): string[] {
  const lines: string[] = [];
  const statusText = goal.status === 'done' ? '已完成' : '进行中';
  lines.push(`### ${inline(goal.title)}`);
  lines.push('');
  lines.push(`- 状态：${statusText}`);
  lines.push(`- 进度：${goal.progress}%`);
  lines.push(`- 创建：${formatGoalTime(goal.createdAt)}`);
  lines.push(`- 更新：${formatGoalTime(goal.updatedAt)}`);
  if (goal.status === 'done' && goal.completedAt !== undefined) {
    lines.push(`- 完成：${formatGoalTime(goal.completedAt)}`);
  }
  lines.push('');
  if (goal.entries.length === 0) {
    lines.push('时间线：暂无记录。');
    return lines;
  }
  lines.push('时间线：');
  // 存储是最新在前，导出按从旧到新读起来更自然。
  for (const entry of [...goal.entries].reverse()) {
    lines.push(
      `- ${formatGoalTime(entry.at)} · ${ENTRY_KIND_LABEL[entry.kind]} · ${inline(entry.text)}`,
    );
  }
  return lines;
}

/**
 * 把目标视图渲染成 Markdown。
 *
 * @param view 当前目标数据
 * @param generatedAt 导出时刻（epoch ms），用于文件头
 */
export function buildGoalsMarkdown(view: GoalsView, generatedAt: number): string {
  const active = view.goals.filter((goal) => goal.status === 'active');
  const done = view.goals.filter((goal) => goal.status === 'done');

  const lines: string[] = ['# 目标清单', '', `导出时间：${formatGoalTime(generatedAt)}`, ''];

  if (active.length === 0 && done.length === 0) {
    lines.push('> 暂无目标。', '');
    return lines.join('\n');
  }

  if (active.length > 0) {
    lines.push(`## 进行中（${active.length}）`, '');
    for (const goal of active) {
      lines.push(...renderGoal(goal), '');
    }
  }
  if (done.length > 0) {
    lines.push(`## 已完成（${done.length}）`, '');
    for (const goal of done) {
      lines.push(...renderGoal(goal), '');
    }
  }

  return lines.join('\n');
}

/** 供渲染层/测试复用的类型文案。 */
export function entryKindLabel(kind: GoalEntryKind): string {
  return ENTRY_KIND_LABEL[kind];
}
