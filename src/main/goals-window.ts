/**
 * 目标清单窗口（SPEC-024 / AC-01、AC-02、AC-19）。
 *
 * 与任务面板的区别（刻意如此）：
 *  - 失焦**不隐藏**：这是备忘录，用户会切到别处再回来继续写；
 *  - 固定 560×640，内容内部滚动；位置不持久化（非目标）；
 *  - 关闭按钮只隐藏窗口，保留渲染状态与滚动位置，下次打开更快。
 */

import { BrowserWindow, screen } from 'electron';
import * as path from 'node:path';

import { IPC_PUSH } from '../shared/ipc-contract';
import type { GoalsView } from '../shared/types';
import type { Logger } from './logger';

const GOALS_WIDTH = 560;
const GOALS_HEIGHT = 640;

export interface GoalsWindowOptions {
  logger: Logger;
}

export class GoalsWindow {
  private win: BrowserWindow | null = null;
  /** destroy() 期间放行 close 事件，避免退出时被 preventDefault 拦下。 */
  private destroying = false;

  constructor(private readonly options: GoalsWindowOptions) {}

  private ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) {
      return this.win;
    }

    const workArea = this.getWorkArea();
    const width = Math.min(GOALS_WIDTH, workArea.width);
    const height = Math.min(GOALS_HEIGHT, workArea.height);
    const x = workArea.x + Math.max(0, workArea.width - width - 24);
    const y = workArea.y + Math.max(0, Math.min(96, workArea.height - height));

    this.win = new BrowserWindow({
      width,
      height,
      x,
      y,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      transparent: false,
      backgroundColor: '#141922',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    this.win.setAlwaysOnTop(true, 'floating');
    void this.win.loadFile(path.join(__dirname, '..', 'renderer', 'goals.html'));

    this.win.once('ready-to-show', () => {
      this.win?.show();
      this.win?.focus();
    });

    // ✕ / Alt+F4 都只隐藏，不销毁：目标数据在渲染层无状态，重开由 getGoals 拉取。
    this.win.on('close', (event) => {
      if (this.destroying) {
        return;
      }
      event.preventDefault();
      this.hide();
    });

    this.win.on('closed', () => {
      this.win = null;
    });

    this.options.logger.info(`目标窗口已创建（${width}x${height}）`);
    return this.win;
  }

  private getWorkArea(): Electron.Rectangle {
    try {
      const cursorPoint = screen.getCursorScreenPoint();
      return screen.getDisplayNearestPoint(cursorPoint).workArea;
    } catch {
      return { x: 0, y: 0, width: 1920, height: 1080 };
    }
  }

  /** 显示并聚焦（已显示时只聚焦，不重复创建）。 */
  show(): void {
    const win = this.ensure();
    if (!win.isVisible()) {
      win.show();
    }
    win.focus();
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.hide();
    }
  }

  toggle(): void {
    if (this.isVisible) {
      this.hide();
      return;
    }
    this.show();
  }

  get isVisible(): boolean {
    return this.win !== null && !this.win.isDestroyed() && this.win.isVisible();
  }

  getBrowserWindow(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  /** 目标数据变更 -> 推送给窗口（窗口未创建时什么都不做，打开时用 getGoals 拉取）。 */
  setView(view: GoalsView): void {
    const win = this.getBrowserWindow();
    if (!win) {
      return;
    }
    try {
      win.webContents.send(IPC_PUSH.GOALS_CHANGED, view);
    } catch (err) {
      this.options.logger.warn(`推送目标数据失败：${(err as Error).message}`);
    }
  }

  destroy(): void {
    this.destroying = true;
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
    }
    this.win = null;
  }
}
