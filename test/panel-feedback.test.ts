import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ current: null as any }));
vi.mock('electron', () => ({
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  BrowserWindow: class {
    listeners: Record<string, () => void> = {}; webContents = { send: vi.fn(), on: vi.fn() };
    constructor() { state.current = this; }
    setAlwaysOnTop() {} loadFile() {} once() {} on(name: string, cb: () => void) { this.listeners[name] = cb; }
    isVisible() { return true; } isDestroyed() { return false; } show() {} focus() {} destroy() { this.listeners.closed?.(); }
  },
}));
import { PanelWindow } from '../src/main/panel';
import type { Logger } from '../src/main/logger';
it('lazy feedback handshake retains latest message; ready windows receive messages directly', () => {
  const panel = new PanelWindow({ logger: { info: vi.fn() } as unknown as Logger });
  expect(typeof panel.showMessage).toBe('function');
  panel.showMessage('未找到 dsh 主窗口');
  panel.showMessage('请先打开工具');
  expect(panel.takeMessage()).toEqual({ message: '请先打开工具' });
  expect(panel.takeMessage()).toEqual({});
  panel.showMessage('再次失败');
  expect(state.current.webContents.send).toHaveBeenLastCalledWith('app:toast', { message: '再次失败' });
  panel.destroy();
  panel.showMessage('重建窗口');
  expect(state.current.webContents.send).not.toHaveBeenCalled();
  expect(panel.takeMessage()).toEqual({ message: '重建窗口' });
});
