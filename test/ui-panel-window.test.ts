import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ area: { x: 0, y: 0, width: 1920, height: 1080 }, options: {} as Record<string, number> }));
vi.mock('electron', () => ({
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ workArea: state.area }) },
  BrowserWindow: class {
    webContents = { on: vi.fn() };
    constructor(options: Record<string, number>) { state.options = options; }
    setAlwaysOnTop() {} loadFile() {} once() {} on() {} isVisible() { return false; } show() {} focus() {}
  },
}));
import { PanelWindow } from '../src/main/panel';
import type { Logger } from '../src/main/logger';
it('panel stays compact and fits a small offset work area', () => {
  const logger = { info: vi.fn() } as unknown as Logger;
  new PanelWindow({ logger }).show();
  expect(state.options.width).toBe(420); expect(state.options.height).toBeLessThanOrEqual(520);
  state.area = { x: -400, y: 40, width: 360, height: 300 };
  new PanelWindow({ logger }).show(); const o = state.options;
  expect(o.x).toBeGreaterThanOrEqual(-400); expect(o.y).toBeGreaterThanOrEqual(40);
  expect(o.x + o.width).toBeLessThanOrEqual(-40); expect(o.y + o.height).toBeLessThanOrEqual(340);
});
