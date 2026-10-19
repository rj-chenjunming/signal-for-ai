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
