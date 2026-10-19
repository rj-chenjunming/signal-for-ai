/**
 * 浏览器扩展桥接测试（决策 D73 路线②）。
 *
 * 【为什么用真 HTTP 而不是 mock】桥接的全部价值就在"两边真的能对上"：
 * 长轮询会不会挂住、指令能不能毫秒级唤醒、结果能不能回传到等待者。
 * mock 掉 http 就只能验证"我调用了我自己写的函数"，证明不了协议可用
 * —— 这正是项目既有约定（`smoke-e2e` / webhook 测试都真起服务）。
 *
 * 【为什么每个用例用**不同端口**】同一个端口反复 listen/close 会撞上
 * teardown 竞态（前一个 server 的 socket 还没释放，后一个已经 bind），
 * 表现为 ECONNRESET / 心跳收不到 —— 那是测试脚手架的问题，不是被测代码的。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { ExtensionBridge, type ExtensionCommand } from '../src/main/extension-bridge';

/** 每个用例独占一个端口，彻底避开 close/listen 竞态。 */
let nextPort = 17_901;

const HEADERS = { 'x-indicator-extension': '1' };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 轮询到条件成立或超时（避免靠固定 sleep 制造 flaky 测试）。 */
async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(10);
  }
  throw new Error('waitFor 超时');
}

interface PollResult {
  command: ExtensionCommand | null;
}

/**
 * 模拟扩展的一次长轮询。
 *
 * ⚠️ 客户端超时是**正常路径**（服务端最长挂 20s，客户端提前放弃），
 * 所以 abort 必须收敛成 `{command:null}`，不能让它抛出去。
 */
async function pollOnce(port: number, timeoutMs = 3_000): Promise<PollResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/poll`, {
      headers: HEADERS,
      signal: controller.signal,
    });
    return (await res.json()) as PollResult;
  } catch {
    return { command: null };
  } finally {
    clearTimeout(timer);
  }
}

/** 模拟扩展回报执行结果。 */
async function postResult(port: number, id: string, ok: boolean): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/result`, {
    method: 'POST',
    headers: { ...HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ id, ok }),
  });
  return res.status;
}

let bridge: ExtensionBridge | null = null;

afterEach(async () => {
  if (bridge) {
    await bridge.stop();
    bridge = null;
  }
});

/** 起一个独占端口的桥接。 */
async function startBridge(): Promise<{ bridge: ExtensionBridge; port: number }> {
  const port = nextPort++;
  const b = new ExtensionBridge();
  await b.start(port);
  bridge = b;
  return { bridge: b, port };
}

describe('★ ExtensionBridge：活性判定', () => {
  it('没有扩展轮询过 -> isExtensionConnected() 为 false', async () => {
    const { bridge: b } = await startBridge();
    expect(b.isRunning).toBe(true);
    // 关键：没装扩展时必须立刻为 false，否则点击会白等 2 秒
    expect(b.isExtensionConnected()).toBe(false);
  });

  it('★ 只要有一次 /poll 到达，就认为扩展在线', async () => {
    const { bridge: b, port } = await startBridge();
    expect(b.isExtensionConnected()).toBe(false);
    await pollOnce(port, 200); // 客户端 200ms 放弃，但已在服务端留下心跳
    expect(b.isExtensionConnected()).toBe(true);
  });

  it('★ 没有扩展在线时 requestActivate 立刻返回 false（不让用户白等）', async () => {
    const { bridge: b } = await startBridge();
    const t0 = Date.now();
    const ok = await b.requestActivate('http://127.0.0.1:13080');
    expect(ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(300); // 远小于 2s 超时
  });
});

describe('★★ ExtensionBridge：点击 -> 唤醒轮询 -> 结果回传', () => {
  it('★ 挂起的轮询能被点击**立刻**唤醒，并拿到指令', async () => {
    const { bridge: b, port } = await startBridge();
    const poll = pollOnce(port);
    await waitFor(() => b.isExtensionConnected());

    const activate = b.requestActivate('http://127.0.0.1:13080');
    const got = await poll;
    expect(got.command?.url).toBe('http://127.0.0.1:13080');
    expect(typeof got.command?.id).toBe('string');

    // 扩展回报"切到了" -> 等待者拿到 true
    expect(await postResult(port, got.command!.id, true)).toBe(200);
    expect(await activate).toBe(true);
  });

  it('★ 扩展回报 ok=false（没找到标签）-> 返回 false，调用方据此退回"新开"', async () => {
    const { bridge: b, port } = await startBridge();
    const poll = pollOnce(port);
    await waitFor(() => b.isExtensionConnected());

    const activate = b.requestActivate('http://127.0.0.1:13080');
    const got = await poll;
    await postResult(port, got.command!.id, false);
    expect(await activate).toBe(false);
  });

  it('★ 扩展在线但迟迟不回报 -> 超时返回 false（不会永远挂住点击）', async () => {
    const { bridge: b, port } = await startBridge();
    const poll = pollOnce(port, 2_000);
    await waitFor(() => b.isExtensionConnected());

    const t0 = Date.now();
    const ok = await b.requestActivate('http://127.0.0.1:13080', 150);
    expect(ok).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);

    // 收尾：那条轮询其实已经拿到指令（只是我们没回报结果）
    const got = await poll;
    expect(got.command?.url).toBe('http://127.0.0.1:13080');
  });

  it('没有挂起轮询时指令先暂存，下次轮询立刻取走', async () => {
    const { bridge: b, port } = await startBridge();

    // 先用一条"正常走完"的轮询制造心跳（它会拿到一条指令并结束），
    // 这样之后 waiter 列表是干净的 —— 不制造"断开的陈旧连接"这种竞态。
    const first = pollOnce(port, 3_000);
    await waitFor(() => b.isExtensionConnected());
    const act1 = b.requestActivate('http://127.0.0.1:13080', 3_000);
    const got1 = await first;
    await postResult(port, got1.command!.id, true);
    expect(await act1).toBe(true);

    // 此刻没有挂起的 poll：指令应先进暂存槽
    const act2 = b.requestActivate('http://127.0.0.1:13080', 2_000);
    const got2 = await pollOnce(port, 2_000); // 新轮询应立刻取走暂存指令
    expect(got2.command?.url).toBe('http://127.0.0.1:13080');
    await postResult(port, got2.command!.id, true);
    expect(await act2).toBe(true);
  });

  it('★ 陈旧（已断开）的轮询不会吞掉指令 —— 会转投下一个活着的轮询', async () => {
    const { bridge: b, port } = await startBridge();

    // 制造一条"客户端已放弃"的轮询：客户端 150ms 就 abort，服务端稍后才收到 close
    const stale = pollOnce(port, 150);
    await waitFor(() => b.isExtensionConnected());
    await stale;

    // 不等待服务端处理 close，立刻点击 + 立刻挂一条新轮询
    const activate = b.requestActivate('http://127.0.0.1:13080', 2_000);
    const got = await pollOnce(port, 2_000);

    expect(got.command?.url).toBe('http://127.0.0.1:13080');
    await postResult(port, got.command!.id, true);
    expect(await activate).toBe(true);
  });
});

describe('ExtensionBridge：安全与协议边界', () => {
  it('★ 缺少标记头 -> 403（网页无法伪造：自定义头会触发预检，而这里不返回 CORS 头）', async () => {
    const { port } = await startBridge();
    const res = await fetch(`http://127.0.0.1:${port}/poll`);
    expect(res.status).toBe(403);
    const res2 = await fetch(`http://127.0.0.1:${port}/result`, { method: 'POST' });
    expect(res2.status).toBe(403);
  });

  it('未知路径 -> 404', async () => {
    const { port } = await startBridge();
    const res = await fetch(`http://127.0.0.1:${port}/nope`, { headers: HEADERS });
    expect(res.status).toBe(404);
  });

  it('畸形 /result body 不崩，且不解决任何等待者', async () => {
    const { bridge: b, port } = await startBridge();
    const res = await fetch(`http://127.0.0.1:${port}/result`, {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      body: '{ 这不是 json',
    });
    expect(res.status).toBe(200);
    expect(b.isRunning).toBe(true);
  });

  it('★ stop() 会唤醒所有挂起的轮询（否则退出时挂住）', async () => {
    const { bridge: b, port } = await startBridge();
    const poll = pollOnce(port, 5_000);
    await waitFor(() => b.isExtensionConnected());

    await b.stop();
    bridge = null;

    const got = await poll; // 不能挂到 5s 客户端超时
    expect(got.command).toBeNull();
  });

  it('start() 幂等；stop() 后 isRunning 为 false 且活性清零', async () => {
    const { bridge: b, port } = await startBridge();
    await b.start(port); // 第二次是 no-op
    expect(b.isRunning).toBe(true);

    await pollOnce(port, 200);
    expect(b.isExtensionConnected()).toBe(true);

    await b.stop();
    expect(b.isRunning).toBe(false);
    expect(b.isExtensionConnected()).toBe(false);
    bridge = null;
  });
});

describe('SPEC-003/AC-04 扩展是否连上必须可观测', () => {
  it('首次 /poll 打一次"已连接"，连续轮询不重复刷', async () => {
    const logs: string[] = [];
    const port = nextPort++;
    const b = new ExtensionBridge({
      info: (message: string): void => {
        logs.push(message);
      },
      warn: (message: string): void => {
        logs.push(`WARN ${message}`);
      },
    });
    await b.start(port);
    bridge = b;

    // 启动时还没有扩展：此时不能谎报"已连接"
    expect(logs.some((line) => line.includes('扩展已连接'))).toBe(false);

    await pollOnce(port, 200);
    expect(logs.filter((line) => line.includes('扩展已连接')).length).toBe(1);

    // 连续轮询（间隔远小于在线判定窗口）不应反复刷同一条
    await pollOnce(port, 200);
    expect(logs.filter((line) => line.includes('扩展已连接')).length).toBe(1);
  });

  it('扩展可以 POST /status 自报状态：写一条可读日志，畸形 body 也不崩', async () => {
    const logs: string[] = [];
    const port = nextPort++;
    const b = new ExtensionBridge({
      info: (message: string): void => {
        logs.push(message);
      },
      warn: (message: string): void => {
        logs.push(`WARN ${message}`);
      },
    });
    await b.start(port);
    bridge = b;

    const post = (body: string): Promise<number> =>
      fetch(`http://127.0.0.1:${port}/status`, {
        method: 'POST',
        headers: { ...HEADERS, 'content-type': 'application/json' },
        body,
      }).then((res) => res.status);

    expect(
      await post(
        JSON.stringify({
          version: '1.1.0',
          via: 'installed',
          offscreen: 'ok(WORKERS)',
          alarm: '1min',
          polling: 'offscreen',
        }),
      ),
    ).toBe(200);
    const line = logs.find((entry) => entry.includes('扩展自报'));
    expect(line).toBeDefined();
    expect(line).toContain('版本=1.1.0');
    expect(line).toContain('offscreen=ok(WORKERS)');
    expect(line).toContain('轮询=offscreen');

    // 畸形 body 不崩，且仍然记录一条（字段退化为"未知"）
    expect(await post('{ 不是 json')).toBe(200);
    expect(logs.filter((entry) => entry.includes('扩展自报')).length).toBe(2);
    expect(b.isRunning).toBe(true);
  });
});
