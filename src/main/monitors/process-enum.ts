/**
 * 进程枚举服务 —— POC §8 实测结论的**唯一**落地实现。
 *
 * 依赖: Node 内置 `child_process`。**不使用 wmic**（POC 实测被安全策略拉黑/超时）。
 *
 * POC §8 四方案实测对比：
 *   | `tasklist /fo csv`          | 323 行，只有 Image Name，无命令行 | 仅够 processNames |
 *   | `wmic process get ...`      | 超时 / 被拉黑                     | ❌ 排除           |
 *   | `Get-Process`               | 有 Id + Name，无命令行            | 不满足            |
 *   | `Get-CimInstance Win32_Process` | 103KB JSON，ProcessId+Name+CommandLine 齐全 | ✅ 唯一可行 |
 *
 * 因此本模块提供两种模式：
 *  - `resident`：长驻 PowerShell 子进程，逐行 JSON 流（POC §8 决策 D3）；
 *  - `onDemand` ：按需 spawn 一次（省内存，架构 A5 的可配置降级模式）。
 *
 * **降级链**：长驻 PS 起不来（沙箱/受限环境）-> 退到 `tasklist`（只能匹配进程名）。
 * 这一点很重要：不是所有环境都能跑 PowerShell CIM。
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

/**
 * 我们总是用 `stdio: ['ignore', 'pipe', 'pipe']` 启动子进程，
 * 因此 stdin 为 null、stdout/stderr 为可读流 —— 用这个精确类型而不是 ChildProcessWithoutNullStreams。
 */
type ResidentChild = ChildProcessByStdio<null, Readable, Readable>;

import {
  DEFAULT_ON_DEMAND_INTERVAL_MS,
  DEFAULT_PROCESS_POLL_MS,
  MAX_RESTART_ATTEMPTS,
  RESTART_BACKOFF_MS,
  SPAWN_TIMEOUT_MS,
} from '../../shared/constants';

/** 单条进程记录。 */
export interface ProcessInfo {
  pid: number;
  name: string;
  commandLine: string;
}

/** 枚举结果。 */
export interface EnumerateResult {
  processes: ProcessInfo[];
  /** 本次实际使用的数据源，便于日志与测试断言降级链。 */
  source: 'cim' | 'tasklist';
}

/**
 * 生成常驻枚举用的 PowerShell 脚本。
 *
 * 关键点：
 *  - `ConvertTo-Json -Compress` 保证**单行**输出，配合 stdout 逐行切分；
 *  - 进程数 > 1 时 ConvertTo-Json 默认输出**数组**，= 1 时输出**对象**，
 *    因此 Node 侧要同时兼容两种形状（见 parseCimPayload）；
 *  - 只选 3 个字段，减少 103KB 的传输量。
 */
export function buildCimScript(pollMs: number): string {
  /*
   * ⚠️ 这里有两个**实测踩过的** PowerShell 语法坑，都很隐蔽：
   *
   * 【坑 1】语句之间必须用换行（或 `;`）分隔，不能用空格拼成一行。
   *   拼成 `$ErrorActionPreference = "Stop" while ($true) { ... }` 会直接
   *   `UnexpectedToken: while` —— 赋值语句后面缺语句终结符。
   *
   * 【坑 2】★ 管道**不能跨行**。
   *   即使有换行，写成下面这样仍然报错：
   *       Get-CimInstance Win32_Process
   *         | Select-Object ProcessId, Name, CommandLine
   *   报的是 `EmptyPipeElement`（"不能使用空管道元素"）——
   *   因为以 `|` 开头的续行在 `-Command` 传参方式下不被当作续行。
   *   实测：`-EncodedCommand` 也一样失败，所以与引号/换行转义无关，
   *   就是**管道必须与前半句在同一行**。
   *
   * 两个坑的后果相同且同样难查：长驻子进程一启动就 exit code=1 死掉，
   * 监控器重启 5 次后判"监控源失联"，那盏灯永远不反映真实进程
   * （用户看到的是"workbuddy 没被监控"）。
   *
   * 所以：**每条语句一行，且整条管道写在一行内。**
   */
  return [
    '$ErrorActionPreference = "Stop"',
    'while ($true) {',
    '  try {',
    // 管道必须在一行内 —— 见上方【坑 2】
    '    Get-CimInstance Win32_Process | Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress',
    `    Start-Sleep -Milliseconds ${Math.max(500, Math.floor(pollMs))}`,
    '  } catch {',
    '    Write-Output ""',
    '  }',
    '}',
  ].join('\n');
}

/* ============================================================================
 * 解析函数（纯函数，可单测）
 * ==========================================================================*/

/**
 * 解析一行 CIM JSON。
 *
 * 形状兼容（这是 POC 实测踩到的坑）：
 *  - 多进程：[{...},{...}]
 *  - 单进程：{...}
 *  - 空：`null` / 空字符串
 *  - 属性名大小写不敏感（Powershell 可能返回 ProcessId 或 processid）
 */
export function parseCimPayload(line: string): ProcessInfo[] {
  const trimmed = line.trim();
  if (!trimmed || trimmed === 'null') {
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return []; // 半行/损坏 JSON：丢弃，绝不抛（POC §8 流式解析的必然情况）
  }
  const list = Array.isArray(data) ? data : [data];
  const result: ProcessInfo[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    const pidRaw = obj.ProcessId ?? obj.processId ?? obj.pid;
    const pid = typeof pidRaw === 'number' ? pidRaw : Number(pidRaw);
    if (!Number.isFinite(pid) || pid <= 0) {
      continue; // POC 实测存在 ProcessId=0 的 "System Idle Process"，跳过
    }
    const nameRaw = obj.Name ?? obj.name;
    const name = typeof nameRaw === 'string' ? nameRaw : '';
    const cmdRaw = obj.CommandLine ?? obj.commandLine;
    const commandLine = typeof cmdRaw === 'string' ? cmdRaw : '';
    result.push({ pid, name, commandLine });
  }
  return result;
}

/**
 * 解析 `tasklist /fo csv /nh` 的 CSV 输出（降级路径，只有 Image Name）。
 *
 * 形如："node.exe","1234","Console","1","89,000 K"
 */
export function parseTasklistPayload(stdout: string): ProcessInfo[] {
  const result: ProcessInfo[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // 轻量 CSV 解析：只处理双引号包裹的字段（本场景无逗号转义需求）
    const fields = line.match(/"([^"]*)"/g);
    if (!fields || fields.length < 2) continue;
    const name = (fields[0] ?? '').replace(/^"|"$/g, '');
    const pidText = (fields[1] ?? '').replace(/^"|"$/g, '');
    const pid = Number(pidText);
    if (!name || !Number.isFinite(pid) || pid <= 0) continue;
    result.push({ pid, name, commandLine: '' });
  }
  return result;
}

/* ============================================================================
 * 常驻枚举器
 * ==========================================================================*/

/** 长驻枚举器的对外回调。 */
export interface ResidentEnumeratorHandlers {
  /** 每得到一批进程快照。 */
  onSnapshot: (processes: ProcessInfo[], source: 'cim' | 'tasklist') => void;
  /** 不可恢复的错误（超过 MAX_RESTART_ATTEMPTS 次后触发）。 */
  onFatal: (err: Error) => void;
  /** 可恢复的重启（附带第几次、原因）。 */
  onRestart?: (attempt: number, reason: string) => void;
  /** 数据源降级（PS 起不来 -> tasklist）。 */
  onSourceFallback?: (from: 'cim' | 'tasklist', to: 'cim' | 'tasklist', reason: string) => void;
  /** 探活回调（供框架判断枚举器是否健康）。 */
  onLog?: (level: 'info' | 'warn' | 'error', message: string, err?: unknown) => void;
}

/**
 * 长驻 PowerShell 枚举器。
 *
 * 生命周期：
 *  - start() 拉起子进程；
 *  - 子进程退出 -> 指数退避重启（1/2/4/8/16/30s）；
 *  - 超过 MAX_RESTART_ATTEMPTS 次 -> onFatal，由框架把任务转 unknown（POC §8）；
 *  - 首次启动失败（PS 完全不可用）-> 降级 tasklist 一次性枚举 + 定时轮询。
 */
export class ResidentProcessEnumerator {
  private child: ResidentChild | null = null;
  private stdoutBuffer = '';
  /** 子进程 stderr 的尾部（最多 500 字），用于在退出时给出可读原因。 */
  private childStderr = '';
  private restartAttempt = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private started = false;
  private source: 'cim' | 'tasklist' = 'cim';
  private tasklistTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly handlers: ResidentEnumeratorHandlers,
    private readonly pollMs: number = DEFAULT_PROCESS_POLL_MS,
  ) {}

  get currentSource(): 'cim' | 'tasklist' {
    return this.source;
  }

  get isRunning(): boolean {
    return this.started && !this.disposed;
  }

  async start(): Promise<void> {
    if (this.disposed || this.started) {
      return;
    }
    this.started = true;
    this.spawnCim();
  }

  private spawnCim(): void {
    if (this.disposed) {
      return;
    }
    const script = buildCimScript(this.pollMs);
    let child: ResidentChild;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      this.handleSpawnFailure(err);
      return;
    }
    this.child = child;
    this.childStderr = ''; // 新进程重新收集 stderr，避免上一轮的残留污染本次诊断

    child.stdout.setEncoding('utf8');
    child.stdout.on(
      'data',
      (chunk: string) => this.safeHandleStdout(chunk),
    );

    /*
     * ★ 必须收集 stderr —— 这是"排查不到原因"的修复点。
     *
     * 【为什么】长驻子进程此前只读 stdout，退出时也只记 `exit code=1`。
     * 于是当脚本有语法错误时，日志里只有一句"子进程反复失败"，
     * **真正的错误信息（PowerShell 的 ParserError）被丢掉了**，
     * 完全无法定位。实测就是靠手工复现才看到那个
     * `UnexpectedToken: while` —— 本该在日志里一眼看到。
     *
     * 只留最后 500 字：PowerShell 的报错通常很短，但异常堆栈可能很长，
     * 截断避免把日志刷爆。
     */
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.childStderr = `${this.childStderr}${chunk}`.slice(-500);
    });

    child.on('error', (err) => {
      this.handlers.onLog?.('error', '长驻枚举子进程 error', err);
      this.handleChildExit(`error: ${err.message}`);
    });

    child.on('exit', (code) => {
      // 把 stderr 摘要带进退出原因，下次再有这类问题一眼可见
      const tail = this.describeStderr();
      this.handleChildExit(`exit code=${code ?? 'null'}${tail}`);
    });

    // 探测期超时：30s 内一行 JSON 都没回来视为不可用（POC §6实测进程创建有固定开销，
    // 但真实 Windows 上 PowerShell 首帧通常 < 1s，30s 足够宽松）。
    this.probeTimer = setTimeout(() => {
      if (this.stdoutBuffer.length === 0 && !this.receivedAnySnapshot) {
        this.handlers.onLog?.('warn', '长驻枚举 30s 未收到任何快照，降级 tasklist');
        this.killChild();
        this.fallbackToTasklist('CIM 长驻进程 30s 无输出');
      }
    }, 30_000);
  }

  private probeTimer: NodeJS.Timeout | null = null;
  private receivedAnySnapshot = false;

  /**
   * 把子进程 stderr 压成一行摘要，供退出日志使用。
   *
   * 只取**第一行非空内容**：PowerShell 的 ParserError 第一行就是
   * "表达式或语句中包含意外的标记…"，后面是带 `+` 的代码定位噪声。
   * 没有 stderr 时返回空串（保持原日志格式不变）。
   */
  private describeStderr(): string {
    const first = this.childStderr
      .split(/\r?\n/u)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return first === undefined ? '' : `，stderr: ${first.slice(0, 200)}`;
  }

  private safeHandleStdout(chunk: string): void {
    try {
      this.handleStdout(chunk);
    } catch (err) {
      this.handlers.onLog?.('error', 'stdout 处理异常（已隔离）', err);
    }
  }

  private handleStdout(chunk: string): void {
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
    this.stdoutBuffer += chunk;
    // 逐行切分：最后一段可能不完整，留在 buffer 等下一个 chunk。
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const processes = parseCimPayload(line);
      if (processes.length > 0) {
        this.receivedAnySnapshot = true;
        this.source = 'cim';
        this.restartAttempt = 0; // 成功即重置退避
        this.handlers.onSnapshot(processes, 'cim');
      }
    }
  }

  private handleSpawnFailure(err: unknown): void {
    const reason = err instanceof Error ? err.message : String(err);
    this.handlers.onLog?.('warn', `拉起长驻枚举失败：${reason}`);
    this.fallbackToTasklist(reason);
  }

  private handleChildExit(reason: string): void {
    if (this.disposed) {
      return;
    }
    this.clearProbeTimer();
    this.child = null;
    if (this.source === 'tasklist') {
      return; // 已在tasklist 模式，子进程退出会被定时轮询覆盖
    }
    if (this.restartAttempt >= MAX_RESTART_ATTEMPTS) {
      this.handlers.onFatal(
        new Error(`进程枚举子进程连续失败 ${this.restartAttempt} 次（${reason}），判定监控源失联`),
      );
      return;
    }
    const delay = RESTART_BACKOFF_MS[Math.min(this.restartAttempt, RESTART_BACKOFF_MS.length - 1)]!;
    this.restartAttempt += 1;
    this.handlers.onRestart?.(this.restartAttempt, reason);
    this.restartTimer = setTimeout(() => this.spawnCim(), delay);
  }

  /**
   * 降级到 tasklist。
   * 能力降级：拿不到命令行，只能匹配 processNames（cmdlineContains 会失效并记日志）。
   */
  private fallbackToTasklist(reason: string): void {
    if (this.disposed || this.source === 'tasklist') {
      return;
    }
    this.handlers.onSourceFallback?.('cim', 'tasklist', reason);
    this.source = 'tasklist';
    this.killChild();
    this.clearProbeTimer();

    const poll = (): void => {
      runTasklist((result, err) => {
        if (err) {
          this.handlers.onLog?.('warn', `tasklist 降级枚举失败：${err.message}`);
          return;
        }
        this.handlers.onSnapshot(result, 'tasklist');
      });
    };
    poll();
    this.tasklistTimer = setInterval(() => {
      if (this.disposed) return;
      poll();
    }, Math.max(this.pollMs, DEFAULT_ON_DEMAND_INTERVAL_MS));
  }

  private clearProbeTimer(): void {
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
  }

  private killChild(): void {
    const child = this.child;
    this.child = null;
    if (!child) {
      return;
    }
    try {
      if (!child.killed) {
        child.kill();
      }
    } catch {
      // kill 失败不影响退出流程
    }
  }

  /** 停止枚举器并释放全部资源。**幂等**。 */
  async stop(): Promise<void> {
    this.disposed = true;
    this.started = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.tasklistTimer) {
      clearInterval(this.tasklistTimer);
      this.tasklistTimer = null;
    }
    this.clearProbeTimer();
    this.killChild();
    this.stdoutBuffer = '';
  }
}

/* ============================================================================
 * 一次性枚举（onDemand 模式 & tasklist 降级）
 * ==========================================================================*/

/**
 * 跑一次 tasklist 并回调结果。
 *
 * 注意：tasklist 的 stdout 是 UTF-16LE（部分系统是 OEM 代码页），
 * 这里不做转码，交给调用方用 `.includes()` 做大小写不敏感匹配即可 ——
 * 进程名匹配对编码不敏感（ASCII 进程名在两种编码下字节一致）。
 */
export function runTasklist(callback: (result: ProcessInfo[], err: Error | null) => void): void {
  let settled = false;
  let stdout = '';
  let stderr = '';
  const done = (result: ProcessInfo[], err: Error | null): void => {
    if (settled) return;
    settled = true;
    callback(result, err);
  };

  let child: ResidentChild;
  try {
    child = spawn('tasklist.exe', ['/fo', 'csv', '/nh'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as ResidentChild;
  } catch (err) {
    done([], err instanceof Error ? err : new Error(String(err)));
    return;
  }

  // POC §6：所有 spawn 设 5s 超时，超时只记日志不抛（POC 明确要求）。
  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    done([], new Error(`tasklist 超时（${SPAWN_TIMEOUT_MS}ms）`));
  }, SPAWN_TIMEOUT_MS);

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.on('error', (err) => {
    clearTimeout(timer);
    done([], err);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code !== 0 && !stdout.trim()) {
      done([], new Error(`tasklist 退出码 ${code ?? 'null'}：${stderr.slice(0, 200)}`));
      return;
    }
    done(parseTasklistPayload(stdout), null);
  });
}

/** 一次性 CIM 枚举（onDemand 模式）。 */
export function runCimOnce(
  pollMs: number,
  callback: (result: EnumerateResult, err: Error | null) => void,
): void {
  let settled = false;
  let stdout = '';
  const done = (result: EnumerateResult, err: Error | null): void => {
    if (settled) return;
    settled = true;
    callback(result, err);
  };

  let child: ResidentChild;
  try {
    child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process | Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress`,
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    done({ processes: [], source: 'cim' }, err instanceof Error ? err : new Error(String(err)));
    return;
  }

  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    done({ processes: [], source: 'cim' }, new Error(`CIM 枚举超时（${SPAWN_TIMEOUT_MS}ms）`));
  }, SPAWN_TIMEOUT_MS);

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.on('error', (err) => {
    clearTimeout(timer);
    done({ processes: [], source: 'cim' }, err);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code !== 0 && !stdout.trim()) {
      // PowerShell 不可用 -> 让调用方退到 tasklist。
      done({ processes: [], source: 'cim' }, new Error(`CIM 枚举退出码 ${code ?? 'null'}`));
      return;
    }
    const processes = parseCimPayload(stdout);
    if (processes.length === 0) {
      done({ processes: [], source: 'cim' }, new Error('CIM 枚举无有效进程输出'));
      return;
    }
    done({ processes, source: 'cim' }, null);
  });

  // pollMs 在一次性模式下只用于提示，保持参数签名一致便于按模式切换。
  void pollMs;
}
