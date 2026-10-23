/**
 * AI 任务指示灯 · 标签切换桥 —— 轮询客户端（SW 与 offscreen 文档共用）
 *
 * ============================================================================
 * 【为什么把轮询从 SW 搬到 offscreen 文档】（SPEC-003）
 * ============================================================================
 * MV3 的 service worker 会在**约 30 秒空闲后**被 Chrome 回收。旧实现只在 SW
 * 启动那一刻跑一次 `loop()`，而 SW 里没有任何唤醒事件，于是：
 *   - 浏览器重启后 SW 不会自己起来；
 *   - 被回收后长轮询也就断了，之后**永远不会**恢复。
 * 现场表现就是：点一盏 web 类任务 -> 指示灯认为"没有扩展" -> 退回新开标签页，
 * 每点一次多一个标签（用户 2026-10-19 反馈）。
 *
 * offscreen 文档是普通文档，不受 SW 的 30 秒回收影响，适合承接这种"常驻长轮询"。
 * SW 只留作看门狗（见 background.js）：onStartup / onInstalled / alarms 时确保
 * offscreen 文档存在。老版本 Chrome 没有 offscreen 时退回 SW 内轮询，行为不会更差。
 *
 * ============================================================================
 * 【协议】与主进程 `src/main/extension-bridge.ts` 对齐
 * ============================================================================
 *   GET  /poll    挂起最多 20s，返回 {command:{id,url}} 或空
 *   POST /result  回报 {id, ok}；ok=false 表示"没找到该标签"，主进程据此退回新开
 *   请求都带 `x-indicator-extension: 1`
 */

/** 指示灯桥接地址（与 src/shared/constants.ts 的 EXTENSION_BRIDGE_PORT 对齐）。 */
export const BRIDGE_URL = 'http://127.0.0.1:17891';

const HEADERS = { 'x-indicator-extension': '1' };

/** 服务端单次挂起上限 20s，客户端留点余量。 */
const POLL_TIMEOUT_MS = 25_000;

/** 指示灯没起 / 端口没开时的退避，避免刷爆。 */
const RETRY_MS = 2_000;

/**
 * "过早返回"时的兜底节流。
 *
 * 【为什么是条件节流而不是固定 sleep】offscreen 文档是隐藏页面，`setTimeout`
 * 可能被 Chrome 节流（1 秒甚至 1 分钟才触发一次）。固定 sleep 会把长轮询的
 * 节奏拖成"每次 30 秒才发一次请求"，反而让点击大概率落空。
 * 正常情况 `/poll` 会被服务端挂起 20s，本身就有节奏；只有一次迭代快于 1s
 * （例如桥接立刻返回）时才补一个短间隔，防忙等。
 */
const MIN_INTERVAL_MS = 50;
const FAST_ITERATION_MS = 1_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 带超时的 fetch（挂起的轮询不能永远不返回）。 */
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
 * @param {string} url
 * @param {typeof chrome} chromeApi
 * @returns {Promise<{found: boolean, tabId?: number, windowId?: number, reason?: string}>}
 */
export async function activateByUrl(url, chromeApi = globalThis.chrome) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return { found: false, reason: 'bad url' };
  }

  // 读 tab.url 需要 "tabs" 权限（manifest 已声明）
  const tabs = await chromeApi.tabs.query({});
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
  await chromeApi.tabs.update(tab.id, { active: true });
  if (typeof tab.windowId === 'number') {
    // 【SPEC-029】`focused: true` 只聚焦，不改变窗口状态：窗口最小化时
    // 这等价于 Windows 的 SetForegroundWindow —— 任务栏图标亮了，窗口仍是
    // minimized（用户 2026-10-22 反馈"点了 dsh-web 只有底下图标会亮"）。
    // 所以先读一次状态，最小化时显式带 state:'normal' 还原；
    // 其它状态（maximized/fullscreen）保持原样，避免把最大化/全屏窗口重置。
    let windowState;
    try {
      windowState = (await chromeApi.windows.get(tab.windowId))?.state;
    } catch {
      /* 窗口可能刚被关掉；按"不改变状态"处理，仍尝试聚焦 */
    }
    const update = { focused: true };
    if (windowState === 'minimized') {
      update.state = 'normal';
    }
    try {
      await chromeApi.windows.update(tab.windowId, update);
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
      `${BRIDGE_URL}/result`,
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

/**
 * 启动轮询循环。
 *
 * 幂等的责任在调用方（SW 用全局标志、offscreen 文档每次创建只跑一次），
 * 这里只负责"跑到 stop() 或进程消失为止"。
 *
 * @param {{chrome?: typeof chrome, log?: (message: string) => void,
 *          onCycle?: (info: {cycle: number, outcome: string, elapsedMs: number}) => void}} [options]
 * @returns {{stop: () => void}}
 */
export function startBridgeClient(options = {}) {
  const chromeApi = options.chrome ?? globalThis.chrome;
  const log = options.log ?? (() => {});
  if (!chromeApi?.tabs) {
    throw new Error('chrome.tabs 不可用（扩展权限或运行环境不对）');
  }

  let stopped = false;

  const loop = async () => {
    log('已开始轮询指示灯桥接');
    let cycle = 0;
    while (!stopped) {
      const startedAt = Date.now();
      let outcome = 'idle';
      try {
        const res = await fetchWithTimeout(`${BRIDGE_URL}/poll`, { headers: HEADERS });
        if (stopped) return;
        if (!res.ok) {
          outcome = `http-${res.status}`;
          await sleep(RETRY_MS);
        } else {
          const data = await res.json().catch(() => null);
          const cmd = data && data.command;
          if (cmd && typeof cmd.id === 'string' && typeof cmd.url === 'string') {
            let result;
            try {
              result = await activateByUrl(cmd.url, chromeApi);
            } catch (err) {
              result = { found: false, reason: String(err) };
            }
            await reportResult(cmd.id, result.found === true, result);
            outcome = result.found === true ? 'activated' : 'not-found';
          } else {
            outcome = 'empty';
          }
        }
      } catch {
        if (stopped) return;
        outcome = 'error';
        // 指示灯没起 / 端口没开：退避后重试
        await sleep(RETRY_MS);
      }

      cycle += 1;
      const elapsedMs = Date.now() - startedAt;
      try {
        options.onCycle?.({ cycle, outcome, elapsedMs });
      } catch {
        /* 心跳回调失败不影响轮询 */
      }
      // 只有"过早返回"时才补间隔，见 MIN_INTERVAL_MS 的说明
      if (elapsedMs < FAST_ITERATION_MS) await sleep(MIN_INTERVAL_MS);
    }
  };

  void loop();

  return {
    stop() {
      stopped = true;
    },
  };
}
