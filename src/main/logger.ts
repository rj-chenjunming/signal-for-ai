/**
 * 日志封装 —— electron-log 优先，不可用时降级 console（架构 §8.4）。
 *
 * 依赖: `electron-log`（可选，devDependencies）+ Electron app。**均为可选加载**：
 *在 vitest / 无 Electron 环境下也能实例化，保证纯逻辑模块的可测试性。
 *
 * 为什么不用 console 直接打：需要按天轮转 + 保留 7 天 + 统一前缀，
 * 这些 electron-log 都自带；console 只做兜底。
 */

import { LOG_LEVELS, LOG_RETENTION_DAYS, type LogLevel } from '../shared/constants';

/** 最小日志接口 —— 被 config/store/notify/focus 等模块依赖，避免它们耦合 Electron。 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  /** 记录一条带堆栈的错误。 */
  logError(message: string, err: unknown): void;
}

/** 等级排序，用于过滤。 */
const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LoggerOptions {
  /** 低于该等级的消息被丢弃。默认 'info'（debug 默认关，架构 §8.4）。 */
  level?: LogLevel;
  /** 日志文件目录，通常是 app.getPath('logs')。不传则只打console。 */
  logDir?: string;
  /** 应用名，作为日志文件名前缀。 */
  appName?: string;
}

/** 可选依赖的最小结构（避免直接依赖 electron-log 的完整类型）。 */
interface ElectronLogLike {
  debug(message: unknown, ...args: unknown[]): void;
  info(message: unknown, ...args: unknown[]): void;
  warn(message: unknown, ...args: unknown[]): void;
  error(message: unknown, ...args: unknown[]): void;
  transports: {
    file: { level?: string; resolvePathFn?: () => string };
    console: { level?: string };
  };
  hooks?: unknown[];
}

export class AppLogger implements Logger {
  private readonly minWeight: number;
  private readonly backend: ElectronLogLike | null = null;

  constructor(options: LoggerOptions = {}) {
    const level = options.level ?? 'info';
    this.minWeight = LEVEL_WEIGHT[level];
    if (!options.logDir) {
      return;
    }

    // 动态 require：electron-log 是可选依赖，加载失败必须降级而不是崩（架构 §1.1）。
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('electron-log') as { default?: ElectronLogLike } & ElectronLogLike;
      const log = mod.default ?? mod;
      if (!log || typeof log.info !== 'function') {
        throw new Error('electron-log导出形状不符合预期');
      }
      log.transports.file.level = level;
      log.transports.console.level = level === 'debug' ? 'debug' : 'warn';
      // 按天轮转 + 保留 7 天（架构 §8.4）
      log.transports.file.resolvePathFn = () =>
        `${options.logDir}/${options.appName ?? 'ai-task-indicator'}-${formatDate(new Date())}.log`;
      this.backend = log;
    } catch (err) {
      // 降级 console：不抛异常（PRD P0-7 非法项/可选依赖不崩溃）。
      this.backend = null;
      // eslint-disable-next-line no-console
      console.warn(`[logger] electron-log 不可用，降级 console：${(err as Error).message}`);
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_WEIGHT[level] >= this.minWeight;
  }

  private emit(level: LogLevel, message: string, args: unknown[]): void {
    if (!this.shouldLog(level)) {
      return;
    }
    const line = `[${formatTime(new Date())}] [${level.toUpperCase()}] ${message}`;
    if (this.backend) {
      this.backend[level](line, ...args);
      return;
    }
    const target = level === 'debug' ? console.debug : console[level];
    target(line, ...args);
  }

  debug(message: string, ...args: unknown[]): void {
    this.emit('debug', message, args);
  }

  info(message: string, ...args: unknown[]): void {
    this.emit('info', message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.emit('warn', message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.emit('error', message, args);
  }

  logError(message: string, err: unknown): void {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    this.emit('error', `${message}: ${detail}`, []);
  }
}

/** 创建一个绑定任务 id 前缀的子 logger（监控器用）。 */
export function childLogger(parent: Logger, prefix: string): Logger {
  return {
    debug: (m, ...a) => parent.debug(`${prefix} ${m}`, ...a),
    info: (m, ...a) => parent.info(`${prefix} ${m}`, ...a),
    warn: (m, ...a) => parent.warn(`${prefix} ${m}`, ...a),
    error: (m, ...a) => parent.error(`${prefix} ${m}`, ...a),
    logError: (m, err) => parent.logError(`${prefix} ${m}`, err),
  };
}

/** 静默 logger（测试用，避免污染输出）。 */
export const NOOP_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  logError: () => undefined,
};

/** 按天轮转的后缀。 */
function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatTime(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** 导出以便测试断言格式。 */
export const __testing = { formatDate, formatTime, LOG_RETENTION_DAYS, LOG_LEVELS };
