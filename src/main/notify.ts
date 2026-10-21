/**
 * 通知 + 音效调度（PRD P0-6 / P1-5 / 架构 §1.5、§8.5）。
 *
 * 依赖: `electron`（Notification）+ shared/* + monitors/pattern 的 Debouncer。
 *
 * 去重规则（架构 §8.5，逐条落地）：
 *  - key = `${taskId}:${status}`，窗口内只弹一次，重复时计数 ×N
 *  - **收到 running 时清空该 taskId 的全部去重记录** —— 否则「完成→重新开始→再完成」
 *    的第二次完成会被 30s 窗口误吞
 *  - 仅 notifyStates 白名单内的状态通知
 *  - popup 与 sound **各自独立**（US5：全关时托盘与列表仍正常更新）
 *  - DND：全屏应用时不弹不响，仅托盘变色
 */

import { Notification } from 'electron';

import { Debouncer } from './monitors/pattern';
import { DEFAULT_NOTIFY_SETTINGS } from '../shared/constants';
import { buildNotificationContent } from './notify-content';
import type {
  NotifySettings,
  NotifyActionId,
  Snapshot,
  StateChange,
  TaskState,
} from '../shared/types';
import { IPC_PUSH } from '../shared/ipc-contract';
import type { Logger } from './logger';

/** 通知按钮点击回调。 */
export type NotifyActionHandler = (taskId: string, action: NotifyActionId) => void;

export interface NotifierOptions {
  settings: NotifySettings;
  logger: Logger;
  /** 向渲染层推送音效播放指令。 */
  playSound: (status: TaskState['status']) => void;
  /** 通知按钮被点击。 */
  onAction: NotifyActionHandler;
  /** DND 判定（全屏应用检测），返回 true 表示当前应保持安静。 */
  isDoNotDisturb?: () => boolean;
  /** 当前配置读取（热重载后能拿到新值）。 */
  getSettings?: () => NotifySettings;
}

export class Notifier {
  private settings: NotifySettings;
  private readonly debouncer: Debouncer;
  /** 用户手动点「已读」后抑制该状态的通知，避免误触又弹一次。 */
  private readonly mutedOnce = new Set<string>();

  constructor(private readonly options: NotifierOptions) {
    this.settings = { ...options.settings };
    this.debouncer = new Debouncer(this.settings.debounceMs);
  }

  updateSettings(next: NotifySettings): void {
    this.settings = next;
  }

  private currentSettings(): NotifySettings {
    return this.options.getSettings?.() ?? this.settings;
  }

  /**
   * 状态变更 -> 判断是否需要通知。
   *
   * @param snapshot 当前快照（用于取任务信息与做DND 判断）
   * @param changes 本次变更列表
   */
  onStoreChange(snapshot: Snapshot, changes: StateChange[]): void {
    if (changes.length === 0) {
      return;
    }
    const cfg = this.currentSettings();

    for (const change of changes) {
      // 收到 running -> 清空该任务的去重记录（架构 §8.5 关键规则）
      if (change.to === 'running') {
        this.debouncer.resetTask(change.taskId);
      }
      if (!cfg.notifyStates.includes(change.to)) {
        continue; // 不在白名单（如 starting / running / idle）
      }
      const task = snapshot.tasks.find((t) => t.taskId === change.taskId);
      if (!task || task.processPresent === false) {
        continue;
      }
      this.maybeNotify(task, cfg);
    }
  }

  private maybeNotify(task: TaskState, cfg: NotifySettings): void {
    const mutedKey = `${task.taskId}:${task.status}`;
    if (this.mutedOnce.has(mutedKey)) {
      this.mutedOnce.delete(mutedKey); // 只抑制一次
      return;
    }

    const soundAllowed = cfg.sound && !(cfg.soundOnlyOnFailure && task.status !== 'failed');
    const popupAllowed = cfg.popup;

    // US5：两者都关时**不通知**，但托盘与列表状态仍正常更新（本方法直接返回即可）
    if (!soundAllowed && !popupAllowed) {
      return;
    }

    // DND：全屏应用时不弹不响
    if (cfg.doNotDisturbOnFullscreen && this.options.isDoNotDisturb?.()) {
      this.options.logger.info('全屏免打扰生效，本次不通知（托盘仍变色）');
      return;
    }

    // 去抖：同任务同状态窗口内只弹一次
    const key = `${task.taskId}:${task.status}`;
    const { allowed, count } = this.debouncer.check(key);

    if (soundAllowed) {
      this.options.playSound(task.status);
    }
    if (!allowed) {
      this.options.logger.info(`去抖：${task.name} ${task.status} 在窗口内已通知过（×${count}）`);
      return;
    }
    if (!popupAllowed) {
      return;
    }

    this.showNotification(task, count);
  }

  /** 弹出系统通知（PRD §7.4）。 */
  private showNotification(task: TaskState, count: number): void {
    if (!Notification.isSupported()) {
      this.options.logger.warn('系统通知不可用，降级为仅音效 + 托盘变色');
      return;
    }

    // 文案抽取成纯函数，便于单测（Notification 本身依赖 electron，测不了）
    const { title, body } = buildNotificationContent(task, count);

    const actions = this.currentSettings().actions.map((a) => ({
      type: 'button' as const,
      text: a.label,
    }));

    const notification = new Notification({
      title,
      body,
      // Windows 上 toast 最多 3 个按钮（PRD §7.4）
      actions,
      silent: true, // 音效由 Web Audio 合成（D5），避免与系统音叠加
      timeoutType: 'default',
    });

    notification.on('click', () => {
      this.options.onAction(task.taskId, 'focus_terminal');
    });
    notification.on('action', (_event: unknown, index: number) => {
      const action = this.currentSettings().actions[index];
      if (action) {
        this.options.onAction(task.taskId, action.id);
      }
    });

    try {
      notification.show();
      this.options.logger.info(`已弹出通知：${title}`);
    } catch (err) {
      this.options.logger.warn(`弹出通知失败：${(err as Error).message}`);
    }
  }

  /** 用户手动点过某状态的通知 -> 下次同状态不再打扰。 */
  muteOnce(taskId: string, status: TaskState['status']): void {
    this.mutedOnce.add(`${taskId}:${status}`);
  }

  /** 托盘气泡（配置错误等场景）。 */
  dispose(): void {
    this.debouncer.clear();
    this.mutedOnce.clear();
  }
}

/**
 * 状态文案与通知正文的实现在 notify-content.ts（**不依赖 electron**），
 * 这里只做转发，保持既有 import 路径兼容的同时让文案逻辑可被单测覆盖。
 */
export { statusTitle, buildNotificationContent, formatDuration } from './notify-content';

/** 默认设置导出，供 index.ts 初始化时使用。 */
export { DEFAULT_NOTIFY_SETTINGS };

/** 供 tray / overlay 复用的推送通道名。 */
export { IPC_PUSH };
