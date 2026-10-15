/**
 * process 型监控适配器。
 *
 * 依赖: monitors/process-enum（POC §8 的 Get-CimInstance 长驻枚举器）、
 *       monitors/log-tail（fallbackLog 增量读取）、monitors/base。
 *
 * 状态判定语义（PRD P0-8）：
 *  - 匹配到进程：首见 -> starting；持续存活 -> running + 心跳
 *  - 进程消失 + graceMs 内未重现 -> 按 onExit 判定 success / failed
 *
 * 关键工程约束（**POC 实测结论，不要想当然改写**）：
 *  1. 绝不用 wmic（POC 实测被安全策略拉黑/超时）；
 *  2. 命令行匹配依赖 CIM；降级到 tasklist 后 cmdlineContains 不可用，
 *     **必须明确告警并降级为「仅进程名匹配」**，不能静默给出错误结论；
 *  3. 无法读取历史退出码，因此 onExit.successExitCodes 的语义是
 *     「能否判定为成功」而非「真实退出码等于 N」——不可判定时保守判failed（宁可报警）。
 */

import {
  DEFAULT_EXIT_GRACE_MS,
  DEFAULT_IDLE_AFTER_SILENCE_MS,
  DEFAULT_ON_DEMAND_INTERVAL_MS,
  DEFAULT_PROCESS_POLL_MS,
  DEFAULT_START_END_BYTES,
} from '../../shared/constants';
import type { ProcessMonitorConfig, TaskStatus } from '../../shared/types';
import { MonitorAdapter, type MonitorContext } from './base';
import {
  createCursor,
  globFiles,
  splitLines,
  tailRead,
  type TailCursor,
} from './log-tail';
import {
  ResidentProcessEnumerator,
  runCimOnce,
  runTasklist,
  type ProcessInfo,
} from './process-enum';

/** 进程监控器的可调参数（由框架按 app.processPollMode 注入）。 */
export interface ProcessMonitorOptions {
  /** resident = 长驻 PS 子进程（默认，POC §8）；onDemand = 每次 spawn 一次（省内存但慢）。 */
  mode: 'resident' | 'onDemand';
  /** 长驻模式的枚举间隔。 */
  pollMs: number;
  /** onDemand 模式的轮询间隔。 */
  onDemandIntervalMs: number;
  /** fallbackLog 的增量轮询间隔。 */
  fallbackLogIntervalMs: number;
}

const DEFAULT_OPTIONS: ProcessMonitorOptions = {
  mode: 'resident',
  pollMs: DEFAULT_PROCESS_POLL_MS,
  onDemandIntervalMs: DEFAULT_ON_DEMAND_INTERVAL_MS,
  fallbackLogIntervalMs: DEFAULT_IDLE_AFTER_SILENCE_MS,
};

export class ProcessMonitor extends MonitorAdapter {
  private readonly cfg: ProcessMonitorConfig;
  private readonly opts: ProcessMonitorOptions;
  private enumerator: ResidentProcessEnumerator | null = null;
  private onDemandTimer: NodeJS.Timeout | null = null;
  private exitTimer: NodeJS.Timeout | null = null;
  private fallbackTimer: NodeJS.Timeout | null = null;

  /** 上一轮是否有匹配进程（用于检测消失）。 */
  private alive = false;
  /** 进程消失的时刻（0= 未消失），用于 graceMs 判定。 */
  private goneSince = 0;
  /** 本适配器最近一次上报的状态，用于避免重复 emit 同一状态。 */
  private lastEmitted: TaskStatus | null = null;
  /** 降级到 tasklist：cmdline 不可用。 */
  private degradedNoCmdline = false;

  /** fallbackLog 的文件游标与半行缓冲。 */
  private readonly fallbackCursors = new Map<string, TailCursor>();
  private fallbackPending = '';

  constructor(ctx: MonitorContext, options: Partial<ProcessMonitorOptions> = {}) {
    super(ctx);
    if (ctx.task.monitor.type !== 'process') {
      throw new Error(`ProcessMonitor 收到非 process 配置: ${ctx.task.monitor.type}`);
    }
    this.cfg = ctx.task.monitor;
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }

  /* ============================================================================
   * 生命周期
   * ==========================================================================*/

  override async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    if (this.cfg.match.length === 0) {
      throw new Error('process 监控没有任何有效 match 规则');
    }
    this.setRunning(true);
    if (this.opts.mode === 'resident') {
      this.startResident();
    } else {
      this.startOnDemand();
    }
    this.startFallbackLog();
  }

  override async stop(): Promise<void> {
    this.markDisposed();
    this.setRunning(false);
    if (this.exitTimer) {
      clearTimeout(this.exitTimer);
      this.exitTimer = null;
    }
    if (this.onDemandTimer) {
      clearInterval(this.onDemandTimer);
      this.onDemandTimer = null;
    }
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (this.enumerator) {
      await this.enumerator.stop();
      this.enumerator = null;
    }
    this.alive = false;
    this.goneSince = 0;
    this.fallbackCursors.clear();
    this.fallbackPending = '';
  }

  /* ============================================================================
   * resident 模式（POC §8 D3：长驻 PS 子进程 + 逐行 JSON 流）
   * ==========================================================================*/

  private startResident(): void {
    this.enumerator = new ResidentProcessEnumerator(
      {
        onSnapshot: (processes, source) => {
          this.safeRun('resident.onSnapshot', () => this.handleSnapshot(processes, source))();
        },
        onFatal: (err) => {
          // POC §8：连续失败超过上限 -> unknown + 告警
          this.log.error(`进程枚举连续失败，判定监控源失联：${err.message}`);
          this.emitStatus('unknown', '进程枚举子进程反复失败');
        },
        onRestart: (attempt, reason) => {
          this.log.warn(`进程枚举子进程第 ${attempt} 次重启（${reason}）`);
        },
        onSourceFallback: (from, to, reason) => {
          this.log.warn(
            `进程数据源从 ${from} 降级为 ${to}（${reason}）；` +
              'cmdlineContains 匹配将失效，仅按进程名判定',
          );
          this.degradedNoCmdline = to === 'tasklist';
        },
        onLog: (level, message, err) => {
          if (level === 'error') this.log.error(message, err);
          else if (level === 'warn') this.log.warn(message);
          else this.log.info(message);
        },
      },
      this.opts.pollMs,
    );

    this.enumerator.start().catch((err: unknown) => {
      // 启动失败不抛出：只把该任务标记 unknown（架构 §4.2 生命周期契约）
      this.log.error('启动长驻枚举器失败（已隔离）', err);
      this.emitStatus('unknown', '无法启动进程枚举器');
    });
  }

  /* ============================================================================
   * onDemand 模式（架构 A5：省内存但慢的降级选项）
   * ==========================================================================*/

  private startOnDemand(): void {
    const poll = (): void => {
      runCimOnce(this.opts.pollMs, (result, err) => {
        if (err) {
          this.log.warn(`CIM 一次性枚举失败（${err.message}），降级 tasklist`);
          runTasklist((processes, taskErr) => {
            if (taskErr) {
              this.log.warn(`tasklist 降级失败：${taskErr.message}`);
              return;
            }
            this.degradedNoCmdline = true;
            this.handleSnapshot(processes, 'tasklist');
          });
          return;
        }
        this.handleSnapshot(result.processes, result.source);
      });
    };

    this.safeRun('onDemand.poll', poll)();
    this.onDemandTimer = setInterval(() => {
      if (this.isDisposed) {
        return;
      }
      this.safeRun('onDemand.poll', poll)();
    }, this.opts.onDemandIntervalMs);
  }

  /* ============================================================================
   * 判定核心
   * ==========================================================================*/

  /** 处理一批进程快照。 */
  private handleSnapshot(
    processes: readonly ProcessInfo[],
    source: 'cim' | 'tasklist',
  ): void {
    const matched = this.findMatched(processes);

    if (matched) {
      this.clearExitTimer();
      if (!this.alive) {
        this.log.info(
          `发现匹配进程（${source}）：${matched.name} pid=${matched.pid}，进入 starting`,
        );
        // idle --首个子信号--> starting（PRD §5.3）
        this.emitStatus('starting', `已发现进程 ${matched.name}`);
      } else {
        // 持续存活：无论当前态如何都续心跳，防stale_timeout 误判
        this.emitHeartbeat();
        this.emitStatusOnce('running', `进程存活 ${matched.name}`);
      }
      this.alive = true;
      return;
    }

    if (!this.alive) {
      // 从未出现过：保持 idle，交由 store 的 start_timeout 处理
      return;
    }
    if (this.goneSince === 0) {
      this.goneSince = Date.now();
      const graceMs = this.cfg.onExit?.graceMs ?? DEFAULT_EXIT_GRACE_MS;
      this.log.info(`匹配进程消失，${graceMs}ms 宽限期后判定最终状态`);
      // 宽限期内续心跳，避免 stale_timeout 先把任务打成 unknown
      this.emitHeartbeat();
      this.exitTimer = setTimeout(() => {
        this.safeRun('settleAfterExit', () => this.settleAfterExit())();
      }, graceMs);
    }
  }

  /** 进程消失且超过宽限期 -> 判定成功/失败。 */
  private settleAfterExit(): void {
    this.exitTimer = null;
    if (this.isDisposed || !this.alive) {
      return; // 宽限期内进程回来了
    }
    this.alive = false;
    this.goneSince = 0;

    const successCodes = this.cfg.onExit?.successExitCodes;
    if (successCodes && successCodes.length > 0) {
      this.emitStatus('success', '进程已结束（按 onExit.successExitCodes 判定为成功）');
    } else {
      this.emitStatus('failed', '进程已结束且未配置成功退出码，保守判定为失败');
    }
  }

  /** 在快照中查找匹配的进程。 */
  private findMatched(processes: readonly ProcessInfo[]): ProcessInfo | null {
    const wantsCmdline = this.cfg.match.some((r) => (r.cmdlineContains?.length ?? 0) > 0);

    for (const rule of this.cfg.match) {
      for (const proc of processes) {
        if (!proc.name) {
          continue;
        }
        // 进程名不区分大小写（POC 实测 node.exe / NODE.EXE 都可能出现）
        const nameMatch = rule.processNames.some(
          (n) => n.toLowerCase() === proc.name.toLowerCase(),
        );
        if (!nameMatch) {
          continue;
        }
        const cmdline = rule.cmdlineContains;
        if (!cmdline || cmdline.length === 0) {
          return proc; // 只要求进程名
        }
        if (this.degradedNoCmdline) {
          // 无命令行可匹配 -> 视为命中（已在 onSourceFallback 中明确告警）
          if (wantsCmdline) {
            this.log.debug('tasklist 降级模式：跳过命令行匹配，仅按进程名命中');
          }
          return proc;
        }
        const lower = (proc.commandLine || '').toLowerCase();
        if (cmdline.every((c) => lower.includes(c.toLowerCase()))) {
          return proc;
        }
      }
    }
    return null;
  }

  /** 仅在状态与上次不同/首次时上报，避免高频重复事件刷爆 store。 */
  private emitStatusOnce(status: TaskStatus, message?: string): void {
    if (this.lastEmitted === status) {
      // 状态相同也要续心跳
      this.emitHeartbeat();
      return;
    }
    this.lastEmitted = status;
    this.emitStatus(status, message);
  }

  /* ============================================================================
   * fallbackLog（PRD §6：进程名被 node.exe 复用时的兜底信号源）
   * ==========================================================================*/

  private startFallbackLog(): void {
    const fallback = this.cfg.fallbackLog;
    if (!fallback || fallback.paths.length === 0) {
      return;
    }

    const tick = (): void => {
      if (this.isDisposed) {
        return;
      }
      try {
        this.pollFallbackLog();
      } catch (err) {
        this.log.error('fallbackLog 轮询异常（已隔离）', err);
      }
    };

    tick();
    this.fallbackTimer = setInterval(tick, this.opts.fallbackLogIntervalMs);
  }

  /**
   * fallbackLog 轮询。
   *
   * 首次读取只取文件末尾 64KB 且**不触发状态变化**（历史内容不是「新信号」）；
   * 只有后续真正新增的行/文件才触发 stateOnNewLine。
   */
  private pollFallbackLog(): void {
    const fallback = this.cfg.fallbackLog;
    if (!fallback) {
      return;
    }

    for (const pattern of fallback.paths) {
      for (const file of globFiles(pattern)) {
        const isNew = !this.fallbackCursors.has(file);
        const cursor = this.fallbackCursors.get(file) ?? createCursor();
        this.fallbackCursors.set(file, cursor);

        const result = tailRead(file, cursor, DEFAULT_START_END_BYTES * 4, isNew);
        if (result.text.length === 0) {
          continue;
        }

        const { lines, pending } = splitLines(result.text, this.fallbackPending);
        this.fallbackPending = pending;

        if (isNew) {
          // 首见：仅记录已建立游标，历史内容不作为信号
          this.log.info(`fallbackLog 已接管：${file}`);
          if (result.rotated) {
            this.fallbackPending = '';
          }
          continue;
        }

        if (lines.length > 0 || result.rotated) {
          this.onFallbackNewLine(file, lines.length, result.rotated);
        }
      }
    }
  }

  private onFallbackNewLine(file: string, lineCount: number, rotated: boolean): void {
    const fallback = this.cfg.fallbackLog;
    if (!fallback) {
      return;
    }
    const detail = rotated
      ? '检测到日志轮转/截断'
      : `新增 ${lineCount} 行`;
    this.log.info(`fallbackLog 触发（${baseName(file)}）：${detail}`);
    // 兜底信号的语义是「进程还在跑，只是进程名对不上」
    this.emitStatusOnce(fallback.stateOnNewLine, `日志有新输出（${baseName(file)}）`);
  }

  /** 供宿主在需要时查询当前是否处于降级无命令行模式（日志/诊断用）。 */
  get isDegradedNoCmdline(): boolean {
    return this.degradedNoCmdline;
  }

  private clearExitTimer(): void {
    if (this.exitTimer) {
      clearTimeout(this.exitTimer);
      this.exitTimer = null;
    }
    this.goneSince = 0;
  }
}

/** 取文件名（去掉目录），用于简短提示。 */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
