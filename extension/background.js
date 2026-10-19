/**
 * AI 任务指示灯 · 标签切换桥 —— SW 保活（SPEC-003，第二版尝试）
 *
 * ============================================================================
 * 【为什么长这样】
 * ============================================================================
 * MV3 的 service worker 会在**约 30 秒空闲后**被 Chrome 回收。旧实现只在 SW
 * 启动那一刻跑一次轮询循环，且没有注册任何唤醒事件，于是浏览器重启或 SW 被
 * 回收后再也不会连上指示灯 —— 现场表现就是"点一次 web 任务就多一个标签页"，
 * 而且日志里看不出原因（用户 2026-10-19 反馈）。
 *
 * 第一版尝试把长轮询搬进 offscreen 文档：自报显示 `offscreen=ok(WORKERS)`
 * 被接受、文档也"已存在"，但**没有任何一轮心跳**，实际并没有跑起轮询。
 * 所以改成本版更朴素的方案：
 *
 *   1. SW 自己跑长轮询（与旧行为相同，只是加上了自愈）；
 *   2. `chrome.alarms` 每 30 秒唤醒一次（实测本机 Chrome 接受 `periodInMinutes: 0.5`），
 *      每次唤醒都会重置 30 秒空闲计时器 —— 只要定时器被尊重，SW 就不会被回收；
 *   3. `onStartup` / `onInstalled` 兜底，保证浏览器重启、扩展重载后能自己回来；
 *   4. 每次唤醒都 `POST /status` 自报，主进程日志能直接看到"扩展在不在、定时器周期、
 *      轮询在谁身上"，避免再次静默失效。
 */

import { startBridgeClient } from './bridge-client.js';

const WAKE_ALARM = 'lamp-bridge-watch';
const BRIDGE_URL = 'http://127.0.0.1:17891';
const STATUS_HEADERS = { 'x-indicator-extension': '1', 'content-type': 'application/json' };

/** 定时器周期：优先 30 秒（unpacked 允许小于 1 分钟），不支持则退回 1 分钟。 */
const ALARM_PERIODS = [0.5, 1];

const log = (message) => console.log('[lamp-bridge]', message);

let client = null;
let alarmReport = '未知';

function ensureClient() {
  if (client) return;
  client = startBridgeClient({ log: (message) => log(`[sw] ${message}`) });
  log('轮询已启动');
}

/** 自报状态给指示灯（best effort，失败不影响主流程）。 */
async function report(via, polling) {
  const payload = JSON.stringify({
    version: chrome.runtime.getManifest?.()?.version ?? '未知',
    via,
    offscreen: '未使用',
    alarm: alarmReport,
    polling,
  });
  try {
    await fetch(`${BRIDGE_URL}/status`, {
      method: 'POST',
      headers: STATUS_HEADERS,
      body: payload,
      cache: 'no-store',
    });
  } catch {
    /* 指示灯没起/端口没开就算了，下一次唤醒再报 */
  }
}

async function ensureAlarm() {
  for (const periodInMinutes of ALARM_PERIODS) {
    try {
      await chrome.alarms.create(WAKE_ALARM, { periodInMinutes });
      const actual = await chrome.alarms.get?.(WAKE_ALARM);
      alarmReport = actual?.periodInMinutes ? `${actual.periodInMinutes}min` : `${periodInMinutes}min(请求)`;
      return;
    } catch (err) {
      log(`告警定时器创建失败（${periodInMinutes}min）：${err instanceof Error ? err.message : err}`);
    }
  }
  alarmReport = 'fail';
}

async function ensureAlive(via) {
  try {
    await ensureAlarm();
    ensureClient();
    await report(via, 'sw');
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    log(`保活流程异常：${text}`);
    ensureClient();
    await report(via, 'sw(异常)');
  }
}

chrome.runtime.onStartup.addListener(() => {
  void ensureAlive('startup');
});
chrome.runtime.onInstalled.addListener(() => {
  void ensureAlive('installed');
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === WAKE_ALARM) void ensureAlive('alarm');
});

void ensureAlive('worker-start');
