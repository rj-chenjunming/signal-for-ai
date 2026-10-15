/**
 * 监控适配器抽象基类 —— 生命周期契约 + 错误隔离（架构 §4.2）。
 *
 * 依赖: 仅 shared/* 与 logger 的接口类型。**不依赖 Electron**。
 *
 * 【最重要的契约】单个监控适配器的任何异常都**绝不能**扩散到主进程或其他适配器：
 *  - `emit()` 内部全异常捕获；
 *  - 框架侧（monitors/index 里的 MonitorHost）在 start()/stop() 外再包一层 try-catch；
 *  - 适配器自己注册的定时器/子进程回调也必须自行 try-catch（本文件提供 safeRun 辅助方法）。
 */

import type { Logger } from '../logger';
import type { TaskConfig } from '../../shared/types';
import type { CompiledRules } from './pattern';
import type { TaskStatus } from '../../shared/types';

/**
 * 监控器上报的事件 —— 适配器只管产出，状态机由框架处理。
 *
 * `progress` 是 webhook 专有字段（PRD §6 fieldMap.progress）：它**不改变状态**，
 * 只更新面板上的进度展示，因此单独成字段而不是塞进 status 的 message。
 */
export type MonitorEvent =
  | {
      kind: 'status';
      status: TaskStatus;
      message?: string;
      /** 0..1，仅 webhook 会给。 */
      progress?: number;
      /**
       * 本次上报对应的**完成时刻**（仅 success 有意义）。
       *
       * 用于「亮到点击才熄」：sqlite 型每轮都会读到"最近一次完成是什么时候"，
       * store 拿这个值和"已确认水位"比较 ——
       * 若 `completionAt <= 已确认水位`，说明这个完成事件用户**已经点过了**，
       * 丢弃即可，绿灯不会再亮。这样"同一个完成"只提醒一次，
       * 而新任务完成会再次点亮。
       */
      completionAt?: number;
      at: number;
    }
  | { kind: 'heartbeat'; at: number };

/** 监控器上报的唯一出口。 */
export type MonitorSink = (taskId: string, ev: MonitorEvent) => void;

/** 监控器运行所需的全部上下文。 */
export interface MonitorContext {
  task: TaskConfig;
  sink: MonitorSink;
  logger: Logger;
  /** 预编译的正则规则（pattern.ts 提供），避免每轮重编译。 */
  rules: CompiledRules;
  /** 该任务最终生效的超时值（已合并 defaults 与 monitor 级覆盖）。 */
  timeouts: {
    startTimeoutMs: number;
    staleTimeoutMs: number;
    waitingTimeoutMs: number;
  };
  /**
   * 读取该任务**已确认的完成水位**（用户点掉绿灯时的完成时刻），没有则 0。
   *
   * 只有 `sqlite` 型会用到。为什么要有它：该型是**轮询**的，
   * 点掉绿灯后下一轮又会从数据库读到"有会话完成了"，
   * 于是绿灯立刻复亮 —— 点击等于没点。
   * 有了这个水位，监控就能自己判断"这个完成是不是用户已经点过的"。
   */
  ackedCompletionAt?: () => number;
}

export abstract class MonitorAdapter {
  protected ctx: MonitorContext;
  private running = false;
  private disposed = false;

  constructor(ctx: MonitorContext) {
    this.ctx = ctx;
  }

  /** 启动监控。抛出的异常会被框架捕获，该任务转 unknown + 记日志。 */
  abstract start(): Promise<void>;

  /** 停止并释放全部资源/句柄/子进程。**必须幂等**（可重复调用不报错）。 */
  abstract stop(): Promise<void>;

  /** 框架查询健康状态（心跳是否还在跳）。 */
  isHealthy(): boolean {
    return this.running && !this.disposed;
  }

  get taskId(): string {
    return this.ctx.task.id;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** 【框架调用】把 running/disposed 状态同步给适配器，供start/stop 自行判断。 */
  protected setRunning(value: boolean): void {
    this.running = value;
  }

  protected markDisposed(): void {
    this.disposed = true;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * 安全执行上报 —— 捕获 sink 抛出的任何异常。
   * sink 内部会写 store，理论上不该抛，但跨进程回调（webhook）路径确实可能。
   */
  protected emit(ev: MonitorEvent): void {
    try {
      this.ctx.sink(this.ctx.task.id, ev);
    } catch (err) {
      this.ctx.logger.error(`sink 上报异常（已隔离）`, err);
    }
  }

  /** 上报状态变化。 */
  protected emitStatus(status: TaskStatus, message?: string, progress?: number): void {
    this.emit({ kind: 'status', status, message, progress, at: Date.now() });
  }

  /** 上报心跳（只刷新 lastSignalAt，不改状态）。 */
  protected emitHeartbeat(): void {
    this.emit({ kind: 'heartbeat', at: Date.now() });
  }

  /**
   * 包装定时器/事件回调，确保异常不逃逸成 uncaughtException。
   * 所有 setInterval / stream on('data') 都必须经过它。
   */
  protected safeRun<T extends unknown[]>(
    where: string,
    fn: (...args: T) => void,
  ): (...args: T) => void {
    return (...args: T) => {
      try {
        fn(...args);
      } catch (err) {
        this.ctx.logger.error(`${where} 执行异常（已隔离）`, err);
      }
    };
  }

  /** 绑定 taskId 前缀的 logger。 */
  protected get log(): Pick<Logger, 'debug' | 'info' | 'warn' | 'error' | 'logError'> {
    const prefix = `[${this.ctx.task.id}]`;
    const l = this.ctx.logger;
    return {
      debug: (m, ...a) => l.debug(`${prefix} ${m}`, ...a),
      info: (m, ...a) => l.info(`${prefix} ${m}`, ...a),
      warn: (m, ...a) => l.warn(`${prefix} ${m}`, ...a),
      error: (m, ...a) => l.error(`${prefix} ${m}`, ...a),
      logError: (m, err) => l.logError(`${prefix} ${m}`, err),
    };
  }
}
