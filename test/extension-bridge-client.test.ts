/**
 * 浏览器扩展「按 URL 切标签」客户端测试（SPEC-029）。
 *
 * 【为什么直接测 extension/ 里的 JS】这条链路只在真实 Chrome 里跑，
 * 但它对窗口状态的处理是纯参数逻辑：`windows.update` 传了 `state` 没有。
 * 用假 `chrome` 对象就能把「最小化窗口必须带 state:'normal'」钉死，
 * 不用等真机点一次才发现窗口没还原。
 *
 * 【背景】`chrome.windows.update(id, {focused:true})` 对最小化窗口只做聚焦
 * （Windows 上等价 SetForegroundWindow），窗口仍是 minimized ——
 * 现场表现就是「点 dsh-web 后任务栏图标亮了，但窗口没打开」（用户 2026-10-22 反馈）。
 */

import { describe, expect, it, vi } from 'vitest';

// allowJs（tsconfig.test.json）让 tsc 能直接解析扩展侧的 ESM。
import { activateByUrl } from '../extension/bridge-client.js';

const DSH_WEB_URL = 'http://127.0.0.1:13080';

interface FakeChromeOptions {
  /** 目标窗口状态；缺省 normal。 */
  windowState?: string;
  /** 模拟 windows.get 抛错（窗口刚被关掉）。 */
  getThrows?: boolean;
  /** 模拟没有任何同源标签。 */
  noTab?: boolean;
}

/** 最小可用的假 chrome：只实现 activateByUrl 会碰到的 4 个方法。 */
function fakeChrome(options: FakeChromeOptions = {}) {
  const tab = { id: 42, active: false, windowId: 7, url: `${DSH_WEB_URL}/#/session/abc` };
  const tabs = {
    query: vi.fn(async () => (options.noTab === true ? [] : [tab])),
    update: vi.fn(async (_id: number, _props: Record<string, unknown>) => ({})),
  };
  const windows = {
    get: vi.fn(async (id: number) => {
      if (options.getThrows === true) {
        throw new Error('No window with id: ' + id);
      }
      return { id, state: options.windowState ?? 'normal' };
    }),
    update: vi.fn(async (_id: number, _props: Record<string, unknown>) => ({})),
  };
  return { tabs, windows };
}

describe('activateByUrl（SPEC-029）', () => {
  it('最小化窗口：先激活标签，再带 state:normal 聚焦，确保窗口被还原', async () => {
    const chrome = fakeChrome({ windowState: 'minimized' });

    const result = await activateByUrl(DSH_WEB_URL, chrome);

    expect(result).toMatchObject({ found: true, tabId: 42, windowId: 7 });
    expect(chrome.tabs.update).toHaveBeenCalledWith(42, { active: true });
    expect(chrome.windows.update).toHaveBeenCalledWith(7, { focused: true, state: 'normal' });
  });

  it('正常窗口：只聚焦，不改变窗口状态（不能把最大化/全屏窗口重置）', async () => {
    for (const state of ['normal', 'maximized', 'fullscreen']) {
      const chrome = fakeChrome({ windowState: state });

      const result = await activateByUrl(DSH_WEB_URL, chrome);

      expect(result.found).toBe(true);
      expect(chrome.windows.update).toHaveBeenCalledWith(7, { focused: true });
      expect(chrome.windows.update.mock.calls[0]?.[1]).not.toHaveProperty('state');
    }
  });

  it('windows.get 抛错：不中断切标签，仍尝试聚焦', async () => {
    const chrome = fakeChrome({ getThrows: true });

    const result = await activateByUrl(DSH_WEB_URL, chrome);

    expect(result.found).toBe(true);
    expect(chrome.tabs.update).toHaveBeenCalledWith(42, { active: true });
    expect(chrome.windows.update).toHaveBeenCalledWith(7, { focused: true });
  });

  it('没有同源标签：不碰标签/窗口 API，返回 found:false（交给主进程降级）', async () => {
    const chrome = fakeChrome({ noTab: true });

    const result = await activateByUrl(DSH_WEB_URL, chrome);

    expect(result).toEqual({ found: false, reason: 'no tab' });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(chrome.windows.get).not.toHaveBeenCalled();
    expect(chrome.windows.update).not.toHaveBeenCalled();
  });
});
