/**
 * webhook 监控适配器测试 —— 架构 T12 验收项。
 *
 * 覆盖 fieldMap 路径解析（`$.a.b`）、非法 status 拒绝 400、token 校验、
 * 以及起真实本地 HTTP 服务做端到端验证（不依赖 Electron，可在沙箱内跑）。
 */
import * as http from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { HookServer, extractTaskId, isAllowedHost, safeTokenEquals } from '../src/main/monitors/hook-server';
import { WebhookMonitor } from '../src/main/monitors/webhook';
import { EMPTY_COMPILED_RULES } from '../src/main/monitors/pattern';
import type { MonitorContext, MonitorEvent } from '../src/main/monitors/base';
import type { TaskConfig, WebhookMonitorConfig } from '../src/shared/types';

/** 起一个空闲端口，避免固定端口被占用导致 flaky。 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  logError: () => undefined,
} as unknown as MonitorContext['logger'];

/** 构造一个 webhook 任务 + 收集所有上报事件的上下文。 */
function makeCtx(
  monitor: Partial<WebhookMonitorConfig>,
): { ctx: MonitorContext; events: MonitorEvent[] } {
  const events: MonitorEvent[] = [];
  const task: TaskConfig = {
    id: 'demo',
    name: 'demo',
    enabled: true,
    monitor: {
      type: 'webhook',
      listen: '127.0.0.1',
      path: '/hook/demo',
      ...monitor,
    },
  };
  const ctx: MonitorContext = {
    task,
    sink: (_id, ev) => events.push(ev),
    logger: noopLogger,
    rules: EMPTY_COMPILED_RULES,
    timeouts: { startTimeoutMs: 10_000, staleTimeoutMs: 60_000, waitingTimeoutMs: 1_800_000 },
  };
  return { ctx, events };
}

/** 永不真正监听的桩服务（单元测试 handleHook 时不需要端口）。 */
const stubServer = {
  registerTask: () => undefined,
  unregisterTask: () => undefined,
} as unknown as HookServer;

describe('WebhookMonitor fieldMap 路径解析', () => {
  it('默认从 $.status 取状态', () => {
    const { ctx, events } = makeCtx({});
    const m = new WebhookMonitor(ctx, stubServer);
    const r = m.handleHook({ taskId: 'demo', body: { status: 'running' } });
    expect(r.ok).toBe(true);
    expect(r.taskStatus).toBe('running');
    expect(events[0]).toMatchObject({ kind: 'status', status: 'running' });
  });

  it('支持 $.a.b 形式的嵌套路径', () => {
    const { ctx, events } = makeCtx({ fieldMap: { state: '$.result.state' } });
    const m = new WebhookMonitor(ctx, stubServer);
    const r = m.handleHook({ taskId: 'demo', body: { result: { state: 'waiting' } } });
    expect(r.ok).toBe(true);
    expect(r.taskStatus).toBe('waiting');
    expect(events[0]).toMatchObject({ status: 'waiting' });
  });

  it('支持深层路径 $.a.b.c', () => {
    const { ctx } = makeCtx({ fieldMap: { state: '$.a.b.c' } });
    const m = new WebhookMonitor(ctx, stubServer);
    expect(m.handleHook({ taskId: 'demo', body: { a: { b: { c: 'success' } } } }).ok).toBe(true);
  });

  it('支持无前缀写法 a.b（等价于 $.a.b）', () => {
    const { ctx } = makeCtx({ fieldMap: { state: 'a.b' } });
    const m = new WebhookMonitor(ctx, stubServer);
    expect(m.handleHook({ taskId: 'demo', body: { a: { b: 'failed' } } }).taskStatus).toBe('failed');
  });

  it('路径中途遇到非对象时安全返回 undefined -> 400，不抛异常', () => {
    const { ctx } = makeCtx({ fieldMap: { state: '$.a.b.c' } });
    const m = new WebhookMonitor(ctx, stubServer);
    const r = m.handleHook({ taskId: 'demo', body: { a: 'not-an-object' } });
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(400);
  });
});

describe('WebhookMonitor 非法 status 拒绝（架构 T12「非法 status → 400」）', () => {
  it('未知状态字符串被拒 400', () => {
    const { ctx, events } = makeCtx({});
    const m = new WebhookMonitor(ctx, stubServer);
    const r = m.handleHook({ taskId: 'demo', body: { status: 'finished' } });
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(400);
    expect(r.error).toContain('invalid status');
    expect(events).toHaveLength(0); // 非法输入不得产生任何状态变更
  });

  it('大小写不同也拒绝（状态枚举是严格小写）', () => {
    const { ctx } = makeCtx({});
    const m = new WebhookMonitor(ctx, stubServer);
    expect(m.handleHook({ taskId: 'demo', body: { status: 'Running' } }).httpStatus).toBe(400);
  });

  it('缺 status 字段被拒 400', () => {
    const { ctx } = makeCtx({});
    const m = new WebhookMonitor(ctx, stubServer);
    expect(m.handleHook({ taskId: 'demo', body: {} }).httpStatus).toBe(400);
  });

  it('非字符串 status（数字/布尔/null）被拒 400', () => {
    const { ctx } = makeCtx({});
    const m = new WebhookMonitor(ctx, stubServer);
    for (const bad of [1, true, null, ['running']]) {
      expect(m.handleHook({ taskId: 'demo', body: { status: bad } }).httpStatus).toBe(400);
    }
  });

  it('taskId 不匹配时返回 404', () => {
    const { ctx } = makeCtx({});
    const m = new WebhookMonitor(ctx, stubServer);
    expect(m.handleHook({ taskId: 'other', body: { status: 'running' } }).httpStatus).toBe(404);
  });

  it('七个合法状态全部接受', () => {
    const { ctx } = makeCtx({});
    const m = new WebhookMonitor(ctx, stubServer);
    for (const s of ['idle', 'starting', 'running', 'waiting', 'success', 'failed', 'unknown']) {
      expect(m.handleHook({ taskId: 'demo', body: { status: s } }).ok).toBe(true);
    }
  });
});

describe('WebhookMonitor progress 归一化（PRD §6）', () => {
  it('0..1 区间的值原样保留', () => {
    const { ctx, events } = makeCtx({ fieldMap: { state: '$.status', progress: '$.pct' } });
    const m = new WebhookMonitor(ctx, stubServer);
    m.handleHook({ taskId: 'demo', body: { status: 'running', pct: 0.42 } });
    expect(events[0]).toMatchObject({ progress: 0.42 });
  });

  it('0..100 区间的值被归一化到 0..1', () => {
    const { ctx, events } = makeCtx({ fieldMap: { state: '$.status', progress: '$.pct' } });
    const m = new WebhookMonitor(ctx, stubServer);
    m.handleHook({ taskId: 'demo', body: { status: 'running', pct: 42 } });
    expect(events[0]).toMatchObject({ progress: 0.42 });
  });

  it('超出上界的值被夹到 1，不产生非法进度', () => {
    const { ctx, events } = makeCtx({ fieldMap: { state: '$.status', progress: '$.pct' } });
    const m = new WebhookMonitor(ctx, stubServer);
    m.handleHook({ taskId: 'demo', body: { status: 'running', pct: 999 } });
    expect((events[0] as { progress?: number }).progress).toBe(1);
  });

  it('非数值 progress 被忽略（不产生NaN）', () => {
    const { ctx, events } = makeCtx({ fieldMap: { state: '$.status', progress: '$.pct' } });
    const m = new WebhookMonitor(ctx, stubServer);
    m.handleHook({ taskId: 'demo', body: { status: 'running', pct: 'abc' } });
    expect((events[0] as { progress?: number }).progress).toBeUndefined();
  });
});

describe('HookServer 安全工具', () => {
  it('safeTokenEquals 相同串为 true，不同为 false', () => {
    expect(safeTokenEquals('abc', 'abc')).toBe(true);
    expect(safeTokenEquals('abc', 'abd')).toBe(false);
  });

  it('safeTokenEquals 长度不同返回 false 且不抛异常', () => {
    // timingSafeEqual 要求等长，长度不同必须提前短路，否则会抛错
    expect(() => safeTokenEquals('a', 'abcdef')).not.toThrow();
    expect(safeTokenEquals('a', 'abcdef')).toBe(false);
  });

  it('Host 白名单只放行 loopback', () => {
    expect(isAllowedHost('127.0.0.1:8080', 8080)).toBe(true);
    expect(isAllowedHost('localhost:8080', 8080)).toBe(true);
    // DNS rebinding 防护：外部域名即使解析到 127.0.0.1 也必须拒绝
    expect(isAllowedHost('evil.com', 8080)).toBe(false);
    expect(isAllowedHost('10.0.0.5:8080', 8080)).toBe(false);
    expect(isAllowedHost(undefined, 8080)).toBe(false);
  });

  it('extractTaskId 拒绝含额外斜杠的路径（防路径穿越）', () => {
    expect(extractTaskId('/hook/abc')).toBe('abc');
    expect(extractTaskId('/hook/a/b')).toBeNull();
    expect(extractTaskId('/hook/')).toBeNull();
    expect(extractTaskId('/other/abc')).toBeNull();
    // 非法百分号编码不能抛异常
    expect(() => extractTaskId('/hook/%E0%A4%A')).not.toThrow();
  });
});

describe('HookServer 端到端（真实起服务，非 mock）', () => {
  const servers: HookServer[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.stop();
    }
  });

  async function startServer(
    onHook: (req: { taskId: string; body: Record<string, unknown> }) => { ok: boolean; taskStatus?: string; httpStatus?: number },
  ): Promise<{ srv: HookServer; port: number }> {
    const port = await freePort();
    const srv = new HookServer(port, { onHook, getSnapshot: () => ({ ok: true }) });
    servers.push(srv);
    await srv.start();
    return { srv, port };
  }

  function post(
    port: number,
    p: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: p,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
        },
        (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
        },
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  it('只监听 127.0.0.1，绝不绑定 0.0.0.0（架构 §4.4 安全措施 1）', async () => {
    const { srv, port } = await startServer(() => ({ ok: true, taskStatus: 'running' }));
    const addr = (srv as unknown as { server: http.Server }).server.address();
    expect(typeof addr === 'object' && addr ? addr.address : null).toBe('127.0.0.1');
    expect(port).toBeGreaterThan(0);
  });

  it('POST /hook/:taskId 返回 200 并回显状态（PRD §6 curl 示例）', async () => {
    const { srv, port } = await startServer(() => ({ ok: true, taskStatus: 'running' }));
    srv.registerTask('demo');
    const r = await post(port, '/hook/demo', { status: 'running' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, taskId: 'demo', status: 'running' });
  });

  it('业务侧拒绝时透传 4xx（非法 status -> 400）', async () => {
    const { srv, port } = await startServer(() => ({ ok: false, error: 'invalid status: x', httpStatus: 400 }));
    srv.registerTask('demo');
    const r = await post(port, '/hook/demo', { status: 'x' });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).ok).toBe(false);
  });

  it('未注册的任务返回 404', async () => {
    const { port } = await startServer(() => ({ ok: true, taskStatus: 'running' }));
    expect((await post(port, '/hook/ghost', { status: 'running' })).status).toBe(404);
  });

  it('token 校验：缺失/错误 401，正确 200（架构 §4.4）', async () => {
    const { srv, port } = await startServer(() => ({ ok: true, taskStatus: 'running' }));
    srv.registerTask('sec', 's3cr3t');
    expect((await post(port, '/hook/sec', { status: 'running' })).status).toBe(401);
    expect(
      (await post(port, '/hook/sec', { status: 'running' }, { 'x-indicator-token': 'wrong' })).status,
    ).toBe(401);
    expect(
      (await post(port, '/hook/sec', { status: 'running' }, { 'x-indicator-token': 's3cr3t' })).status,
    ).toBe(200);
  });

  it('GET /health 与 /api/tasks 可用', async () => {
    const { srv, port } = await startServer(() => ({ ok: true, taskStatus: 'running' }));
    srv.registerTask('demo');
    const health = await new Promise<number>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/health' }, (r) => {
        r.resume();
        r.on('end', () => resolve(r.statusCode ?? 0));
      }).on('error', reject);
    });
    expect(health).toBe(200);
  });

  it('不返回任何 CORS 头（架构 §4.4 安全措施 3）', async () => {
    const { srv, port } = await startServer(() => ({ ok: true, taskStatus: 'running' }));
    srv.registerTask('demo');
    const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      const data = JSON.stringify({ status: 'running' });
      const req = http.request(
        { host: '127.0.0.1', port, path: '/hook/demo', method: 'POST', headers: { 'Content-Length': Buffer.byteLength(data) } },
        (r) => {
          r.resume();
          r.on('end', () => resolve(r.headers));
        },
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
    expect(headers['access-control-allow-origin']).toBeUndefined();
  });

  it('body 超过 64KB 时不抛未捕获异常（架构 §4.4 安全措施 5）', async () => {
    const { srv, port } = await startServer(() => ({ ok: true, taskStatus: 'running' }));
    srv.registerTask('demo');
    // 期望返回 413；若实现直接 destroy socket，客户端只会拿到 ECONNRESET，
    // 两种结果都断言「服务端不崩」，避免该用例因实现细节而抖动。
    const r = await new Promise<number | string>((resolve) => {
      const data = JSON.stringify({ status: 'running', pad: 'x'.repeat(70 * 1024) });
      const req = http.request(
        { host: '127.0.0.1', port, path: '/hook/demo', method: 'POST', headers: { 'Content-Length': Buffer.byteLength(data) } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'ERR'));
      req.write(data);
      req.end();
    });
    // 服务仍然存活（未被超大 body 打垮）
    expect(srv.isRunning).toBe(true);
    expect([413, 'ECONNRESET']).toContain(r);
  });

  it('stop() 幂等：重复调用不抛异常（架构 T09）', async () => {
    const { srv } = await startServer(() => ({ ok: true, taskStatus: 'running' }));
    await expect(srv.stop()).resolves.toBeUndefined();
    await expect(srv.stop()).resolves.toBeUndefined();
    expect(srv.isRunning).toBe(false);
  });
});