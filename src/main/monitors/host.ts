/**
 * 监控器宿主 —— 负责所有适配器的创建 / 启动 / 停止 / 差分重启 / 健康巡检。
 *
 * 依赖: monitors/* + store + config + logger。**不依赖 Electron**（HookServer 用 Node http）。
 *
 * 【最重要的契约】架构 §4.2：
 *  - 单个适配器 start() 抛异常 -> **只**该任务转 unknown，其余任务不受影响；
 *  - stop() 必须幂等；
 *  - 热重载时按 monitor 配置 hash 差分：未变的不动，变了才 stop+start。
 *
 * 本文件是「单一写入口」纪律的执行点：所有 MonitorEvent 都在这里转成 store.apply。
 */

import { DEFAULT_STATE_TIMEOUT } from '../../shared/constants';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AppConfig,
  TaskConfig,
  TaskState,
} from '../../shared/types';
import type { Logger } from '../logger';
import type { TaskStore } from '../store';
import { MonitorAdapter, type MonitorEvent, type MonitorSink } from './base';
import { compileRules } from './pattern';
import { ProcessMonitor } from './process';
import { LogMonitor } from './logfile';
import { WebhookMonitor } from './webhook';
import { HookServer } from './hook-server';
import { DshMonitor, LocalCredentialsSource, type SecretSource } from './dsh';
import { DshSignalArbiter, type ExactSessionSignal } from './dsh-arbiter';
import { SshCredentialsSource } from './dsh-remote-auth';
import { SqliteMonitor } from './sqlite';

/** 一个任务与其适配器的绑定。 */
interface Binding {
  config: TaskConfig;
  adapter: MonitorAdapter;
  /** monitor 配置的 hash，用于热重载差分。 */
  hash: string;
}

export interface MonitorHostOptions {
  store: TaskStore;
  config: AppConfig;
  logger: Logger;
  /** 应用退出时停止全部适配器。 */
  onTaskFatal?: (taskId: string, reason: string) => void;
  /**
   * 可选：dsh 侧插件上报的**精确**等待信号（D2 混合方案的 b 半）。
   *
   * 由插件经 webhook 推来，键是 sessionId。未注入时 dsh 型监控自动退回
   * `plan.pending` 近似路径 —— 这就是决策 D2 要求的「插件失效自动退回」。
   */
  pluginStateFor?: (sessionId: string) =>
    | { pendingInteraction?: 'approval' | 'plan-review' | 'question'; errorMessage?: string }
    | undefined;
  /**
   * 可选：仲裁器（D2）。给了它就由 host 把 webhook 原始载荷喂进去，
   * 并把它作为 dsh 型监控的精确信号来源。
   *
   * 与 `pluginStateFor` 的关系：二者取其一即可。
   * `arbiter` 是「自带 TTL 与按会话归位的成品」，`pluginStateFor` 是
   * 「你自己提供信号」的低层逃生口（测试/特殊部署用）。
   */
  arbiter?: DshSignalArbiter;
}

/** dsh 的默认配置目录（实测本机所用的位置）。 */
function defaultDshHome(): string {
  return join(homedir(), '.dsh');
}

export class MonitorHost {
  private readonly bindings = new Map<string, Binding>();
  private readonly sink: MonitorSink;
  private hookServer: HookServer | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private currentConfig: AppConfig;
  private started = false;

  constructor(private readonly options: MonitorHostOptions) {
    this.currentConfig = options.config;
    this.sink = (taskId, ev) => this.dispatch(taskId, ev);
  }

  /** 启动全部 enabled 任务的适配器（逐个 try-catch 隔离）。 */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    // webhook 型任务共用一个 HTTP 端口，优先起它
    await this.ensureHookServer();

    for (const task of this.currentConfig.tasks) {
      if (!task.enabled) {
        this.options.logger.info(`任务 ${task.id} 已禁用，跳过监控`);
        continue;
      }
      await this.startOne(task);
    }

    // 健康巡检：定期检查适配器是否还活着（POC §8 子进程崩溃 -> 重建）
    this.healthTimer = setInterval(() => {
      this.safeHealthCheck();
    }, Math.max(30_000, this.currentConfig.app.pollIntervalMs * 10));
    this.healthTimer.unref?.();
  }

  /** 启动单个任务的适配器；失败只影响该任务。 */
  private async startOne(task: TaskConfig): Promise<void> {
    try {
      const adapter = this.createAdapter(task);
      if (!adapter) {
        throw new Error(`未知的监控类型：${task.monitor.type}`);
      }
      await adapter.start();
      this.bindings.set(task.id, {
        config: task,
        adapter,
        hash: hashMonitorConfig(task),
      });
      this.options.logger.info(`任务 ${task.id} 监控已启动（${task.monitor.type}）`);
    } catch (err) {
      // 架构 §4.2：失败 -> 该任务转 unknown + 记日志，**其余任务不受影响**
      const message = err instanceof Error ? err.message : String(err);
      this.options.logger.error(`任务 ${task.id} 监控启动失败（已隔离，不影响其它任务）：${message}`);
      this.options.store.apply(task.id, {
        status: 'unknown',
        message: `监控启动失败：${message}`,
      });
      this.options.onTaskFatal?.(task.id, message);
    }
  }

  /** 按monitor.type 创建对应适配器。 */
  private createAdapter(task: TaskConfig): MonitorAdapter | null {
    const ctx = {
      task,
      sink: this.sink,
      logger: this.options.logger,
      rules: compileRules(
        task.monitor.type === 'log' ? task.monitor.rules : [],
      ),
      timeouts: {
        startTimeoutMs:
          (task.monitor.startTimeoutMs ?? DEFAULT_STATE_TIMEOUT.startTimeoutMs),
        staleTimeoutMs:
          (task.monitor.staleTimeoutMs ?? DEFAULT_STATE_TIMEOUT.staleTimeoutMs),
        waitingTimeoutMs: DEFAULT_STATE_TIMEOUT.waitingTimeoutMs,
      },
      // sqlite 型用：读"用户点掉绿灯时的完成水位"。
      // store 才是"用户点过没有"的真相所在，所以由它提供。
      ackedCompletionAt: () =>
        this.options.store.getTask(task.id)?.ackedCompletionAt ?? 0,
    };

    switch (task.monitor.type) {
      case 'process':
        return new ProcessMonitor(ctx, {
          mode: this.currentConfig.app.processPollMode,
          pollMs: this.currentConfig.app.pollIntervalMs,
        });
      case 'log':
        return new LogMonitor(ctx, {
          pollIntervalMs: this.currentConfig.app.pollIntervalMs,
        });
      case 'webhook':
        if (!this.hookServer) {
          throw new Error('HookServer 未初始化');
        }
        return new WebhookMonitor(ctx, this.hookServer);
      case 'sqlite':
        return new SqliteMonitor(ctx, task.monitor);
      case 'dsh':
        return new DshMonitor(ctx, {
          secretSources: this.secretSourcesFor(task.monitor.dshHome, task.monitor.sshHost),
          // 精确信号优先级：仲裁器（自带 TTL/按会话归位） > 低层注入 > 无
          ...(this.resolvePluginStateFor() === undefined
            ? {}
            : { pluginStateFor: this.resolvePluginStateFor() as (id: string) => ExactSessionSignal | undefined }),
        });
      default:
        return null;
    }
  }

  /**
   * 解析出给 DshMonitor 用的精确信号来源。
   *
   * 优先用仲裁器：它在 `exactStateFor` 里做了 TTL 过期剔除，
   * 过期即返回 undefined，于是 DshMonitor 自动退回 `plan.pending` 近似 ——
   * 这条「插件失效自动退回」的降级链是 D2 的核心要求。
   */
  private resolvePluginStateFor():
    | ((sessionId: string) => ExactSessionSignal | undefined)
    | undefined {
    if (this.options.arbiter !== undefined) {
      const arbiter = this.options.arbiter;
      return (sessionId: string) => arbiter.exactStateFor(sessionId);
    }
    return this.options.pluginStateFor;
  }

  /**
   * 构造密钥来源链。
   *
   * 顺序即优先级：
   *   1. 任务级 `dshHome`（若配置了）—— 让不同任务可以指向不同 dsh 安装
   *   2. 全局 `app.dshHome`
   *   3. `%USERPROFILE%/.dsh`（dsh 的默认位置，实测就是本机所用的）
   *
   * 【D5 远端兜底】若任务配了 `sshHost`，则把「SSH 取远端密钥」挂在
   * 本机来源的 `fetchRemoteSecret` 上。触发时机是**服务端回 401 之后**
   * （见 DshMonitor.invalidateCredentials），因为只有服务端才知道
   * 本机密钥是否适用于这个 authority。这样：
   *   - 本机实例：零额外开销，永远不跑 SSH
   *   - 隧道实例：第一次 401 后自动取远端密钥并重试（实测 200）
   */
  private secretSourcesFor(
    taskDshHome: string | undefined,
    sshHost: string | undefined,
  ): readonly SecretSource[] {
    const homes = [taskDshHome, this.currentConfig.app.dshHome, defaultDshHome()].filter(
      (h): h is string => typeof h === 'string' && h.length > 0,
    );
    // 去重，避免同一目录被读两次
    const unique = [...new Set(homes)];

    if (sshHost === undefined) {
      return unique.map((home) => new LocalCredentialsSource(home));
    }

    // 远端来源只建一次，多个 home 共用（它自带缓存，重复建会重复握手）
    const remote = new SshCredentialsSource({
      sshHost,
      onDebug: (m) => this.options.logger.info(m),
    });

    return unique.map(
      (home) =>
        new LocalCredentialsSource(home, async () => {
          const result = await remote.get();
          if (!result.ok) {
            // 抛出去由 DshMonitor 计入失败计数并转 unknown（不静默）
            throw new Error(`SSH 取远端密钥失败（${remote.describe}）：${result.reason}`);
          }
          return result.secret;
        }),
    );
  }

  /** 唯一的 store 写入口。 */
  private dispatch(taskId: string, ev: MonitorEvent): void {
    try {
      if (ev.kind === 'heartbeat') {
        this.options.store.heartbeat(taskId);
        return;
      }
      this.options.store.apply(taskId, {
        status: ev.status,
        message: ev.message,
        progress: ev.progress,
        // ★ 完成水位透传给 store 做「确认闸门」：已被用户点掉的完成事件会被丢弃
        completionAt: ev.completionAt,
        isSignal: true,
      });
    } catch (err) {
      this.options.logger.error(`处理 ${taskId} 的监控事件异常（已隔离）`, err);
    }
  }

  /** 启动（必要时）共享的 HookServer。 */
  private async ensureHookServer(): Promise<void> {
    const hasWebhook = this.currentConfig.tasks.some(
      (t) => t.enabled && t.monitor.type === 'webhook',
    );
    if (!hasWebhook || this.hookServer) {
      return;
    }
    const server = new HookServer(this.currentConfig.app.hookPort, {
      onHook: (req) => {
        // 【D2 仲裁】先把**原始载荷**喂给仲裁器，再走原有的 fieldMap 流程。
        //
        // 为什么要先喂、且不依赖适配器是否存在：
        //   `pendingInteraction` 不在 fieldMap 能表达的字段里（它按会话归位），
        //   而且必须"无论 webhook 任务是否已启动"都记下来 —— 等待信号
        //   恰恰可能出现在监控刚起来、绑定还没建立的那一刻。
        //   喂进去是幂等的，重复 ingest 只更新时刻，无副作用。
        try {
          this.options.arbiter?.ingest(req.body as Parameters<DshSignalArbiter['ingest']>[0]);
        } catch (err) {
          // 插件载荷来自网络，属不可信输入；任何异常都不许影响 webhook 主流程
          this.options.logger.warn(
            `仲裁器吞载荷异常（已隔离）：${err instanceof Error ? err.message : String(err)}`,
          );
        }

        const binding = this.bindings.get(req.taskId);
        if (!binding || !(binding.adapter instanceof WebhookMonitor)) {
          return { ok: false, error: 'unknown task', httpStatus: 404 };
        }
        return binding.adapter.handleHook(req);
      },
      getSnapshot: () => this.options.store.getSnapshot(),
      log: (level, message, err) => {
        if (level === 'error') this.options.logger.error(message, err);
        else if (level === 'warn') this.options.logger.warn(message);
        else this.options.logger.info(message);
      },
    });
    try {
      await server.start();
      this.hookServer = server;
    } catch (err) {
      // 端口被占用时不能让整个应用起不来
      this.options.logger.error(
        `HookServer 启动失败（webhook 型任务将不可用）：${(err as Error).message}`,
      );
      this.options.onTaskFatal?.('*', `HookServer 启动失败：${(err as Error).message}`);
    }
  }

  /** 健康巡检（异常时重建适配器）。 */
  private safeHealthCheck(): void {
    try {
      for (const [taskId, binding] of [...this.bindings]) {
        if (binding.adapter.isHealthy()) {
          continue;
        }
        this.options.logger.warn(`任务 ${taskId} 适配器已不健康，重建中`);
        void this.rebuild(taskId);
      }
    } catch (err) {
      this.options.logger.error('健康巡检异常（已隔离）', err);
    }
  }

  private async rebuild(taskId: string): Promise<void> {
    const binding = this.bindings.get(taskId);
    if (!binding) {
      return;
    }
    try {
      await binding.adapter.stop(); // 幂等
    } catch {
      /* ignore */
    }
    this.bindings.delete(taskId);
    await this.startOne(binding.config);
  }

  /**
   * 配置热重载后的差分同步（架构 §5.3 时序图）。
   * @returns 新增 / 移除 / 重启的任务 id
   */
  async reload(newConfig: AppConfig): Promise<{
    added: string[];
    removed: string[];
    restarted: string[];
  }> {
    const added: string[] = [];
    const removed: string[] = [];
    const restarted: string[] = [];
    const oldConfig = this.currentConfig;
    this.currentConfig = newConfig;

    const newById = new Map(newConfig.tasks.map((t) => [t.id, t]));

    // 移除已删除/被禁用的任务
    for (const [taskId, binding] of [...this.bindings]) {
      const next = newById.get(taskId);
      if (!next || !next.enabled) {
        await this.stopBinding(taskId, binding);
        removed.push(taskId);
      }
    }

    // 新增或变化的任务
    for (const task of newConfig.tasks) {
      if (!task.enabled) {
        continue;
      }
      const binding = this.bindings.get(task.id);
      if (!binding) {
        await this.startOne(task);
        added.push(task.id);
        continue;
      }
      const nextHash = hashMonitorConfig(task);
      if (nextHash !== binding.hash) {
        await this.stopBinding(task.id, binding);
        await this.startOne(task);
        restarted.push(task.id);
      } else {
        // hash 未变：保持运行，无闪断（架构 §5.3）
        binding.config = task; // 只更新配置引用（jump/cwd 可能变了）
      }
    }

    // 端口变化时重启 HookServer
    if (oldConfig.app.hookPort !== newConfig.app.hookPort && this.hookServer) {
      await this.hookServer.stop();
      this.hookServer = null;
      await this.ensureHookServer();
    }

    return { added, removed, restarted };
  }

  private async stopBinding(taskId: string, binding: Binding): Promise<void> {
    try {
      await binding.adapter.stop(); // 幂等
    } catch (err) {
      this.options.logger.warn(`停止任务 ${taskId} 适配器异常：${(err as Error).message}`);
    }
    this.bindings.delete(taskId);
  }

  /** 停止单个任务（面板「暂停」按钮）。 */
  async stopTask(taskId: string): Promise<void> {
    const binding = this.bindings.get(taskId);
    if (binding) {
      await this.stopBinding(taskId, binding);
    }
  }

  /** 启动单个任务（「暂停」后恢复）。 */
  async startTask(taskId: string): Promise<void> {
    const task = this.currentConfig.tasks.find((t) => t.id === taskId);
    if (task && !this.bindings.has(taskId)) {
      await this.startOne(task);
    }
  }

  /** 当前是否处于全局暂停。 */
  get isPaused(): boolean {
    return this.options.store.pausedGlobally;
  }

  /** 批量暂停/恢复（托盘菜单）。 */
  async setPaused(paused: boolean): Promise<void> {
    this.options.store.setPaused(paused);
    if (paused) {
      for (const [taskId, binding] of [...this.bindings]) {
        await this.stopBinding(taskId, binding);
      }
    } else {
      for (const task of this.currentConfig.tasks) {
        if (task.enabled && !this.bindings.has(task.id)) {
          await this.startOne(task);
        }
      }
    }
  }

  /** 停止全部适配器 + HookServer。**幂等**。 */
  async stopAll(): Promise<void> {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    for (const [taskId, binding] of [...this.bindings]) {
      await this.stopBinding(taskId, binding);
    }
    if (this.hookServer) {
      await this.hookServer.stop();
      this.hookServer = null;
    }
    this.started = false;
  }

  /** 供测试/诊断：当前活跃的适配器数量。 */
  get activeCount(): number {
    return this.bindings.size;
  }
}

/**
 * 计算 monitor 配置的稳定 hash。
 *
 * 用**递归键排序**的 JSON，保证「键顺序不同但内容相同 -> hash 相同」，
 * 避免热重载时无意义的适配器重启（架构 §5.3「hash 未变则不动」）。
 */
export function hashMonitorConfig(task: TaskConfig): string {
  return stableStringify(task.monitor);
}

/** 递归按键排序序列化（纯函数，无依赖）。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    // 数组保持原顺序（rules 顺序有语义：failed 优先判定依赖配置顺序）
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const v = obj[key];
    if (v === undefined) {
      continue; // undefined 视为缺省，避免 {a:1} 与 {a:1,b:undefined} hash 不同
    }
    parts.push(`${JSON.stringify(key)}:${stableStringify(v)}`);
  }
  return `{${parts.join(',')}}`;
}

/** 供 notify / ipc 使用的任务信息读取（避免各处重复遍历）。 */
export function findTask(states: readonly TaskState[], taskId: string): TaskState | undefined {
  return states.find((t) => t.taskId === taskId);
}
