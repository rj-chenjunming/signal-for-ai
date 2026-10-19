/**
 * dsh 端口自动跟随（SPEC-005）。
 *
 * ============================================================================
 * 【为什么需要】
 * ============================================================================
 * 桌面端 dsh（DeepSeek Harness）**每次启动都会换端口**——实测走过的序列：
 * `3080 → 19387 → 52119`。把 `authority` 写死在配置里，dsh 一重启灯就永久
 * 变灰（监控方 `transport/unreachable`，失败行又被浮窗隐藏），用户看不到任何
 * 变化，只能手工改配置。本项目的 `scripts/lib/live-dsh.mjs` 早就为验证脚本
 * 写过同样的兜底，这里是把它做成产品能力。
 *
 * ============================================================================
 * 【怎么判定"这个端口是我要的那个 dsh"】
 * ============================================================================
 *   1. `discoverDshInstances()` 枚举本机 LISTEN 端口（两条降级路径）；
 *   2. 先用 `GET /` 廉价筛出"是 dsh web"的端口（401 也算——那只是没带 cookie）；
 *   3. 只有候选才做**真正握手**：用本机密钥建 `DshClient` 调 `listSessions()`。
 *      成功（200）＝本机型、密钥匹配 → 就是它；401 ＝ 远端/隧道型 → 跳过。
 *
 * 第 3 步是关键：它和监控本身走的是同一条认证链路，能认证就等于"这盏灯能读它"。
 * 因此远端隧道实例（如 13080）不会被 auto 抢走 —— 它用本机密钥只会 401。
 */

import { discoverDshInstances, type DiscoveryResult, type DiscoverOptions } from './dsh-discovery';
import { DSH_HTML_MARKERS, DshClient } from './dsh-instance';
import type { SecretSource } from './dsh';

/** 自动发现只需要这两级日志（不依赖 logger 模块）。 */
export interface AutoDiscoverLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface AutoDiscoverOptions {
  /** 密钥来源链（与监控共用同一套 dshHome 判定）。 */
  readonly secretSources: readonly SecretSource[];
  /** 单次 RPC 超时，默认 8000（与监控一致）。 */
  readonly timeoutMs?: number;
  readonly log?: AutoDiscoverLogger;
  /** 测试注入点；默认就是真实的 `discoverDshInstances`。 */
  readonly discover?: (opts: DiscoverOptions) => Promise<DiscoveryResult>;
}

/** 页面探测超时：只是筛"是不是 dsh web"，不需要长。 */
const PAGE_PROBE_TIMEOUT_MS = 3_000;

interface ProbeOutcome {
  reachable: boolean;
  isDshWeb: boolean;
  status: number;
  hint: string;
}

/** 廉价阶段：`GET /` 看它像不像 dsh web（不签 cookie）。 */
async function probeDshPage(authority: string): Promise<ProbeOutcome> {
  try {
    const res = await fetch(`http://${authority}/`, {
      method: 'GET',
      headers: { accept: 'text/html' },
      redirect: 'manual',
      signal: AbortSignal.timeout(PAGE_PROBE_TIMEOUT_MS),
    });
    if (res.status === 401) {
      // 需要认证 = 很可能是 dsh web；是否本机密钥适用要等握手
      return { reachable: true, isDshWeb: true, status: 401, hint: 'GET / 返回 401（需要认证）' };
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
      hint: marker === undefined ? '返回 200 但无 dsh 特征' : `首页特征匹配（${marker}）`,
    };
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
 * 找出本机**能用本机密钥认证**的 dsh 实例。
 *
 * @returns 选中的 authority（形如 `127.0.0.1:52119`）；找不到返回 `null`。
 *          永远不抛异常：发现失败只是"这轮没找到"，由调用方按失败计数处理。
 */
export async function discoverLocalAuthority(
  options: AutoDiscoverOptions,
): Promise<string | null> {
  const discover = options.discover ?? discoverDshInstances;
  const log = options.log;

  let result: DiscoveryResult;
  try {
    result = await discover({
      probe: async (authority): Promise<ProbeOutcome> => {
        const page = await probeDshPage(authority);
        if (!page.isDshWeb) return page;

        // 真正握手：与监控同一条认证链路
        try {
          const source = options.secretSources.find((s) => s.supports(authority));
          if (source === undefined) {
            return { reachable: true, isDshWeb: true, status: 0, hint: '本机没有可用密钥来源' };
          }
          const secret = await source.get(authority);
          const client = new DshClient({
            authority,
            secret,
            timeoutMs: options.timeoutMs ?? 8_000,
          });
          const res = await client.listSessions();
          if (res.ok) {
            const count = res.value?.items?.length ?? 0;
            return {
              reachable: true,
              isDshWeb: true,
              status: 200,
              hint: `本机密钥认证通过（${count} 会话）`,
            };
          }
          const isAuth = res.code === 'auth/unauthorized' || res.code === 'auth/forbidden';
          return {
            reachable: true,
            isDshWeb: true,
            status: isAuth ? 401 : 0,
            hint: isAuth ? '本机密钥被拒（远端/隧道型）' : `握手失败：${res.code}`,
          };
        } catch (err) {
          return {
            reachable: true,
            isDshWeb: true,
            status: 0,
            hint: `握手异常：${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
      onProgress: (message) => log?.info(`dsh 自动发现：${message}`),
    });
  } catch (err) {
    log?.warn(`dsh 自动发现失败（已隔离）：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  if (result.listenerError !== undefined) {
    log?.warn(`dsh 自动发现：监听端口枚举两条路径都失败（${result.listenerError}）`);
  }

  const authenticated = result.instances.filter((i) => i.authenticated === true && i.status === 200);
  if (authenticated.length === 0) {
    log?.warn(
      `dsh 自动发现：探测 ${result.probedCount} 个候选，认出 ${result.instances.length} 个 dsh 实例，` +
        '但没有一个能用本机密钥认证（桌面端可能没启动，或密钥不匹配）',
    );
    return null;
  }

  // 多个可用实例时取第一个（端口枚举顺序不保证，但同一时刻通常只有一个）
  const chosen = authenticated[0]!;
  log?.info(`dsh 自动发现：选中 ${chosen.authority}（${chosen.hint}）`);
  return chosen.authority;
}
