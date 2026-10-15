/**
 * AI 任务指示灯 · 标签切换桥（MV3 service worker）
 *
 * ============================================================================
 * 【它解决什么问题】
 * ============================================================================
 * 指示灯点一下「dsh-web」时，以前只能靠"打开这个网址"，于是每点一次就多一个
 * 标签页。想改成"切到已经开着的那个标签"，就需要能操作浏览器标签的能力：
 *   - Chrome 136 之前：靠 `--remote-debugging-port` + CDP —— 但该端口在
 *     **默认用户数据目录**下已被 Chrome 静默忽略（实测 139 直接报
 *     `DevTools remote debugging requires a non-default data directory`），
 *     只能用在专用调试实例上，碰不到你的日常浏览器；
 *   - 本扩展：`chrome.tabs.update` + `chrome.windows.update`，**不受该限制**，
 *     操作的就是你日常浏览器里的真实标签。
 *
 * ============================================================================
 * 【怎么和指示灯通信】
 * ============================================================================
 * 指示灯在 127.0.0.1:17891 上开了个小服务，本扩展**长轮询**它：
 *   GET  /poll    挂起最多 20s，拿到 {command:{id,url}} 就立刻执行
 *   POST /result  回报 {id, ok} —— ok=false 表示"没找到该标签"，
 *                 指示灯会据此退回"新开标签"，保证点击总有实际效果
 *
 * 长轮询而不是 WebSocket：MV3 的 SW 里挂起的 `fetch` 最稳（无需 ws 依赖、
 * 无需自己实现帧协议），延迟仍是毫秒级。
 *
 * 请求都带 `x-indicator-extension: 1`（指示灯据此确认"是扩展而不是网页"）。
 */

'use strict';

/** 指示灯桥接地址（与主进程 src/shared/constants.ts 的 EXTENSION_BRIDGE_PORT 对齐）。 */
const BRIDGE = 'http://127.0.0.1:17891';

const HEADERS = { 'x-indicator-extension': '1' };

/** 服务端单次挂起上限 20s，客户端留点余量。 */
const POLL_TIMEOUT_MS = 25_000;

/** 指示灯没起 / 端口没开时的退避，避免 SW 里刷爆。 */
const RETRY_MS = 2_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 带超时的 fetch（挂起的轮询不能永远不返回，否则 SW 卡死）。 */
async function fetchWithTimeout(url, options = {}, timeoutMs = POLL_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把 `url` **同源**的标签切到前台。
 *
 * 【为什么按同源而不是按完整 URL 匹配】dsh 的页面会带路径/哈希
 * （`http://127.0.0.1:13080/#/session/...`），但"这一个 web 应用"就是同一个源。
 * 按源匹配才能稳定命中"那个已经开着的页面"。
 *
 * @returns {{found: boolean, tabId?: number, windowId?: number, reason?: string}}
 */
async function activateByUrl(url) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return { found: false, reason: 'bad url' };
  }

  // 读 tab.url 需要 "tabs" 权限（manifest 已声明）
  const tabs = await chrome.tabs.query({});
  const hits = tabs.filter((tab) => {
    if (typeof tab.url !== 'string') return false;
    try {
      return new URL(tab.url).origin === origin;
    } catch {
      return false;
    }
  });
  if (hits.length === 0) {
    return { found: false, reason: 'no tab' };
  }

  // 已经在那个标签上时，只需把窗口聚焦
  const tab = hits.find((t) => t.active === true) ?? hits[0];
  await chrome.tabs.update(tab.id, { active: true });
  if (typeof tab.windowId === 'number') {
    try {
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch {
      /* 窗口可能刚被关掉，忽略 */
    }
  }
  return { found: true, tabId: tab.id, windowId: tab.windowId };
}

/** 回报执行结果（主进程没在听就算了，不影响下次轮询）。 */
async function reportResult(id, ok, detail) {
  try {
    await fetchWithTimeout(
      `${BRIDGE}/result`,
      {
        method: 'POST',
        headers: { ...HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ id, ok, detail }),
      },
      5_000,
    );
  } catch {
    /* ignore */
  }
}

/** 主循环：轮询 -> 执行 -> 回报 -> 再轮询。 */
async function loop() {
  for (;;) {
    try {
      const res = await fetchWithTimeout(`${BRIDGE}/poll`, { headers: HEADERS });
      if (!res.ok) {
        await sleep(RETRY_MS);
        continue;
      }
      const data = await res.json().catch(() => null);
      const cmd = data && data.command;
      if (!cmd || typeof cmd.id !== 'string' || typeof cmd.url !== 'string') {
        continue; // 20s 超时后的空轮询，立刻再排队
      }

      let result;
      try {
        result = await activateByUrl(cmd.url);
      } catch (err) {
        result = { found: false, reason: String(err) };
      }
      await reportResult(cmd.id, result.found === true, result);
    } catch {
      // 指示灯没起 / 端口没开：退避后重试
      await sleep(RETRY_MS);
    }
  }
}

// SW 生命周期内只跑一个循环（SW 被回收后重进时再起一个）
if (globalThis.__lampTabBridgeRunning !== true) {
  globalThis.__lampTabBridgeRunning = true;
  loop();
}
