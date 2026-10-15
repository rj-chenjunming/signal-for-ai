/**
 * webhook 型监控适配器。
 *
 * 依赖: monitors/hook-server（本地 HTTP 服务）、monitors/base。
 *
 * 语义（PRD §6 webhook + P1-1）：
 *  - 外部工具 POST `/hook/:taskId` 带JSON payload；
 *  - 按 `fieldMap` 提取 state / message / progress（支持 `$.a.b` 路径表达式）；
 *  - state 必须 ∈TaskStatus，否则回 400；
 *  - `heartbeatTimeoutMs` 内无推送 -> unknown（PRD §5.4 防灯一直是绿的）。
 *
 * 端口共享：所有 webhook 型任务共用**一个** HookServer（同一个端口），
 * 由 Host 持有 HookServer 生命周期，各 monitor 只注册/注销自己的路由。
 */

import type { TaskStatus, WebhookMonitorConfig } from '../../shared/types';
import { isTaskStatus } from '../../shared/types';
import { MonitorAdapter, type MonitorContext } from './base';
import type { HookOutcome, HookServer, ParsedHookRequest } from './hook-server';

/** 心跳检查间隔。 */
const HEARTBEAT_CHECK_INTERVAL_MS = 5_000;

export class WebhookMonitor extends MonitorAdapter {
  private readonly cfg: WebhookMonitorConfig;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastPushAt = Date.now();
  private lastStatus: TaskStatus | null = null;

  constructor(
    ctx: MonitorContext,
    /** 由 Host 注入的共享 HookServer（保证只 listen 一个端口）。 */
    private readonly server: HookServer,
  ) {
    super(ctx);
    if (ctx.task.monitor.type !== 'webhook') {
      throw new Error(`WebhookMonitor 收到非 webhook 配置: ${ctx.task.monitor.type}`);
    }
    this.cfg = ctx.task.monitor;
  }

  override async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    this.server.registerTask(this.taskId, this.cfg.secret);
    this.lastPushAt = Date.now();
    this.setRunning(true);

    // 心跳巡检：超时未收到任何推送 -> unknown
    this.heartbeatTimer = setInterval(() => {
      if (this.isDisposed) {
        return;
      }
      this.safeRun('webhook.heartbeat', () => this.checkHeartbeat())();
    }, HEARTBEAT_CHECK_INTERVAL_MS);

    this.log.info(
      `已注册 webhook 端点 ${this.cfg.path}（token ${this.cfg.secret ? '已配置' : '未配置'}）`,
    );
  }

  /** 解析 payload 中指定字段（支持 `$.a.b` 与 `a.b` 两种写法）。 */
  private pick(payload: Record<string, unknown>, expression: string | undefined): unknown {
    if (!expression) {
      return undefined;
    }
    const path = expression.startsWith('$.')
      ? expression.slice(2)
      : expression.startsWith('$')
        ? expression.slice(1)
        : expression;
    if (path.length === 0) {
      return undefined;
    }
    let current: unknown = payload;
    for (const segment of path.split('.')) {
      if (typeof current !== 'object' || current === null) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  }

  /**
   * 处理 hook 请求。由 HookServer 路由调用。
   *
   * @returns ok=false 时由 HookServer 转成 4xx 响应（架构 §5.2 时序图）。
   */
  handleHook(req: ParsedHookRequest): HookOutcome {
    if (req.taskId !== this.taskId) {
      return { ok: false, error: 'unknown task', httpStatus: 404 };
    }

    const stateExpr = this.cfg.fieldMap?.state ?? '$.status';
    const rawState = this.pick(req.body, stateExpr);
    if (!isTaskStatus(rawState)) {
      return {
        ok: false,
        error: `invalid status: ${String(rawState)}（合法值见 PRD §5.1）`,
        httpStatus: 400,
      };
    }
    const status: TaskStatus = rawState;

    const message = this.pick(req.body, this.cfg.fieldMap?.message);
    const rawProgress = this.pick(req.body, this.cfg.fieldMap?.progress);

    this.lastPushAt = Date.now();

    // 进度归一化到0..1（外部工具可能给 0..100）
    let progress: number | undefined;
    if (typeof rawProgress === 'number' && Number.isFinite(rawProgress)) {
      progress = rawProgress > 1 ? rawProgress / 100 : rawProgress;
      progress = Math.min(1, Math.max(0, progress));
    }

    const detail = typeof message === 'string' && message.length > 0 ? message : undefined;

    // 单一写入口：进度随事件一起上报，由 Host 转成 store.apply 的 patch。
    this.emit({
      kind: 'status',
      status,
      message: detail,
      progress,
      at: Date.now(),
    });
    this.lastStatus = status;

    // 回显任务状态，便于调用方确认（架构 §4.4 响应示例：{ok,taskId,status}）
    return { ok: true, taskStatus: status };
  }

  private checkHeartbeat(): void {
    const timeout = this.cfg.heartbeatTimeoutMs ?? 120_000;
    if (Date.now() - this.lastPushAt < timeout) {
      return;
    }
    if (this.lastStatus === 'unknown') {
      return; // 已在 unknown，不重复上报
    }
    this.log.warn(`心跳超时 ${timeout}ms 未收到推送，转 unknown`);
    this.emitStatus('unknown', 'webhook 心跳超时，监控源可能已失联');
    this.lastStatus = 'unknown';
  }

  override async stop(): Promise<void> {
    this.markDisposed();
    this.setRunning(false);
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.server.unregisterTask(this.taskId);
  }
}
