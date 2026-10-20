/**
 * 任务列表面板窗口（PRD P0-4 / §7.3）。
 *
 * 依赖: `electron`（BrowserWindow / screen / nativeTheme）+ shared/*。
 *
 * 规格（PRD §7.3）：
 *  - SPEC-012 宽度 420 DIP，最大高度 520 DIP / 工作区 70%，超出内部滚动
 *  - 跟随系统深/浅色（nativeTheme.shouldUseDarkColors）
 *  - 无边框但**可交互**（与悬浮灯分开的原因见架构 §1.2）
 */

import { BrowserWindow, screen } from 'electron';
import * as path from 'node:path';

import type { Snapshot } from '../shared/types';
import { IPC, IPC_PUSH } from '../shared/ipc-contract';
import type { Logger } from './logger';

/** PRD §7.3 面板尺寸。 */
const PANEL_WIDTH = 420;
const PANEL_MAX_HEIGHT_RATIO = 0.7;
const PANEL_MIN_HEIGHT = 200;

export interface PanelOptions {
  logger: Logger;
  /** 面板关闭时通知宿主（用于清理点击穿透等状态）。 */
  onClosed?: () => void;
}

export class PanelWindow {
  private win: BrowserWindow | null = null;
  private pendingMessage: string | undefined;
  private rendererReady = false;

  constructor(private readonly options: PanelOptions) {}

  /** 懒创建（首次展开时才建窗口，节省启动开销）。 */
  private ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) {
      return this.win;
    }

    const workArea = this.getWorkArea();
    const height = Math.min(520, workArea.height, Math.max(
      PANEL_MIN_HEIGHT,
      Math.floor(workArea.height * PANEL_MAX_HEIGHT_RATIO),
    ));
    const width = Math.min(PANEL_WIDTH, workArea.width);
    // 面板锚定在悬浮灯附近（PRD §7.2「面板以灯为锚点定位」）
    const anchorX = workArea.x + Math.max(0, workArea.width - width - 24);
    const anchorY = workArea.y + Math.max(0, Math.min(96, workArea.height - height));

    this.win = new BrowserWindow({
      width,
      height,
      x: anchorX,
      y: anchorY,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      transparent: false,
      backgroundColor: '#1F2430',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    this.win.setAlwaysOnTop(true, 'floating');

    void this.win.loadFile(path.join(__dirname, '..', 'renderer', 'panel.html'));

    this.win.once('ready-to-show', () => {
      this.win?.show();
      // 面板可交互，需要焦点才能接收键盘事件
      this.win?.focus();
    });

    this.win.on('closed', () => {
      this.win = null;
      this.rendererReady = false;
      this.options.onClosed?.();
    });
    this.win.webContents.on('did-start-loading', () => { this.rendererReady = false; });

    // 点击面板外部 -> 收起（Windows 上 blur 即视为失焦）
    this.win.on('blur', () => {
      // 内部有交互时不收起，避免点按钮时窗口消失
      if (!this.win?.isFocused()) {
        // 延迟一点，等点击事件先落地
        setTimeout(() => {
          if (this.win && !this.win.isDestroyed() && !this.win.isFocused()) {
            this.win.hide();
          }
        }, 150);
      }
    });

    this.options.logger.info(`任务列表面板已创建（${PANEL_WIDTH}x${height}）`);
    return this.win;
  }

  private getWorkArea(): Electron.Rectangle {
    try {
      const cursorPoint = screen.getCursorScreenPoint();
      const display = screen.getDisplayNearestPoint(cursorPoint);
      return display.workArea;
    } catch {
      return { x: 0, y: 0, width: 1920, height: 1080 };
    }
  }

  /** 展开面板。 */
  show(): void {
    const win = this.ensure();
    if (!win.isVisible()) {
      win.show();
      win.focus();
    }
  }

  /** Keep feedback until the renderer has subscribed; no load-time timer race. */
  showMessage(message: string): void {
    this.pendingMessage = message;
    this.show();
    if (this.rendererReady && this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(IPC.APP_TOAST, { message });
      this.pendingMessage = undefined;
    }
  }

  takeMessage(): { message?: string } {
    this.rendererReady = true;
    const message = this.pendingMessage;
    this.pendingMessage = undefined;
    return message === undefined ? {} : { message };
  }

  /** 收起面板。 */
  hide(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.hide();
    }
  }

  /** 切换展开/收起。 */
  toggle(): boolean {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) {
      this.hide();
      return false;
    }
    this.show();
    return true;
  }

  get isVisible(): boolean {
    return this.win !== null && !this.win.isDestroyed() && this.win.isVisible();
  }

  /** 状态变更 -> 推送给渲染层。 */
  setState(snapshot: Snapshot): void {
    if (!this.win || this.win.isDestroyed()) {
      return;
    }
    try {
      this.win.webContents.send(IPC_PUSH.SNAPSHOT, snapshot);
    } catch (err) {
      this.options.logger.warn(`推送状态到面板失败：${(err as Error).message}`);
    }
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
    }
    this.win = null;
    this.rendererReady = false;
  }
}
