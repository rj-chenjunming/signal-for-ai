/**
 * DshMonitor 适配器单测。
 *
 * 依赖真实本地 HTTP 服务（不 mock fetch）—— 沿用项目惯例：
 * 「本项目重视真实 IO，webhook 型的测试真起了 HTTP 服务」。
 *
 * 覆盖重点：
 *   - 聚合语义（PRD §3.1 优先级）
 *   - 单轮轮询：成功 / 空列表 / 各种失败分类
 *   - 连续失败上限 -> unknown（同 process 型行为）
 *   - 退避序列生效
 *   - 插件精确信号注入 vs 退回近似路径（D2）
 *   - stop() 幂等、不残留定时器
 *   - 错误隔离：任何异常都不逃逸
 */

import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { DshMonitor, StaticSecretSource, LocalCredentialsSource, aggregate } from '../src/main/monitors/dsh';
import { signCookie } from '../src/main/monitors/dsh-instance';
import type { MonitorContext, MonitorEvent } from '../src/main/monitors/base';
import type { TaskConfig, TaskStatus } from '../src/shared/types';

const SECRET = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 收集所有上报事件的假 sink。 */
class RecordingSink {
  readonly events: { taskId: string; ev: MonitorEvent }[] = [];

  readonly sink = (taskId: string, ev: MonitorEvent): void => {
    this.events.push({ taskId, ev });
  };

  statuses(): TaskStatus[] {
    return this.events
      .filter((e) => e.ev.kind === 'status')
      .map((e) => (e.ev as Extract<MonitorEvent, { kind: 'status' }>).status);
  }

  lastStatus(): TaskStatus | undefined {
    return this.statuses().at(-1);
  }

  reset(): void {
    this.events.length = 0;
  }
}

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  logError: () => undefined,
} as unknown as MonitorContext['logger'];

function makeCtx(sink: RecordingSink['sink'], monitorOverrides: Partial<TaskConfig['monitor']> = {}): MonitorContext {
  const task: TaskConfig = {
    id: 'dsh-test',
    name: 'dsh 测试',
    enabled: true,
    monitor: {
      type: 'dsh',
      authority: '127.0.0.1:0', // 由各用例改写
      intervalMs: 60_000, // 拉长：测试只用 pollOnce，不靠定时器
      ...monitorOverrides,
    } as TaskConfig['monitor'],
  };

  return {
    task,
    sink,
    logger: noopLogger,
    rules: { rules: [], errors: [] } as unknown as MonitorContext['rules'],
    timeouts: { startTimeoutMs: 10_000, staleTimeoutMs: 60_000, waitingTimeoutMs: 1_800_000 },
  };
}

/** 起一个假 dsh web：按当前 behaviour 响应。 */
function makeFakeDsh() {
  let behaviour: { status: number; json?: unknown; text?: string } | (() => {
    status: number;
    json?: unknown;
    text?: string;
  }) = { status: 200, json: { items: [] } };
  /** 收到的请求，供断言 cookie 与形状。 */
  const seen: { url?: string; cookie?: string; hadCookie?: boolean; body?: unknown }[] = [];

  /**
   * 造型正确的成功响应：**rpcId 必须回带**，否则 DshClient 会判为串包。
   * 这里复刻真实的 {type,rpcId,result:{ok,value}} 信封。
   */
  const okEnvelope = (reqBody: unknown, value: unknown) => ({
    status: 200,
    json: {
      type: 'server-response',
      rpcId: (reqBody as { rpcId?: string } | undefined)?.rpcId,
      result: { ok: true, value },
    },
  });

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += String(c);
    });
    req.on('end', () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
      seen.push({
        url: req.url,
        cookie: req.headers.cookie,
        hadCookie: req.headers.cookie !== undefined,
        body: parsed,
      });

      const configured = typeof behaviour === 'function' ? behaviour() : behaviour;
      // 配置成"成功"时，自动把 rpcId 包进合规信封
      const out: { status: number; json?: unknown; text?: string } =
        configured.status === 200 && configured.json !== undefined
          ? okEnvelope(parsed, configured.json)
          : configured;

      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(out.json !== undefined ? JSON.stringify(out.json) : (out.text ?? ''));
    });
  });

  return {
    server,
    seen,
    setBehaviour: (b: typeof behaviour) => {
      behaviour = b;
    },
    /** 造型正确的成功响应：rpcId 必须回带。 */
    okSessions: async (items: unknown[]) => {
      behaviour = () => ({ status: 200, json: { items } });
    },
  };
}

/** 一个普通的会话条目。 */
function sessionItem(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'session-a',
    updatedAt: Date.now() - 10_000,
    agentAvailable: true,
    running: false,
    blank: false,
    projections: {
      values: {
        plan: { active: false, pending: false },
        subagentCatalog: [],
      },
    },
    ...over,
  };
}

// ---------------------------------------------------------------------------
describe('aggregate —— 聚合优先级（PRD §3.1）', () => {
  it('空集合 -> idle（没有会话的 dsh 是空闲，不是失联）', () => {
    expect(aggregate([])).toBe('idle');
  });

  it('failed 压过一切', () => {
    expect(aggregate(['idle', 'running', 'failed', 'waiting'])).toBe('failed');
  });

  it('waiting 压过 running/success', () => {
    expect(aggregate(['success', 'running', 'waiting'])).toBe('waiting');
  });

  it('running 压过 success/starting/idle', () => {
    expect(aggregate(['idle', 'starting', 'success', 'running'])).toBe('running');
  });

  it('success 压过 starting/idle', () => {
    expect(aggregate(['idle', 'starting', 'success'])).toBe('success');
  });

  it('idle 压过 unknown', () => {
    expect(aggregate(['unknown', 'idle'])).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
describe('DshMonitor —— 轮询与状态上报', () => {
  let fake: ReturnType<typeof makeFakeDsh>;
  let authority: string;
  let recording: RecordingSink;

  beforeAll(async () => {
    fake = makeFakeDsh();
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
    authority = `127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  });

  afterEach(() => {
    fake.seen.length = 0;
  });

  const makeMonitor = (
    over: Partial<TaskConfig['monitor']> = {},
    opts: { pluginStateFor?: (id: string) => { pendingInteraction?: 'approval' } | undefined } = {},
  ) => {
    recording = new RecordingSink();
    const ctx = makeCtx(recording.sink, { authority, ...over });
    return new DshMonitor(ctx, {
      secretSources: [new StaticSecretSource(SECRET)],
      ...opts,
    });
  };

  it('请求带上正确的自签 cookie，且打到 /api/session/list', async () => {
    await fake.okSessions([sessionItem()]);
    const monitor = makeMonitor();
    await monitor.pollOnce();

    expect(fake.seen).toHaveLength(1);
    expect(fake.seen[0]?.url).toBe('/api/session/list');

    // cookie 里的 issuedAt 是签发时刻，两次调用必然不同，所以**不能**直接比字符串。
    // 改为校验真正该成立的性质：名字对、authority 对、**签名可用密钥独立复算出来**。
    const header = fake.seen[0]?.cookie ?? '';
    const [name, value] = header.split('=');
    expect(name).toBe(signCookie(authority, SECRET).name);

    const parts = (value ?? '').split('.');
    expect(parts[0]).toBe('v1');
    const payload = JSON.parse(
      Buffer.from((parts[1] ?? '').replace(/-/gu, '+').replace(/_/gu, '/'), 'base64').toString('utf8'),
    ) as { version: number; authority: string; issuedAt: number; expiresAt: number };
    expect(payload.version).toBe(1);
    expect(payload.authority).toBe(authority);
    expect(payload.expiresAt).toBeGreaterThan(payload.issuedAt);

    // 独立复算 HMAC，确认签名真的对（错一个字节在真实 dsh 上就是 401）。
    // 密钥必须按**原始字节**参与 HMAC，与 dsh 服务端一致。
    const expectedSig = createHmac('sha256', SECRET as unknown as string)
      .update(parts[1] ?? '', 'utf8')
      .digest()
      .toString('base64')
      .replace(/\+/gu, '-')
      .replace(/\//gu, '_')
      .replace(/=+$/u, '');
    expect(parts[2]).toBe(expectedSig);

    await monitor.stop();
  });

  it('全部会话空闲 -> idle', async () => {
    await fake.okSessions([sessionItem(), sessionItem({ sessionId: 'session-b' })]);
    const monitor = makeMonitor();
    await monitor.pollOnce();

    expect(recording.lastStatus()).toBe('idle');
    expect(monitor.outcome.sessionCount).toBe(2);
    await monitor.stop();
  });

  it('有会话在跑 -> running（聚合到端口）', async () => {
    await fake.okSessions([
      sessionItem({ sessionId: 'a', running: false }),
      sessionItem({ sessionId: 'b', running: true }),
    ]);
    const monitor = makeMonitor();
    await monitor.pollOnce();

    expect(recording.lastStatus()).toBe('running');
    await monitor.stop();
  });

  it('SPEC-021: updatedAt 陈旧但投影活信号推进 → running', async () => {
    const base = Date.now();
    const stale = base - 20 * 60_000;
    const projections = (seq: number) => ({
      asOfSeq: seq,
      values: {
        plan: { active: false, pending: false },
        subagentCatalog: [],
        tokenUsage: { uncachedInputTokens: seq, outputTokens: seq },
        sessionStats: { turns: 1 },
      },
    });
    await fake.okSessions([
      sessionItem({ sessionId: 's1', running: true, updatedAt: stale, projections: projections(1) }),
    ]);
    const monitor = makeMonitor();
    await monitor.pollOnce(base - 60_000);
    expect(recording.lastStatus()).toBe('idle');

    await fake.okSessions([
      sessionItem({ sessionId: 's1', running: true, updatedAt: stale, projections: projections(2) }),
    ]);
    await monitor.pollOnce(base);
    expect(recording.lastStatus()).toBe('running');
    await monitor.stop();
  });

  it('SPEC-021: 活信号停滞 → 仍按 10 分钟上限转 idle', async () => {
    const base = Date.now();
    const stale = base - 20 * 60_000;
    const projections = {
      asOfSeq: 7,
      values: {
        plan: { active: false, pending: false },
        subagentCatalog: [],
        tokenUsage: { uncachedInputTokens: 7, outputTokens: 7 },
        sessionStats: { turns: 1 },
      },
    };
    await fake.okSessions([sessionItem({ sessionId: 's1', running: true, updatedAt: stale, projections })]);
    const monitor = makeMonitor();
    await monitor.pollOnce(base - 60_000);
    await fake.okSessions([sessionItem({ sessionId: 's1', running: true, updatedAt: stale, projections })]);
    await monitor.pollOnce(base);
    expect(monitor.sessionBreakdown.get('s1')).toBe('idle');
    await monitor.stop();
  });

  it('空白会话被跳过，不计入会话数', async () => {
    await fake.okSessions([
      sessionItem({ sessionId: 'real' }),
      sessionItem({ sessionId: 'blank', blank: true }),
    ]);
    const monitor = makeMonitor();
    await monitor.pollOnce();

    expect(monitor.outcome.sessionCount).toBe(1);
    await monitor.stop();
  });

  it('空列表 -> idle，不是 unknown（实例活着只是没会话）', async () => {
    await fake.okSessions([]);
    const monitor = makeMonitor();
    await monitor.pollOnce();

    expect(recording.lastStatus()).toBe('idle');
    expect(monitor.outcome.ok).toBe(true);
    await monitor.stop();
  });

  it('per-session 明细可查（D6 逐会话展示）', async () => {
    await fake.okSessions([
      sessionItem({ sessionId: 'a', running: true }),
      sessionItem({ sessionId: 'b', running: false }),
    ]);
    const monitor = makeMonitor();
    await monitor.pollOnce();

    expect(monitor.sessionBreakdown.get('a')).toBe('running');
    expect(monitor.sessionBreakdown.get('b')).toBe('idle');
    await monitor.stop();
  });
});

// ---------------------------------------------------------------------------
describe('DshMonitor —— 插件精确信号（D2 混合方案的 b 半）', () => {
  let fake: ReturnType<typeof makeFakeDsh>;
  let authority: string;

  beforeAll(async () => {
    fake = makeFakeDsh();
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
    authority = `127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  });

  it('注入插件信号时：pendingInteraction=approval -> waiting（精确）', async () => {
    await fake.okSessions([sessionItem({ sessionId: 's1', running: true })]);
    const recording = new RecordingSink();
    const monitor = new DshMonitor(makeCtx(recording.sink, { authority }), {
      secretSources: [new StaticSecretSource(SECRET)],
      pluginStateFor: (id) => (id === 's1' ? { pendingInteraction: 'approval' } : undefined),
    });

    await monitor.pollOnce();
    expect(recording.lastStatus()).toBe('waiting');
    await monitor.stop();
  });

  it('注入插件信号时：插件报 error -> failed', async () => {
    await fake.okSessions([sessionItem({ sessionId: 's1' })]);
    const recording = new RecordingSink();
    const monitor = new DshMonitor(makeCtx(recording.sink, { authority }), {
      secretSources: [new StaticSecretSource(SECRET)],
      pluginStateFor: () => ({ errorMessage: '工具超时' }),
    });

    await monitor.pollOnce();
    expect(recording.lastStatus()).toBe('failed');
    await monitor.stop();
  });

  it('未注入插件信号时：退回 plan.pending 近似路径（插件失效自动降级）', async () => {
    await fake.okSessions([
      sessionItem({
        sessionId: 's1',
        projections: { values: { plan: { active: true, pending: true }, subagentCatalog: [] } },
      }),
    ]);
    const recording = new RecordingSink();
    const monitor = new DshMonitor(makeCtx(recording.sink, { authority }), {
      secretSources: [new StaticSecretSource(SECRET)],
      // 刻意不注入 pluginStateFor
    });

    await monitor.pollOnce();
    expect(recording.lastStatus()).toBe('waiting');
    await monitor.stop();
  });
});

// ---------------------------------------------------------------------------
describe('DshMonitor —— 失败处理与退避', () => {
  let fake: ReturnType<typeof makeFakeDsh>;
  let authority: string;

  beforeAll(async () => {
    fake = makeFakeDsh();
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
    authority = `127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  });

  const failing = (over: Partial<TaskConfig['monitor']> = {}) => {
    const recording = new RecordingSink();
    const monitor = new DshMonitor(makeCtx(recording.sink, { authority, ...over }), {
      secretSources: [new StaticSecretSource(SECRET)],
    });
    return { monitor, recording };
  };

  it('401 被识别为 auth/unauthorized，首次失败即点亮 failed', async () => {
    fake.setBehaviour(() => ({ status: 401, text: 'unauthorized' }));
    const { monitor, recording } = failing();

    const outcome = await monitor.pollOnce();
    expect(outcome.ok).toBe(false);
    expect(outcome.errorCode).toBe('auth/unauthorized');
    expect(recording.lastStatus()).toBe('failed');
    await monitor.stop();
  });

  it('连续失败到上限 -> 转 unknown，且只上报一次（不刷屏）', async () => {
    fake.setBehaviour(() => ({ status: 401, text: 'unauthorized' }));
    const { monitor, recording } = failing();

    for (let i = 0; i < 6; i += 1) {
      await monitor.pollOnce();
    }

    const unknownCount = recording.statuses().filter((s) => s === 'unknown').length;
    expect(recording.statuses()).toContain('unknown');
    expect(unknownCount).toBe(1);
    await monitor.stop();
  });

  it('失败后重新成功会清零计数并恢复正常状态', async () => {
    fake.setBehaviour(() => ({ status: 401, text: 'unauthorized' }));
    const { monitor, recording } = failing();

    for (let i = 0; i < 5; i += 1) await monitor.pollOnce();
    expect(recording.statuses()).toContain('unknown');

    await fake.okSessions([sessionItem({ running: true })]);
    await monitor.pollOnce();
    expect(recording.lastStatus()).toBe('running');
    expect(monitor.outcome.ok).toBe(true);
    await monitor.stop();
  });

  it('响应不是合法 JSON -> 计入失败，不崩', async () => {
    fake.setBehaviour(() => ({ status: 200, text: 'definitely not json' }));
    const { monitor } = failing();

    const outcome = await monitor.pollOnce();
    expect(outcome.ok).toBe(false);
    expect(outcome.errorCode).toBe('protocol/bad-json');
    await monitor.stop();
  });

  it('连不上 -> transport/unreachable，不抛错', async () => {
    const recording = new RecordingSink();
    const monitor = new DshMonitor(
      makeCtx(recording.sink, { authority: '127.0.0.1:1', timeoutMs: 2_000 }),
      { secretSources: [new StaticSecretSource(SECRET)] },
    );

    const outcome = await monitor.pollOnce();
    expect(outcome.ok).toBe(false);
    expect(outcome.errorCode).toBe('transport/unreachable');
    await monitor.stop();
  });

  it('退避序列生效：失败后下一次轮询被推后（不是固定 interval）', async () => {
    fake.setBehaviour(() => ({ status: 401, text: 'unauthorized' }));
    const { monitor } = failing({ intervalMs: 100 });

    await monitor.pollOnce(); // failureCount = 1 → 退避 >= 1000ms
    // 私有时序不便直接读，用行为断言：等 150ms 后不应发生第二轮（因为退避 >=1s）
    const before = fake.seen.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(fake.seen.length).toBe(before);
    await monitor.stop();
  });
});

// ---------------------------------------------------------------------------
describe('DshMonitor —— 生命周期契约', () => {
  let fake: ReturnType<typeof makeFakeDsh>;
  let authority: string;

  beforeAll(async () => {
    fake = makeFakeDsh();
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
    authority = `127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  });

  it('stop() 幂等：重复调用不报错', async () => {
    await fake.okSessions([sessionItem()]);
    const recording = new RecordingSink();
    const monitor = new DshMonitor(makeCtx(recording.sink, { authority }), {
      secretSources: [new StaticSecretSource(SECRET)],
    });

    await monitor.start();
    await monitor.stop();
    await expect(monitor.stop()).resolves.toBeUndefined();
    await expect(monitor.stop()).resolves.toBeUndefined();
  });

  it('stop() 之后不再轮询（定时器真的被清掉）', async () => {
    await fake.okSessions([sessionItem()]);
    const recording = new RecordingSink();
    const monitor = new DshMonitor(
      makeCtx(recording.sink, { authority, intervalMs: 50 }),
      { secretSources: [new StaticSecretSource(SECRET)] },
    );

    // 不用固定 sleep 等"第一轮落地"——那在负载高时会 flaky。
    // 直接确定性地跑一轮，再用 stop() 切断后续调度。
    await monitor.pollOnce();
    const before = fake.seen.length;
    expect(before).toBeGreaterThan(0);

    await monitor.stop();

    // 等待明显长于 intervalMs(50ms)：若定时器没被清掉，这里会看到新请求
    await new Promise((r) => setTimeout(r, 250));
    expect(fake.seen.length).toBe(before);
  });

  it('isHealthy() 在连不上 dsh 时仍为 true（连不上是业务状态，不是适配器不健康）', async () => {
    const recording = new RecordingSink();
    const monitor = new DshMonitor(
      makeCtx(recording.sink, { authority: '127.0.0.1:1', timeoutMs: 1_000 }),
      { secretSources: [new StaticSecretSource(SECRET)] },
    );

    await monitor.start();
    await monitor.pollOnce();
    // 关键：若这里返回 false，框架会把适配器重建掉，失败计数会丢
    expect(monitor.isHealthy()).toBe(true);
    expect(monitor.outcome.ok).toBe(false);
    await monitor.stop();
    expect(monitor.isHealthy()).toBe(false);
  });

  it('构造函数拒绝非 dsh 配置（防误用）', () => {
    const recording = new RecordingSink();
    const ctx = makeCtx(recording.sink);
    // 手动把 type 改错
    (ctx.task.monitor as { type: string }).type = 'webhook';
    expect(
      () => new DshMonitor(ctx, { secretSources: [new StaticSecretSource(SECRET)] }),
    ).toThrow(/非 dsh 配置/u);
  });

  it('没有任何密钥来源支持该 authority 时，失败但不抛错', async () => {
    const recording = new RecordingSink();
    const monitor = new DshMonitor(makeCtx(recording.sink, { authority }), {
      secretSources: [], // 空来源链
    });

    const outcome = await monitor.pollOnce();
    expect(outcome.ok).toBe(false);
    expect(outcome.errorCode).toBe('credentials/missing');
    expect(recording.lastStatus()).toBe('failed');
    await monitor.stop();
  });
});

// ---------------------------------------------------------------------------
describe('LocalCredentialsSource', () => {
  it('supports() 恒真，但读不到文件时 get() 抛错（由适配器兜住）', async () => {
    const source = new LocalCredentialsSource('D:/definitely/not/a/real/dsh-home');
    expect(source.supports('127.0.0.1:1')).toBe(true);
    await expect(source.get('127.0.0.1:1')).rejects.toThrow(/credentials/u);
  });

  it('读不到本机文件且**配了远端兜底**时，走远端而不是抛错', async () => {
    const source = new LocalCredentialsSource('D:/definitely/not/a/real/dsh-home', async () =>
      Buffer.from('remote-secret-32-bytes-padding!!', 'utf8'),
    );
    const secret = await source.get('127.0.0.1:1');
    expect(secret.byteLength).toBe(32);
  });

  it('★ 回归：本机密钥被服务端拒绝后，下一次必须走远端兜底', async () => {
    // 【这个 bug 真实存在过，别删】
    // 最初的兜底只在「读本机文件失败」时触发。但真实情况是：
    // 本机文件**读得到**（32 字节合法），只是**服务端不认**（401）。
    // 于是 invalidate() 清缓存后，下一轮又把同一把本机密钥读回来，
    // 永远走不到远端 —— 表现为「日志说将尝试 SSH，但永远不尝试」。
    const realDshHome = mkdtempSync(join(tmpdir(), 'indicator-dsh-auth-'));
    writeFileSync(join(realDshHome, '.credentials.yaml'),
      `records:\n  client-connection/browser-session:\n    payload:\n      secret: ${SECRET.toString('base64url')}\n`);
    try {
      let remoteFetches = 0;
      const source = new LocalCredentialsSource(realDshHome, async () => {
        remoteFetches += 1;
        return Buffer.from('remote-secret-32-bytes-padding!!', 'utf8');
      });

      const first = await source.get('127.0.0.1:13080');
      expect(first.byteLength).toBe(32);
      expect(remoteFetches).toBe(0); // 第一次给本机密钥（零开销）

      // 服务端回 401 -> 适配器调用 invalidate()
      source.invalidate();

      const second = await source.get('127.0.0.1:13080');
      expect(remoteFetches).toBe(1); // ← 关键断言：这一次必须换密钥
      expect(second.toString('utf8')).toContain('remote-secret');

      // 之后持续使用远端密钥，不再重复取
      await source.get('127.0.0.1:13080');
      await source.get('127.0.0.1:13080');
      expect(remoteFetches).toBe(1);
    } finally {
      rmSync(realDshHome, { recursive: true, force: true });
    }
  });

  it('本机无该文件且未配远端兜底时，保持原行为（抛错，不静默）', async () => {
    const source = new LocalCredentialsSource('D:/definitely/not/a/real/dsh-home');
    await expect(source.get('127.0.0.1:1')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SPEC-005：authority=auto 的自动发现接线
// ---------------------------------------------------------------------------
describe('DshMonitor —— SPEC-005 authority=auto', () => {
  let fake: ReturnType<typeof makeFakeDsh>;
  let authority: string;

  beforeAll(async () => {
    fake = makeFakeDsh();
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
    authority = `127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  });

  it('首次轮询自动发现并连上；后续轮询复用已选端口，不重复发现', async () => {
    await fake.okSessions([sessionItem({ running: true })]);
    const recording = new RecordingSink();
    let discovers = 0;
    const monitor = new DshMonitor(makeCtx(recording.sink, { authority: 'auto' }), {
      secretSources: [new StaticSecretSource(SECRET)],
      discoverAuthority: async () => {
        discovers += 1;
        return authority;
      },
    });

    const first = await monitor.pollOnce();
    expect(discovers).toBe(1);
    expect(first.ok).toBe(true);
    expect(recording.lastStatus()).toBe('running');

    await monitor.pollOnce();
    expect(discovers).toBe(1); // 复用缓存的 authority
    await monitor.stop();
  });

  it('连续失败后重新发现，并恢复到新端口（桌面端换端口的场景）', async () => {
    await fake.okSessions([sessionItem()]);
    const recording = new RecordingSink();
    const picked: string[] = [];
    const dead = '127.0.0.1:1'; // 必然不可达
    const monitor = new DshMonitor(makeCtx(recording.sink, { authority: 'auto' }), {
      secretSources: [new StaticSecretSource(SECRET)],
      discoverAuthority: async () => {
        const next = picked.length === 0 ? dead : authority;
        picked.push(next);
        return next;
      },
    });

    expect((await monitor.pollOnce()).ok).toBe(false); // 第 1 次失败：连 dead 端口
    expect((await monitor.pollOnce()).ok).toBe(false); // 第 2 次失败：触发重新发现
    expect((await monitor.pollOnce()).ok).toBe(true); // 第 3 轮：新端口可用

    expect(picked).toEqual([dead, authority]);
    await monitor.stop();
  });

  it('发现失败时不崩：按失败计数处理，最终转 unknown', async () => {
    const recording = new RecordingSink();
    const monitor = new DshMonitor(makeCtx(recording.sink, { authority: 'auto' }), {
      secretSources: [new StaticSecretSource(SECRET)],
      discoverAuthority: async () => null,
    });

    for (let i = 0; i < 5; i += 1) {
      await monitor.pollOnce();
    }
    expect(recording.statuses()).toContain('unknown');
    await monitor.stop();
  });
});


// ---------------------------------------------------------------------------
// SPEC-006：dsh 回合结束后亮绿灯（此前 dsh 永远不会产生 success）
// ---------------------------------------------------------------------------
describe('DshMonitor —— SPEC-006 回合完成 -> success', () => {
  let fake: ReturnType<typeof makeFakeDsh>;
  let authority: string;

  beforeAll(async () => {
    fake = makeFakeDsh();
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
    authority = `127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  });

  const doneTurn = (turn: number) => ({ turn, prompt: 'p', response: '写完了' });
  const liveTurn = (turn: number) => ({ turn, prompt: 'p', response: '' });

  /** 一个会话条目（可指定轮次轮廓与最近提示时刻）。 */
  const item = (over: {
    sessionId?: string;
    running?: boolean;
    updatedAt?: number;
    outline?: readonly { turn?: number; prompt?: string; response?: string }[];
    lastPromptAt?: number;
  }): Record<string, unknown> =>
    sessionItem({
      sessionId: over.sessionId ?? 'session-a',
      running: over.running ?? false,
      updatedAt: over.updatedAt ?? Date.now() - 5_000,
      projections: {
        values: {
          plan: { active: false, pending: false },
          subagentCatalog: [],
          ...(over.outline === undefined ? {} : { turnOutline: over.outline }),
          ...(over.lastPromptAt === undefined
            ? {}
            : { sessionListMetadata: { blank: false, lastPromptAt: over.lastPromptAt } }),
        },
      },
    });

  const makeMonitor = (recording: RecordingSink) =>
    new DshMonitor(makeCtx(recording.sink, { authority: 'auto' }), {
      secretSources: [new StaticSecretSource(SECRET)],
      discoverAuthority: async () => authority,
    });

  const statusEvents = (recording: RecordingSink) =>
    recording.events
      .filter((e) => e.ev.kind === 'status')
      .map((e) => e.ev as Extract<MonitorEvent, { kind: 'status' }>);

  it('AC-01 回合结束 → success，且 updatedAt 陈旧也不影响（真机里完成时 updatedAt 不推进）', async () => {
    const recording = new RecordingSink();
    const monitor = makeMonitor(recording);
    const stale = Date.now() - 3_600_000;

    // 第一轮：第 1 回合已完成，第 2 回合在跑（updatedAt 新鲜，running 才判得出来）
    await fake.okSessions([
      item({ running: true, updatedAt: Date.now() - 5_000, outline: [doneTurn(1), liveTurn(2)] }),
    ]);
    await monitor.pollOnce();
    expect(recording.lastStatus()).toBe('running');

    // 第 2 回合完成：updatedAt 仍然陈旧，只有 turnOutline 末项 response 变非空
    const promptAt = Date.now();
    await fake.okSessions([
      item({ updatedAt: stale, outline: [doneTurn(1), doneTurn(2)], lastPromptAt: promptAt }),
    ]);
    await monitor.pollOnce();
    expect(recording.lastStatus()).toBe('success');
    expect(statusEvents(recording).at(-1)?.completionAt).toBe(promptAt);

    // 再轮询一次：绿灯必须保持（同一 completionAt），否则 5 秒后就变灰
    await monitor.pollOnce();
    expect(recording.lastStatus()).toBe('success');
    expect(statusEvents(recording).at(-1)?.completionAt).toBe(promptAt);
    await monitor.stop();
  });

  it('AC-02 启动前就完成的会话不补亮绿灯（启动基线）', async () => {
    const recording = new RecordingSink();
    const monitor = makeMonitor(recording);
    await fake.okSessions([item({ outline: [doneTurn(1)], lastPromptAt: Date.now() - 3_600_000 })]);
    await monitor.pollOnce();

    expect(recording.lastStatus()).toBe('idle');
    expect(statusEvents(recording).some((e) => e.status === 'success')).toBe(false);
    await monitor.stop();
  });

  it('AC-03 被打断（最后回合 response 为空）不算完成', async () => {
    const recording = new RecordingSink();
    const monitor = makeMonitor(recording);
    await fake.okSessions([item({ running: true, outline: [doneTurn(1), liveTurn(2)] })]);
    await monitor.pollOnce();
    expect(recording.lastStatus()).toBe('running');

    await fake.okSessions([item({ running: false, outline: [doneTurn(1), liveTurn(2)] })]);
    await monitor.pollOnce();
    expect(recording.lastStatus()).not.toBe('success');
    await monitor.stop();
  });

  it('AC-04 一个会话在跑、另一个刚完成 → running 优先', async () => {
    const recording = new RecordingSink();
    const monitor = makeMonitor(recording);
    await fake.okSessions([
      item({ sessionId: 'session-a', outline: [doneTurn(1)] }),
      item({ sessionId: 'session-b', outline: [liveTurn(1)] }),
    ]);
    await monitor.pollOnce();

    await fake.okSessions([
      item({ sessionId: 'session-a', running: true, outline: [doneTurn(1), liveTurn(2)] }),
      item({ sessionId: 'session-b', outline: [doneTurn(1)], lastPromptAt: Date.now() }),
    ]);
    await monitor.pollOnce();
    expect(recording.lastStatus()).toBe('running');
    await monitor.stop();
  });

  it('AC-05 上一轮 failed 之后不点亮 success（禁止转移）', async () => {
    const recording = new RecordingSink();
    const monitor = makeMonitor(recording);
    fake.setBehaviour({ status: 500 });
    await monitor.pollOnce();
    expect(recording.lastStatus()).toBe('failed');

    await fake.okSessions([item({ outline: [doneTurn(1)], lastPromptAt: Date.now() })]);
    await monitor.pollOnce();
    expect(recording.lastStatus()).not.toBe('success');
    expect(statusEvents(recording).some((e) => e.status === 'success')).toBe(false);
    await monitor.stop();
  });

  it('AC-06 连续两个回合各自点亮一次（completionAt 递增，不复用旧水位）', async () => {
    const recording = new RecordingSink();
    const monitor = makeMonitor(recording);
    await fake.okSessions([item({ outline: [doneTurn(1)], lastPromptAt: Date.now() - 60_000 })]);
    await monitor.pollOnce();
    expect(recording.lastStatus()).toBe('idle');

    const t2 = Date.now();
    await fake.okSessions([item({ outline: [doneTurn(1), doneTurn(2)], lastPromptAt: t2 })]);
    await monitor.pollOnce();
    expect(recording.lastStatus()).toBe('success');
    expect(statusEvents(recording).at(-1)?.completionAt).toBe(t2);

    // 第 3 回合开始（running）→ 蓝
    await fake.okSessions([item({ running: true, outline: [doneTurn(1), doneTurn(2), liveTurn(3)] })]);
    await monitor.pollOnce();
    expect(recording.lastStatus()).toBe('running');

    const t3 = Date.now() + 1_000;
    await fake.okSessions([item({ outline: [doneTurn(1), doneTurn(2), doneTurn(3)], lastPromptAt: t3 })]);
    await monitor.pollOnce();
    expect(recording.lastStatus()).toBe('success');
    expect(statusEvents(recording).at(-1)?.completionAt).toBe(t3);
    await monitor.stop();
  });
});
// ---------------------------------------------------------------------------
// SPEC-009：轮询看门狗 —— 单轮挂死不能把监控静默闷死
// ---------------------------------------------------------------------------
// 现场：2026-10-19 17:47 之后 dsh-web 的监控再无任何日志（远端密钥本该每 30
// 分钟刷新一次），但进程与其它监控都活着 —— 只有它的 `polling=true` 被一个
// 永不返回的 await 卡死，既不上报也不重排下一轮，灯从此不再更新。
describe('SPEC-009 dsh 轮询看门狗', () => {
  it('第一轮取密钥挂住 -> 看门狗强制释放，下一轮照常跑完（并留下 warn）', async () => {
    const fake = makeFakeDsh();
    await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
    const authority = `127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
    await fake.okSessions([sessionItem()]);

    const logs: string[] = [];
    const recording = new RecordingSink();
    const baseCtx = makeCtx(recording.sink, { authority, intervalMs: 50, timeoutMs: 5_000 });
    const ctx: MonitorContext = {
      ...baseCtx,
      logger: {
        debug: () => undefined,
        info: (m: string) => logs.push(`INFO ${m}`),
        warn: (m: string) => logs.push(`WARN ${m}`),
        error: (m: string) => logs.push(`ERROR ${m}`),
        logError: () => undefined,
      } as unknown as MonitorContext['logger'],
    };

    // 第一次取密钥永不返回（模拟 ssh/远端挂起），之后正常
    let gets = 0;
    const hangingSource = {
      supports: () => true,
      get: () => {
        gets += 1;
        return gets === 1 ? new Promise<Buffer>(() => {}) : Promise.resolve(SECRET);
      },
    };

    const monitor = new DshMonitor(ctx, {
      secretSources: [hangingSource],
      pollWatchdogMs: 80,
    });

    void monitor.pollOnce(); // 永不返回
    // 看门狗 80ms 触发；失败退避（RESTART_BACKOFF_MS[0] ≈ 1s）后才排下一轮
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(logs.some((l) => l.includes('看门狗'))).toBe(true);
    expect(gets).toBeGreaterThanOrEqual(2); // 下一轮真的重新取密钥了
    expect(recording.lastStatus()).toBe('idle'); // 下一轮真的完成了判定

    await monitor.stop();
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  });
});