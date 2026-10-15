/**
 * 通知文案构造 —— **刻意不依赖 electron**。
 *
 * 为什么单独成文件：通知内容是 D11 的核心可测部分，
 * 而 `Notification` 来自 electron，在单测里起不来。
 * 把它与 electron 解耦，文案逻辑就能被真实断言覆盖。
 *
 * 设计决策 D11：**只通知三个关键态**（waiting / failed / success），
 * 且**文案必须带端口** —— 多端口场景下光看「⏸ 等待授权」你不知道是哪个实例，
 * 而"哪个实例卡住了"正是本次需求要解决的问题。
 *
 * @module notify-content
 */

import type { TaskState } from '../shared/types';

/** 状态 -> 通知标题前缀。 */
export function statusTitle(status: TaskState['status']): string {
  switch (status) {
    case 'success':
      return '✓ 已完成';
    case 'failed':
      return '✕ 失败';
    case 'waiting':
      return '⏸ 等待授权';
    case 'unknown':
      return '? 失联';
    case 'running':
      return '▶ 运行中';
    case 'starting':
      return '◌ 启动中';
    case 'idle':
    default:
      return '○ 空闲';
  }
}

/** 构造通知文案所需的任务字段（放宽入参，便于单测构造对象）。 */
export type NotifyContentTask = Pick<
  TaskState,
  'name' | 'status' | 'cwd' | 'durationMs' | 'message' | 'portLabel'
>;

/**
 * 构造通知文案。
 *
 * 正文顺序：**端口 → 目录 → 耗时 → 消息**（端口放最前，一眼看出是哪个实例）。
 * `count > 1` 时追加 `×N`，与既有的 30s 去抖计数衔接。
 */
export function buildNotificationContent(
  task: NotifyContentTask,
  count: number,
): { title: string; body: string } {
  const title = `${statusTitle(task.status)} ${task.name}`;
  const badge = count > 1 ? ` ×${count}` : '';

  const bodyParts: string[] = [];
  if (task.portLabel !== undefined && task.portLabel.length > 0) {
    bodyParts.push(`端口 ${task.portLabel}`);
  }
  if (task.cwd !== undefined && task.cwd.length > 0) bodyParts.push(task.cwd);
  if (task.durationMs !== undefined && task.durationMs > 0) {
    bodyParts.push(`耗时 ${formatDuration(task.durationMs)}`);
  }
  if (task.message !== undefined && task.message.length > 0) bodyParts.push(task.message);

  return { title, body: `${bodyParts.join(' · ')}${badge}` };
}

/** 毫秒 -> 「12:31」或「1:02:03」形式。 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}
