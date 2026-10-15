/**
 * 浏览器扩展桥接 —— 让「点击指示灯」能在**用户的日常浏览器**里精确切标签。
 *
 * ============================================================================
 * 【为什么需要它（决策 D73 的路线②）】
 * ============================================================================
 * `openUrlTitleMatch` 只能把浏览器**窗口**切到前台（Chrome 窗口标题只反映激活
 * 标签，切不到非激活标签）。而路线①（CDP `Target.activateTarget`）在
 * **Chrome 136 之后被官方堵死**：默认用户数据目录下 `--remote-debugging-port`
 * 被静默忽略（实测 Chrome 139 报
 * `DevTools remote debugging requires a non-default data directory`），
 * 于是 CDP 只能用在"专用调试实例"上，碰不到用户的主浏览器。
 *
 * 扩展走 `chrome.tabs.update({active:true})` + `chrome.windows.update({focused:true})`，
 * **不受该限制**，且操作的就是主浏览器里那些真实标签。
 *
 * ============================================================================
 * 【为什么用长轮询而不是 WebSocket】
 * ============================================================================
 * MV3 的 service worker 里，挂起的 `fetch` 是最稳的保活方式（无需引入 ws 依赖、
 * 无需自己实现帧协议），而且延迟仍是毫秒级：
 *   点击 → 唤醒挂起的 `/poll` → 扩展立刻 `tabs.update` → `POST /result` → 主进程拿到结果。
 *
 * ============================================================================
 * 【投递语义：至少一次（at-least-once），而不是"投给谁算谁的"】
 * ============================================================================
 * 这是本模块最容易写错的一点。扩展的 MV3 service worker **随时可能被回收**，
 * 于是"连接其实已经断了、但服务端还没处理到 close"这个窗口里，把指令投给那条
 * 陈旧连接就会**把指令弄丢** —— 用户看到的是"点了没切成、又新开一个标签"。
 *
 * 所以指令**不消费**：点击把它放进 `pending`，`/poll` 每次都可以取走同一份，
 * 直到扩展 `POST /result` 确认（或本次点击超时）才清空。陈旧连接吞掉一次投递
 * 也没关系 —— 下一次轮询照样能拿到。代价仅是"极端情况下扩展可能对同一指令
 * 执行两次"，而切标签本身是幂等的。
 *
 * ============================================================================
 * 【协议（仅 loopback，且必须带 `x-indicator-extension: 1`）】
 * ============================================================================
 *   GET  /poll            返回当前 `pending` 指令；没有则挂起最多 20s（被点击唤醒）
 *   POST /result          `{id, ok}` —— 扩展回报执行结果并确认收到；
 *                         `ok:false` = 没找到该标签，主进程据此退回"新开"
 *
 * 依赖: Node 内置 `http` / `crypto`。**不依赖 Electron**（可在 vitest 里真起服务验证）。
 */

import * as crypto from 'node:crypto';
import * as http from 'node:http';

import { EXTENSION_BRIDGE_HEADER, EXTENSION_BRIDGE_PORT, LOOPBACK_HOST } from '../shared/constants';

/** 一条"把 url 的标签切到前台"的指令。 */
export interface ExtensionCommand {
  id: string;
  url: string;
}

/** 最小日志接口（与 focus.ts 的 FocusLogger 同形，避免互相依赖）。 */
export interface ExtensionBridgeLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

/** 扩展"还在"的判定窗口：最近一次 poll 距今不超过该值。 */
export const EXTENSION_CONNECTED_WINDOW_MS = 30_000;

/** 单次长轮询在服务端最长挂起时间（略小于扩展侧的 fetch 超时）。 */
export const EXTENSION_POLL_HOLD_MS = 20_000;

/** 点击后等待扩展回报结果的超时（超时按"没切到"处理，退回新开）。 */
export const EXTENSION_ACTIVATE_TIMEOUT_MS = 2_000;

/** 请求体上限（只需要一个 id + 布尔）。 */
const RESULT_BODY_LIMIT_BYTES = 4 * 1024;

/** 一个挂起的长轮询：被唤醒时把**当时**的 pending 回给客户端。 */
interface PollWaiter {
  wake: () => void;
}

export class ExtensionBridge {
  private server: http.Server | null = null;
  /**
   * 待扩展确认的指令。
   *
   * 【为什么是单槽且不随 `/poll` 清空】点击是低频人操作，同一时刻只会有
   * 一条"切到某页"的意图；不清空是为了让"投给陈旧连接"不至于丢指令
   * （见文件头「投递语义」）。
   */
  private pending: ExtensionCommand | null = null;
  /** 正在挂起等待指令的长轮询。 */
  private waiters: PollWaiter[] = [];
  /** 指令 id -> 结果回调（等待扩展回报）。 */
  private readonly results = new Map<string, (ok: boolean) => void>();
  /** 最近一次收到 `/poll` 的时刻（扩展存活心跳）。 */
  private lastPollAt = 0;

  constructor(private readonly logger?: ExtensionBridgeLogger) {}

  get isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  /**
   * 最近是否有扩展在轮询。
   *
   * 【为什么用"最近 poll 过"而不是"连上了"】长轮询本身就是心跳 ——
   * 每次 `/poll` 都证明扩展还活着；没有这个心跳，主进程就不该把点击
   * 押在扩展上（否则扩展没装时点击会白等 2 秒）。
   */
  isExtensionConnected(): boolean {
    return this.lastPollAt > 0 && Date.now() - this.lastPollAt <= EXTENSION_CONNECTED_WINDOW_MS;
  }

  /** 启动桥接服务。**幂等**。 */
  async start(port: number = EXTENSION_BRIDGE_PORT): Promise<void> {
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
      // 与 HookServer 同一安全姿态：强制 loopback，绝不 0.0.0.0
      server.listen(port, LOOPBACK_HOST);
    });

    this.server = server;
    this.logger?.info(`浏览器扩展桥接已启动：http://${LOOPBACK_HOST}:${port}`);
  }

  /** 停止服务并唤醒所有挂起的轮询。**幂等**。 */
  async stop(): Promise<void> {
    this.pending = null;
    for (const waiter of [...this.waiters]) {
      waiter.wake();
    }
    this.waiters = [];
    this.lastPollAt = 0;

    const server = this.server;
    if (!server) {
      return;
    }
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // 兜底：强制销毁 keep-alive 连接，避免 close 挂住（与 HookServer 同做法）
      server.closeAllConnections?.();
      setTimeout(resolve, 500).unref?.();
    });
    this.logger?.info('浏览器扩展桥接已停止');
  }

  /**
   * 请求扩展把 `url` 所在标签切到前台，并等待它的回报。
   *
   * @returns `true` = 扩展确认"已切到"；`false` = 没有扩展在轮询 / 没找到标签 /
   *          超时未回报 —— 调用方应当退回"新开标签"，保证点击总有实际效果。
   */
  async requestActivate(
    url: string,
    timeoutMs: number = EXTENSION_ACTIVATE_TIMEOUT_MS,
  ): Promise<boolean> {
    // 没有扩展在轮询就直接放弃，不让用户白等（点击链路要快）
    if (!this.isRunning || !this.isExtensionConnected()) {
      return false;
    }

    const command: ExtensionCommand = { id: crypto.randomUUID(), url };
    // 放进暂存槽（不清空，见文件头「投递语义」），并唤醒一个挂起的轮询让它立刻取走
    this.pending = command;
    this.waiters.shift()?.wake();

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.results.delete(command.id);
        // 超时即撤回：否则这条指令会在后续轮询里反复投递
        if (this.pending !== null && this.pending.id === command.id) {
          this.pending = null;
        }
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      this.results.set(command.id, (ok: boolean) => {
        clearTimeout(timer);
        this.results.delete(command.id);
        resolve(ok);
      });
    });
  }

  /* ============================================================================
   * HTTP 处理
   * ==========================================================================*/

  private safeHandle(req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      this.handle(req, res);
    } catch (err) {
      // 单个坏请求不能弄崩服务（与 HookServer 同一铁律）
      this.logger?.warn(`扩展桥接请求处理异常（已隔离）：${(err as Error).message}`);
      this.sendJson(res, 500, { ok: false, error: 'internal error' });
    }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`);

    // 只有带标记头的调用方才是扩展（网页带自定义头会触发预检 -> 被挡）
    if (headerValue(req.headers[EXTENSION_BRIDGE_HEADER]) !== '1') {
      this.sendJson(res, 403, { ok: false, error: 'missing extension header' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/poll') {
      this.handlePoll(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/result') {
      void this.handleResult(req, res);
      return;
    }

    this.sendJson(res, 404, { ok: false, error: 'not found' });
  }

  /** 长轮询：有 pending 立刻回（不清空），否则挂起等被点击唤醒 / 20s 超时。 */
  private handlePoll(req: http.IncomingMessage, res: http.ServerResponse): void {
    // 心跳：能走到这里就说明有一个扩展在轮询
    this.lastPollAt = Date.now();

    if (this.pending) {
      this.sendJson(res, 200, { ok: true, command: this.pending });
      return;
    }

    let settled = false;
    const waiter: PollWaiter = {
      wake: (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== waiter);
        if (res.writableEnded || res.destroyed) {
          return; // 客户端已经走了，别再往里写（指令仍在 pending，下次轮询能取到）
        }
        this.sendJson(res, 200, { ok: true, command: this.pending });
      },
    };

    const timer = setTimeout(() => waiter.wake(), EXTENSION_POLL_HOLD_MS);
    timer.unref?.();
    this.waiters.push(waiter);
    // 客户端断开（浏览器关掉 / 扩展 SW 被回收）也要把 waiter 清掉，否则泄漏。
    // 两个事件都挂：不同 Node 版本上 req/res 的 close 触发点略有差异。
    req.on('close', () => waiter.wake());
    res.on('close', () => waiter.wake());
  }

  /** 扩展回报执行结果（同时也是"确认收到"）。 */
  private async handleResult(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: Record<string, unknown> = {};
    try {
      const raw = await readBody(req, RESULT_BODY_LIMIT_BYTES);
      const parsed: unknown = JSON.parse(raw.toString('utf8') || '{}');
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      /* 畸形 body 按"没结果"处理，不报错 */
    }

    const id = typeof body.id === 'string' ? body.id : '';
    const resolver = this.results.get(id);
    if (resolver) {
      resolver(body.ok === true);
    }
    // 收到确认才撤下指令（这就是"不消费"的收尾动作）
    if (this.pending !== null && this.pending.id === id) {
      this.pending = null;
    }
    this.sendJson(res, 200, { ok: true });
  }

  private sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
    // 与 HookServer 一致：**不设置任何 CORS 头**
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
