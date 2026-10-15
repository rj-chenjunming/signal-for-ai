/**
 * 本地 HTTP 接收端 —— webhook 推送 + 只读状态 API。
 *
 * 依赖: Node 内置 `http` / `crypto`。**不依赖 Electron**。
 *
 * 安全措施（架构 §4.4，逐条照抄竞品 ItsJazii/pane 的 loopback-only 做法）：
 *  1. `server.listen(port, '127.0.0.1')` —— 绝不用 0.0.0.0；
 *  2. 校验 `Host` 头 ∈ {`127.0.0.1:port`, `localhost:port`}，防 DNS rebinding；
 *  3. **不返回任何 CORS 头**；
 *  4. `x-indicator-token` 用 `crypto.timingSafeEqual` 比对（防时序攻击）；
 *  5. body 大小限制 64KB，超限 413。
 *
 * 端点：
 *  - `POST /hook/:taskId`  接收状态推送
 *  - `GET  /api/tasks`     只读 JSON 快照
 *  - `GET  /health`        存活探测
 */

import * as crypto from 'node:crypto';
import * as http from 'node:http';

import { HOOK_BODY_LIMIT_BYTES, HOOK_TOKEN_HEADER, LOOPBACK_HOST } from '../../shared/constants';

/** 一次 hook 请求解析后的结果。 */
export interface ParsedHookRequest {
  taskId: string;
  /** JSON body（顶层必须是对象）。 */
  body: Record<string, unknown>;
}

/** 业务侧对一次 hook 请求的处理结果。 */
export interface HookOutcome {
  ok: boolean;
  /** 失败原因（回给调用方的 error 字段）。 */
  error?: string;
  /** HTTP 响应状态码，默认 400。 */
  httpStatus?: number;
  /** 回显的任务状态（成功时填TaskStatus，架构 §4.4 响应示例）。 */
  taskStatus?: string;
}

/** HookServer 事件回调。 */
export interface HookServerHandlers {
  /** 收到合法 hook 请求。返回 ok=false 表示业务侧拒绝（如状态非法），将回 4xx。 */
  onHook: (req: ParsedHookRequest) => HookOutcome;
  /** 提供只读快照。 */
  getSnapshot: () => unknown;
  /** 日志。 */
  log?: (level: 'info' | 'warn' | 'error', message: string, err?: unknown) => void;
}

/** 时序安全的字符串比对。长度不同直接 false（timingSafeEqual 要求等长）。 */
export function safeTokenEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Host 头白名单校验（防 DNS rebinding —— 攻击者把域名解析到 127.0.0.1 绕过同源）。
 */
export function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) {
    return false;
  }
  const allowed = new Set([
    `${LOOPBACK_HOST}:${port}`,
    `localhost:${port}`,
    // 无端口写法（默认 80/443 场景不会出现，但 Host 头可能被省略端口）
    LOOPBACK_HOST,
    'localhost',
    `[::1]:${port}`,
    '::1',
  ]);
  return allowed.has(hostHeader.toLowerCase());
}

/** 从 URL 中安全取出 taskId（不抛异常，非法返回 null）。 */
export function extractTaskId(pathname: string, prefix = '/hook/'): string | null {
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const raw = pathname.slice(prefix.length);
  if (!raw || raw.includes('/')) {
    return null;
  }
  try {
    // decodeURIComponent 可能抛 URIError
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export class HookServer {
  private server: http.Server | null = null;
  private readonly registeredTasks = new Map<string, string | undefined>(); // taskId -> secret

  constructor(
    private readonly port: number,
    private readonly handlers: HookServerHandlers,
  ) {}

  get isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  /** 注册一个 webhook 型任务及其 token（由 WebhookMonitor.start() 调用）。 */
  registerTask(taskId: string, secret?: string): void {
    this.registeredTasks.set(taskId, secret);
  }

  /** 注销任务（WebhookMonitor.stop() 调用）。 */
  unregisterTask(taskId: string): void {
    this.registeredTasks.delete(taskId);
  }

  /** 启动服务。**幂等**（重复调用不会重复 listen）。 */
  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    const server = http.createServer((req, res) => {
      this.safeHandle(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      // 安全措施 1：强制 loopback，绝不 0.0.0.0
      server.listen(this.port, LOOPBACK_HOST);
    });

    this.server = server;
    this.handlers.log?.('info', `HookServer 已启动：http://${LOOPBACK_HOST}:${this.port}`);
  }

  /** 停止服务并注销所有任务。**幂等**。 */
  async stop(): Promise<void> {
    this.registeredTasks.clear();
    const server = this.server;
    if (!server) {
      return;
    }
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // 兜底：强制销毁 keep-alive 连接，避免 close 挂住
      server.closeAllConnections?.();
      setTimeout(resolve, 1_000).unref?.();
    });
    this.handlers.log?.('info', 'HookServer 已停止');
  }

  /** 请求处理总入口 —— 全异常捕获，单个坏请求不能弄崩 server（架构 §8.4）。 */
  private safeHandle(req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      this.handle(req, res);
    } catch (err) {
      this.handlers.log?.('error', 'hook 请求处理异常（已隔离）', err);
      this.sendJson(res, 500, { ok: false, error: 'internal error' });
    }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}:${this.port}`);

    // 安全措施 2：Host 头白名单
    if (!isAllowedHost(req.headers.host, this.port)) {
      this.handlers.log?.('warn', `拒绝非法 Host 头：${req.headers.host}`);
      this.sendJson(res, 403, { ok: false, error: 'forbidden host' });
      return;
    }

    // 注意：全程不设置任何 Access-Control-* 头（安全措施 3）

    if (req.method === 'GET' && url.pathname === '/health') {
      this.sendJson(res, 200, { ok: true, tasks: this.registeredTasks.size });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      this.sendJson(res, 200, this.handlers.getSnapshot());
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/hook/')) {
      void this.handleHook(req, res, url);
      return;
    }

    this.sendJson(res, 404, { ok: false, error: 'not found' });
  }

  private async handleHook(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const taskId = extractTaskId(url.pathname);
    if (!taskId) {
      this.sendJson(res, 404, { ok: false, error: 'unknown task' });
      return;
    }
    if (!this.registeredTasks.has(taskId)) {
      this.sendJson(res, 404, { ok: false, error: 'unknown task' });
      return;
    }

    // 安全措施 4：token 时序安全比对
    const expectedSecret = this.registeredTasks.get(taskId);
    if (expectedSecret) {
      const provided = headerValue(req.headers[HOOK_TOKEN_HEADER]);
      if (!provided || !safeTokenEquals(provided, expectedSecret)) {
        this.handlers.log?.('warn', `任务 ${taskId} token 校验失败`);
        this.sendJson(res, 401, { ok: false, error: 'invalid token' });
        return;
      }
    }

    // 安全措施 5：body 64KB 上限
    let raw: Buffer;
    try {
      raw = await readBody(req, HOOK_BODY_LIMIT_BYTES);
    } catch (err) {
      if ((err as Error).message === 'body too large') {
        this.sendJson(res, 413, { ok: false, error: 'payload too large' });
        return;
      }
      this.sendJson(res, 400, { ok: false, error: 'bad request' });
      return;
    }

    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw.toString('utf8') || '{}');
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        this.sendJson(res, 400, { ok: false, error: 'invalid payload' });
        return;
      }
      body = parsed as Record<string, unknown>;
    } catch {
      this.sendJson(res, 400, { ok: false, error: 'invalid json' });
      return;
    }

    const outcome = this.handlers.onHook({ taskId, body });
    if (!outcome.ok) {
      this.sendJson(res, outcome.httpStatus ?? 400, {
        ok: false,
        error: outcome.error ?? 'rejected',
      });
      return;
    }
    // 架构 §4.4：200 { ok:true, taskId, status, version }
    this.sendJson(res, 200, {
      ok: true,
      taskId,
      status: outcome.taskStatus ?? null,
    });
  }

  private sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
    // 再次强调：不设置 CORS 头
    const text = JSON.stringify(payload ?? {});
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
    });
    res.end(text);
  }
}

/** 读取并限制大小的请求体。 */
function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

/** Node 的 header 值可能是 string | string[]，统一取第一个。 */
function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}
