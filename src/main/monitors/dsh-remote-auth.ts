/**
 * 远端/隧道型 dsh 实例的密钥来源（设计决策 D5）。
 *
 * ============================================================================
 * 【问题】
 * ============================================================================
 * 实测（见 lamp/docs/probe-report-外部监控可行性.md）：
 *   - `127.0.0.1:3080`  本机 dsh web   -> 用本机密钥自签 cookie -> **200**
 *   - `127.0.0.1:13080` 是 SSH 隧道，指向远端主机的 dsh web
 *                       -> 用本机密钥 -> **401**
 * 因为 cookie 的签名密钥是**每个 dsh 实例自己持久化的**，
 * 隧道那头的 dsh 用的是**远端**的 `~/.dsh/.credentials.yaml`。
 *
 * ============================================================================
 * 【解法】
 * ============================================================================
 * SSH 到隧道主机，把远端的 browser-session 密钥取回来，
 * 然后**在本地**为 `127.0.0.1:13080` 签 cookie（authority 是本地隧道端口，
 * 不是远端的 3080 —— cookie 名与签名都绑定你实际连的那个 authority）。
 *
 * 实测已通：`GET http://127.0.0.1:13080/` -> **200**。
 *
 * ============================================================================
 * 【为什么要硬超时】
 * ============================================================================
 * 上一轮直接用 PowerShell 跑 ssh 探测，**挂起超过 5 分钟无返回**，只能中止。
 * 换到 node:child_process 并用硬 timeout 后一次成功（首次握手约 11s）。
 * 教训：跑外部进程一定要能**真正杀掉它**，否则一个网络抖动就能冻结整个应用。
 *
 * @module monitors/dsh-remote-auth
 */

import { execFile } from 'node:child_process';
import { parseSigningSecret } from './dsh-instance';

/** 远端凭据的相对路径（相对远端 $HOME）。 */
const REMOTE_CREDENTIALS_PATH = '~/.dsh/.credentials.yaml';

/**
 * 默认的 SSH 硬超时。
 *
 * 【为什么是 45s 而不是 20s —— 实测教训】
 * 20s 时在真实环境里**经常超时**（实测日志：`SSH 超时（>20000ms）`），
 * 导致隧道实例的灯先变红，要等下一轮重试（约 +30s）才恢复。
 * 单次 SSH 握手实测波动很大：快的时候 ~11s，慢的时候**超过 4 分钟**
 * （后者大概是网络/对端 sshd 的固有抖动，不是我们能修的）。
 *
 * 45s 是折中：覆盖常见的 11–25s 区间，又不至于让一轮轮询挂太久。
 * 反正失败会重试，且密钥取回后缓存 30 分钟，所以"偶尔要试两次"是可接受的，
 * 但"每次都超时"不可接受。
 */
const DEFAULT_SSH_TIMEOUT_MS = 45_000;

/** 密钥缓存时长：远端密钥是持久化的，但可能被轮换，故设一个保守的保鲜期。 */
const DEFAULT_CACHE_TTL_MS = 30 * 60_000;

export interface SshCredentialsOptions {
  /** `user@host`。 */
  readonly sshHost: string;
  /** 远端 credentials 路径，默认 `~/.dsh/.credentials.yaml`。 */
  readonly remotePath?: string;
  /** SSH 硬超时（毫秒）。 */
  readonly timeoutMs?: number;
  /** 缓存保鲜期（毫秒）。 */
  readonly cacheTtlMs?: number;
  /** 额外的 ssh 参数（如 `-F /path/to/ssh_config`、`-p 2222`）。 */
  readonly extraArgs?: readonly string[];
  /** 诊断回调（不抛）。 */
  readonly onDebug?: (message: string) => void;
  /** 可注入的执行器，便于单测（默认走 execFile）。 */
  readonly exec?: (
    file: string,
    args: readonly string[],
  ) => Promise<{ ok: true; stdout: string } | { ok: false; reason: string }>;
}

/** 一次成功/失败的取密钥结果（供诊断）。 */
export interface SshFetchOutcome {
  readonly ok: boolean;
  readonly secretBytes?: number;
  readonly reason?: string;
}

/**
 * 通过 SSH 取远端 dsh 的 cookie 签名密钥。
 *
 * 语义：
 *   - 密钥取回后缓存（默认 30 分钟），避免每次轮询都起一个 ssh 进程
 *     —— 那会是每个实例每 5 秒一次 SSH 握手，完全不可接受。
 *   - 任何失败（超时、非零退出、解析失败）都返回带原因的失败，
 *     **不抛错**，由调用方计入失败计数并转 unknown。
 *   - 失败**不写缓存**，下次会重试（否则一次网络抖动就会锁死 30 分钟）。
 */
export class SshCredentialsSource {
  private cached: { secret: Buffer; at: number } | null = null;
  private readonly opts: Required<Pick<SshCredentialsOptions, 'remotePath' | 'timeoutMs' | 'cacheTtlMs'>> &
    SshCredentialsOptions;

  constructor(options: SshCredentialsOptions) {
    this.opts = {
      ...options,
      remotePath: options.remotePath ?? REMOTE_CREDENTIALS_PATH,
      timeoutMs: options.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS,
      cacheTtlMs: options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    };
  }

  /** 该来源的标识（用于日志）。 */
  get describe(): string {
    return `ssh:${this.opts.sshHost}`;
  }

  /**
   * 取密钥（带缓存）。
   * @returns 成功给出密钥；失败给出原因，绝不抛。
   */
  async get(now: number = Date.now()): Promise<{ ok: true; secret: Buffer } | { ok: false; reason: string }> {
    if (this.cached !== null && now - this.cached.at < this.opts.cacheTtlMs) {
      return { ok: true, secret: this.cached.secret };
    }

    const fetched = await this.fetchRemote();
    if (!fetched.ok) {
      return { ok: false, reason: fetched.reason };
    }

    this.cached = { secret: fetched.secret, at: now };
    this.opts.onDebug?.(
      `已从 ${this.opts.sshHost} 取回密钥（${fetched.secret.byteLength} 字节），缓存 ${Math.round(this.opts.cacheTtlMs / 60000)} 分钟`,
    );
    return { ok: true, secret: fetched.secret };
  }

  /** 强制失效缓存（密钥疑似轮换、或认证失败时调用以便重取）。 */
  invalidate(): void {
    this.cached = null;
  }

  /** 真正跑一次 ssh。 */
  private async fetchRemote(): Promise<{ ok: true; secret: Buffer } | { ok: false; reason: string }> {
    const exec = this.opts.exec ?? defaultExec(this.opts.timeoutMs);
    const args = [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=8',
      '-o',
      'StrictHostKeyChecking=accept-new',
      ...(this.opts.extraArgs ?? []),
      this.opts.sshHost,
      `cat ${this.opts.remotePath}`,
    ];

    let raw: string;
    try {
      const result = await exec('ssh', args);
      if (!result.ok) {
        return { ok: false, reason: result.reason };
      }
      raw = result.stdout;
    } catch (err) {
      return { ok: false, reason: `SSH 执行异常：${err instanceof Error ? err.message : String(err)}` };
    }

    if (typeof raw !== 'string' || raw.length === 0) {
      return { ok: false, reason: '远端 credentials 为空' };
    }

    try {
      // 复用本机同一套解析器 —— 远端文件与本机同格式（实测确认）
      const secret = parseSigningSecret(raw);
      return { ok: true, secret };
    } catch (err) {
      return {
        ok: false,
        reason: `远端 credentials 解析失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

/** 默认执行器：node:child_process + **硬超时**（这是上一轮踩坑的地方）。 */
function defaultExec(timeoutMs: number) {
  return (file: string, args: readonly string[]): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> =>
    new Promise((resolve) => {
      execFile(
        file,
        [...args],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (err === null) {
            resolve({ ok: true, stdout: stdout ?? '' });
            return;
          }
          // execFile 超时时 killed 为 true —— 与"连接被拒"要能区分开
          const killed = (err as { killed?: boolean }).killed === true;
          const code = (err as { code?: unknown }).code;
          const detail = (stderr ?? '').trim().split('\n')[0] ?? '';
          resolve({
            ok: false,
            reason: killed
              ? `SSH 超时（>${timeoutMs}ms）`
              : `SSH 失败（exit=${String(code)}）${detail ? `：${detail.slice(0, 160)}` : ''}`,
          });
        },
      );
    });
}
