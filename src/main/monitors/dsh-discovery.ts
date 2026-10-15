/**
 * dsh 多端口自动发现（设计决策 D4：自动发现 + 手动覆盖）。
 *
 * 目标：找出本机有哪些 dsh web 在监听，并分清「本机实例」与「远端隧道实例」。
 *
 * 三层判定：
 *   1. 枚举 127.0.0.1 / 0.0.0.0 上的 LISTEN 端口
 *   2. 对每个端口探 `GET /`，用 dsh 首页特征串确认「是 dsh web」
 *      —— 必要：本机实测有 50+ 个监听端口，其中 51 个是别的 HTTP 服务
 *   3. 用本机密钥签 cookie 再探一次：
 *        200 → 本机型（密钥匹配）
 *        401 → 仍是 dsh web，但密钥不匹配 → 远端/隧道型（D5 需远端密钥）
 *
 * 端口枚举刻意准备两条路（沿用项目的降级链惯例）：
 *   - `Get-NetTCPConnection`（快、结构化，但部分沙箱会拦）
 *   - `netstat -ano`（更原始、更抗拦）
 *
 * @module monitors/dsh-discovery
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DSH_HTML_MARKERS } from './dsh-instance';

const execFileAsync = promisify(execFile);

/** 一个发现到的 dsh web 实例。 */
export interface DiscoveredDshInstance {
  /** 形如 `127.0.0.1:3080`。 */
  readonly authority: string;
  /** 监听进程 pid（自动发现时可得；手动条目为 undefined）。 */
  readonly pid: number | undefined;
  /** 来源：自动扫描到的，还是配置显式声明的。 */
  readonly origin: 'auto' | 'manual';
  /** 鉴权形态。 */
  readonly kind: 'local' | 'remote';
  /** 本机密钥是否可直接认证。 */
  readonly authenticated: boolean;
  /** HTTP 状态码（0 = 不可达）。 */
  readonly status: number;
  /** 人可读的判定依据。 */
  readonly hint: string;
}

/** 探测过但确认不是 dsh 的候选（保留以便排查误判）。 */
export interface NonDshCandidate {
  readonly authority: string;
  readonly status: number;
  readonly reachable: boolean;
  readonly hint: string;
}

export interface DiscoveryResult {
  /** 端口枚举走的哪条降级路径。 */
  readonly listenerSource: 'Get-NetTCPConnection' | 'netstat -ano' | 'none';
  /** 两条枚举路径都失败时的原因（此时 instances 必为空，需明确告知而不是假装"没有 dsh"）。 */
  readonly listenerError: string | undefined;
  readonly probedCount: number;
  readonly instances: readonly DiscoveredDshInstance[];
  readonly nonDsh: readonly NonDshCandidate[];
}

export interface DiscoverOptions {
  /** 为某个 authority 取已签好的 cookie 头（没有则只做无认证探测）。 */
  readonly cookieFor?: (authority: string) => string | undefined;
  /** 显式追加的端口（手动覆盖）。 */
  readonly extraPorts?: readonly number[];
  /** 显式追加的完整 authority（支持非 127.0.0.1 的写法）。 */
  readonly extraAuthorities?: readonly string[];
  /** 排除的端口（手动覆盖的另一半：把已知的非 dsh 服务挡在探测之外）。 */
  readonly excludePorts?: readonly number[];
  /** 并发探测上限，默认 12（避免瞬时打爆本机）。 */
  readonly concurrency?: number;
  readonly onProgress?: (message: string) => void;
  /** 注入探针，便于测试。默认走 DshClient.probe。 */
  readonly probe?: (authority: string, cookieHeader?: string) => Promise<{
    reachable: boolean;
    isDshWeb: boolean;
    status: number;
    hint: string;
  }>;
}

/**
 * 明显不可能是 web 服务的系统端口，默认不探测。
 * 这些端口被扫到只会浪费一次超时。
 */
const DEFAULT_EXCLUDED_PORTS: readonly number[] = [
  135, 139, 445, 3389, 5040, 49_664, 49_665, 49_666, 49_667, 49_668, 49_670,
];

interface Listener {
  readonly address: string;
  readonly port: number;
  readonly pid: number;
}

/** 解析 `netstat -ano` 输出，取 LISTENING 行。 */
export function parseNetstatOutput(text: string): Listener[] {
  const out: Listener[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const matched = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/iu.exec(line);
    if (!matched) continue;
    const port = Number(matched[2]);
    const pid = Number(matched[3]);
    if (!Number.isInteger(port) || port <= 0) continue;
    out.push({ address: matched[1] ?? '', port, pid: Number.isInteger(pid) ? pid : 0 });
  }
  return out;
}

/** 只保留 loopback / 通配地址上的监听。 */
function isLoopbackish(address: string): boolean {
  return /^(127\.0\.0\.1|0\.0\.0\.0|::1|::|\[::1\]|\[::\])$/u.test(address);
}

/**
 * 枚举本机监听端口。
 * @returns `source` 标明走了哪条降级路径；两条都失败时 `error` 有值。
 */
export async function enumerateListeners(
  excludePorts: readonly number[] = [],
  includeAllInterfaces = false,
): Promise<{ listeners: Listener[]; source: DiscoveryResult['listenerSource']; error?: string }> {
  const excluded = new Set<number>([...DEFAULT_EXCLUDED_PORTS, ...excludePorts]);

  // ---- 路径 1：Get-NetTCPConnection（结构化，快）
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress',
      ],
      { timeout: 15_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );

    const trimmed = stdout.trim();
    if (trimmed.length > 0) {
      const parsed: unknown = JSON.parse(trimmed);
      const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
      const listeners = rows
        .map((row) => {
          const r = row as { LocalAddress?: unknown; LocalPort?: unknown; OwningProcess?: unknown };
          return { address: String(r.LocalAddress ?? ''), port: Number(r.LocalPort), pid: Number(r.OwningProcess) };
        })
        .filter((l) => Number.isInteger(l.port) && l.port > 0 && !excluded.has(l.port))
        .filter((l) => includeAllInterfaces || isLoopbackish(l.address));

      if (listeners.length > 0) {
        return { listeners, source: 'Get-NetTCPConnection' };
      }
    }
  } catch {
    /* 落到路径 2 */
  }

  // ---- 路径 2：netstat -ano（降级）
  try {
    const { stdout } = await execFileAsync('netstat.exe', ['-ano'], {
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    const listeners = parseNetstatOutput(stdout)
      .filter((l) => !excluded.has(l.port))
      .filter((l) => includeAllInterfaces || isLoopbackish(l.address));
    return { listeners, source: 'netstat -ano' };
  } catch (err) {
    // 两条路都断了：明确上报，绝不假装"没有 dsh"
    return { listeners: [], source: 'none', error: err instanceof Error ? err.message : String(err) };
  }
}

/** 默认探针：走 DshClient.probe()。 */
async function defaultProbe(authority: string, cookieHeader?: string) {
  // 用一个"空密钥"客户端做纯探测；cookie 由调用方直接给出时才设置。
  // 这里不签 cookie 也能拿到 401/200，足以判定是不是 dsh web；
  // 但为了区分本机/远端，需要带上本机签好的 cookie。
  const probeAuthority = async () => {
    const res = await fetch(`http://${authority}/`, {
      method: 'GET',
      headers: {
        accept: 'text/html',
        ...(cookieHeader === undefined ? {} : { cookie: cookieHeader }),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(4_000),
    });

    if (res.status === 401) {
      const text = await res.text().catch(() => '');
      return {
        reachable: true,
        isDshWeb: true,
        status: 401,
        hint: text.trim().slice(0, 160) || '401 未授权',
      };
    }
    if (res.status !== 200) {
      return { reachable: true, isDshWeb: false, status: res.status, hint: `HTTP ${res.status}` };
    }
    const html = await res.text().catch(() => '');
    const marker = DSH_HTML_MARKERS.find((m) => html.includes(m));
    return {
      reachable: true,
      isDshWeb: marker !== undefined,
      status: 200,
      hint: marker === undefined ? '返回 200 但无 dsh 特征' : `index.html 特征匹配（${marker}）`,
    };
  };

  try {
    return await probeAuthority();
  } catch (err) {
    return {
      reachable: false,
      isDshWeb: false,
      status: 0,
      hint: `不可达：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 全量发现：枚举 → 探测 → 分类。
 *
 * 注意：**不会**因为某个端口探测失败而中断整体；
 * 单个探测的异常不会扩散（沿用架构铁律）。
 */
export async function discoverDshInstances(opts: DiscoverOptions = {}): Promise<DiscoveryResult> {
  const {
    cookieFor,
    extraPorts = [],
    extraAuthorities = [],
    excludePorts = [],
    concurrency = 12,
    onProgress,
    probe = defaultProbe,
  } = opts;

  const { listeners, source, error } = await enumerateListeners(excludePorts);

  // 汇总候选：自动发现的 + 手动追加的（手动覆盖，去重）
  const candidates = new Map<string, { authority: string; pid: number | undefined; origin: 'auto' | 'manual' }>();
  for (const l of listeners) {
    const authority = `127.0.0.1:${l.port}`;
    if (!candidates.has(authority)) {
      candidates.set(authority, { authority, pid: l.pid, origin: 'auto' });
    }
  }
  for (const port of extraPorts) {
    const authority = `127.0.0.1:${port}`;
    candidates.set(authority, { authority, pid: undefined, origin: 'manual' });
  }
  for (const authority of extraAuthorities) {
    candidates.set(authority, { authority, pid: undefined, origin: 'manual' });
  }

  onProgress?.(
    `枚举到 ${listeners.length} 个监听端口（来源：${source}），开始探测 ${candidates.size} 个候选`,
  );

  const list = [...candidates.values()];
  const probed: {
    authority: string;
    pid: number | undefined;
    origin: 'auto' | 'manual';
    reachable: boolean;
    isDshWeb: boolean;
    status: number;
    hint: string;
  }[] = [];

  // 分批并发，避免瞬时打爆本机
  for (let i = 0; i < list.length; i += concurrency) {
    const batch = list.slice(i, i + concurrency);
    const settled = await Promise.all(
      batch.map(async (c) => {
        // 单个候选探测失败绝不扩散
        try {
          const cookieHeader = cookieFor?.(c.authority);
          const result = await probe(c.authority, cookieHeader);
          return { ...c, ...result };
        } catch (err) {
          return {
            ...c,
            reachable: false,
            isDshWeb: false,
            status: 0,
            hint: `探测异常：${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }),
    );
    probed.push(...settled);
  }

  const instances: DiscoveredDshInstance[] = probed
    .filter((r) => r.isDshWeb)
    .map((r) => ({
      authority: r.authority,
      pid: r.pid,
      origin: r.origin,
      kind: r.status === 200 ? 'local' : 'remote',
      authenticated: r.status === 200,
      status: r.status,
      hint: r.hint,
    }));

  const nonDsh: NonDshCandidate[] = probed
    .filter((r) => !r.isDshWeb)
    .map((r) => ({ authority: r.authority, status: r.status, reachable: r.reachable, hint: r.hint }));

  return {
    listenerSource: source,
    listenerError: error,
    probedCount: probed.length,
    instances,
    nonDsh,
  };
}
