/**
 * dsh 实例访问层 —— 对一个 dsh web 做认证、RPC、状态判定。
 *
 * 依赖: 仅 Node 内置（node:crypto / node:fs / node:path）+ 全局 fetch（Node 18+）。
 *       **刻意零新增依赖**，沿用架构铁律（PRD §5.1：运行时仅 electron + yaml）。
 *
 * 为什么能离线认证（这是对接 dsh 的关键突破，已实测）：
 *   dsh web 的 browser-auth 用一枚**持久化密钥**给 cookie 签名：
 *     cookieName  = "dsh-auth-" + base64url( sha256( authority ) )
 *     cookieValue = "v1." + base64url( JSON{version,authority,issuedAt,expiresAt} )
 *                   + "." + base64url( hmacSha256( secret, body ) )
 *   secret 明文存在 `~/.dsh/.credentials.yaml` 的
 *     records["client-connection/browser-session"].payload.secret
 *   它不是进程启动 token（那个只用于 `GET /?token=…` 换 cookie 一次），
 *   所以**跨重启有效，且无需从终端抄 token**。
 *   旧文档 04-SPEC.md §八 P0 卡住的"要问用户拿 token"由此解除。
 *
 * RPC 线协议（已实测）：
 *   POST http://<authority>/api/<namespace>/<method>
 *   body { type:"client-request", rpcId, method, payload:{ args } }
 *   resp { type:"server-response", rpcId, result:{ok:true,value}|{ok:false,error} }
 *
 * @module monitors/dsh-instance
 */

import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskStatus } from '../../shared/types';

/** 密钥期望长度（对应 dsh-client-connection 的 SECRET_BYTES）。 */
const SECRET_BYTES = 32;
const COOKIE_PREFIX = 'dsh-auth-';
const COOKIE_PAYLOAD_VERSION = 1;

/**
 * cookie 寿命（天）。
 *
 * ⚠️ 这个值**不是随便取的，实测踩过坑**：
 * dsh 的 browser-auth 在验证时有一条
 *   `payload.expiresAt - payload.issuedAt <= this.maxAgeMilliseconds`
 * （dsh-client-connection/lib/index.js:442），
 * 即 **服务端会拒绝"寿命超过它自己配置上限"的 cookie**，直接回 401。
 *
 * 曾经用 7 天，对 127.0.0.1:3080 得 401；改成 1 天立刻 200。
 * 本机该实例的 cookieMaxAgeDays 明显短于 7。
 *
 * 由于 DshClient **每次请求都重新签**一枚 cookie（见 DshClient.call），
 * 长寿命没有任何收益，取最小的安全值即可 —— 不要为了"省几次签名"调大它。
 */
const DEFAULT_MAX_AGE_DAYS = 1;

/** 一个 dsh web 实例的定位信息。 */
export interface DshAuthority {
  /** 形如 "127.0.0.1:3080"。cookie 名与签名都绑定它。 */
  readonly authority: string;
}

/** 实例的鉴权来源。 */
export type DshAuthKind =
  /** 本机实例：用本机 ~/.dsh/.credentials.yaml 的密钥即可认证。 */
  | 'local'
  /** 隧道/远端实例：本机密钥不匹配（实测必 401），需要远端密钥或启动 token。 */
  | 'remote';

/** 认证失败的分类，便于区分"密钥过期"与"网络不通"（PRD：401/403 要单独记日志）。 */
export type DshAuthErrorCode =
  | 'auth/unauthorized'
  | 'auth/forbidden'
  | 'transport/unreachable'
  | 'transport/timeout'
  | 'protocol/bad-json'
  | 'protocol/rpc-id-mismatch'
  | 'protocol/arguments-invalid'
  | 'credentials/missing'
  | 'credentials/malformed'
  | 'http/error';

export interface DshRpcFailure {
  readonly ok: false;
  readonly code: DshAuthErrorCode;
  readonly message: string;
}

export interface DshRpcSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export type DshRpcResult<T> = DshRpcSuccess<T> | DshRpcFailure;

/** `session/list` 单个条目里我们真正用到的字段（其余实测存在但此处不建模）。 */
export interface DshSessionListItem {
  readonly sessionId?: string;
  readonly updatedAt?: number;
  readonly agentAvailable?: boolean;
  readonly running?: boolean;
  readonly blank?: boolean;
  readonly cwd?: string;
  readonly parentSessionId?: string;
  readonly origin?: string;
  readonly projections?: {
    readonly asOfSeq?: number;
    readonly values?: {
      readonly title?: string;
      readonly plan?: { readonly active?: boolean; readonly pending?: boolean };
      readonly subagentCatalog?: readonly { readonly id?: string; readonly settledAt?: number }[];
      readonly permissions?: { readonly currentValue?: string };
      readonly contextPressure?: { readonly pressureTokens?: number; readonly contextWindow?: number };
      readonly tokenUsage?: {
        readonly uncachedInputTokens?: number;
        readonly outputTokens?: number;
      };
    };
  };
}

// ---------------------------------------------------------------------------
// base64url / 密钥
// ---------------------------------------------------------------------------

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf
    .toString('base64')
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
}

function decodeBase64url(value: string): Buffer {
  return Buffer.from(value.replace(/-/gu, '+').replace(/_/gu, '/'), 'base64');
}

/**
 * 从 credentials 文件文本里取 browser-session 签名密钥。
 *
 * 为什么不引 yaml 包：只需要读取一个**已知路径下的一个字段**，
 * 为此把整个 YAML 解析器拖进热路径不划算（架构铁律：依赖越少越好）。
 * 但解析要足够谨慎——定位不到就明确抛错，绝不静默返回空密钥。
 *
 * @throws 当文件缺失、记录缺失、字段缺失或密钥长度异常时
 */
export function parseSigningSecret(credentialsText: string): Buffer {
  const at = credentialsText.indexOf('client-connection/browser-session');
  if (at === -1) {
    throw new Error('credentials 里没有 client-connection/browser-session 记录');
  }

  // 只在该记录开始的窗口内找 secret，避免误抓 refs 段里的同名键
  const window = credentialsText.slice(at, at + 2000);
  const matched = /^\s*secret:\s*(\S+)\s*$/mu.exec(window);
  if (!matched?.[1]) {
    throw new Error('browser-session 记录里没有 secret 字段');
  }

  const secret = decodeBase64url(matched[1]);
  if (secret.byteLength !== SECRET_BYTES) {
    throw new Error(
      `browser-session 密钥长度异常：期望 ${SECRET_BYTES} 字节，实际 ${secret.byteLength} 字节`,
    );
  }
  return secret;
}

/** 从磁盘读取本机 dsh 的签名密钥。 */
export function readSigningSecret(dshHome: string): Buffer {
  const path = join(dshHome, '.credentials.yaml');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`读不到 credentials 文件 ${path}：${errText(err)}`);
  }
  return parseSigningSecret(text);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// cookie 签名
// ---------------------------------------------------------------------------

export interface SignedCookie {
  readonly name: string;
  readonly value: string;
  /** 可直接放进请求头的 `name=value`。 */
  readonly header: string;
}

/**
 * 为某个 authority 签一枚 browser-session cookie。
 *
 * ⚠️ `authority` 必须是**你实际要连的** host:port。
 * cookie 名与签名都绑定 authority —— 用本机密钥为隧道端口签，
 * 若该端口的 dsh 并不使用本机密钥，服务端必然 401。
 * **这正是「本机实例」与「远端隧道实例」的判别依据**（见 classifyAuth）。
 */
export function signCookie(
  authority: string,
  secret: Buffer,
  maxAgeDays: number = DEFAULT_MAX_AGE_DAYS,
): SignedCookie {  const name = COOKIE_PREFIX + base64url(createHash('sha256').update(authority, 'utf8').digest());
  const issuedAt = Date.now();
  const expiresAt = issuedAt + maxAgeDays * 86_400_000;

  const body = base64url(
    JSON.stringify({
      version: COOKIE_PAYLOAD_VERSION,
      authority,
      issuedAt,
      expiresAt,
    }),
  );
  // ⚠️ 必须把**原始字节**交给 HMAC。
  //
  // 曾经因为一个 TS 类型摩擦把它写成 `secret.toString('base64')`，
  // 结果是用 base64 文本的 ASCII 字节当密钥 —— 与 dsh 的服务端算法完全不同，
  // 表现为"cookie 名字对、格式对、长度对，但一律 401"，极难定位。
  // `as unknown as string` 只是让类型检查通过，运行时拿到的仍是 Buffer 本身。
  const value = `v1.${body}.${base64url(
    createHmac('sha256', secret as unknown as string).update(body, 'utf8').digest(),
  )}`;
  return { name, value, header: `${name}=${value}` };
}

// ---------------------------------------------------------------------------
// RPC 客户端
// ---------------------------------------------------------------------------

export interface DshClientOptions {
  readonly authority: string;
  readonly secret: Buffer;
  /** 单次请求超时，默认 8s。 */
  readonly timeoutMs?: number;
}

/**
 * 一个 dsh web 的最小 RPC 客户端。
 * 所有异常都被收敛成 `DshRpcResult`，**不向调用方抛错**——
 * 沿用架构铁律：单个监控器的异常绝不能扩散出去。
 */
export class DshClient {
  readonly authority: string;
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly cookie: SignedCookie;

  constructor(opts: DshClientOptions) {
    this.authority = opts.authority;
    this.base = `http://${opts.authority}`;
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.cookie = signCookie(opts.authority, opts.secret);
  }

  /**
   * 调一个 RPC 端点。
   *
   * @param endpoint - 形如 `session/list`
   * @param args - 端点要求的参数形状。⚠️ 实测**两种风格并存**，不可猜：
   *   `session/list`        → `{ _request: {} }`
   *   `session/projections` → `{ request: { sessionId } }`
   */
  async call<T>(endpoint: string, args: unknown = {}): Promise<DshRpcResult<T>> {
    const rpcId = randomUUID();

    let res: Response;
    try {
      res = await fetch(`${this.base}/api/${endpoint}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: this.cookie.header,
        },
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method: endpoint,
          payload: { args },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === 'TimeoutError';
      return {
        ok: false,
        code: isTimeout ? 'transport/timeout' : 'transport/unreachable',
        message: errText(err),
      };
    }

    if (res.status === 401) {
      return {
        ok: false,
        code: 'auth/unauthorized',
        message: '401 —— 密钥与该实例不匹配（大概率是远端/隧道实例）',
      };
    }
    if (res.status === 403) {
      return { ok: false, code: 'auth/forbidden', message: '403 —— Host/Origin 栅栏拒绝' };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        code: 'http/error',
        message: `HTTP ${res.status}${text ? `：${text.slice(0, 160)}` : ''}`,
      };
    }

    let envelope: {
      rpcId?: unknown;
      result?: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } };
    };
    try {
      envelope = (await res.json()) as typeof envelope;
    } catch (err) {
      return { ok: false, code: 'protocol/bad-json', message: errText(err) };
    }

    // rpcId 必须回带一致，否则说明响应串包（并发下真实风险）
    if (envelope.rpcId !== rpcId) {
      return {
        ok: false,
        code: 'protocol/rpc-id-mismatch',
        message: `期望 ${rpcId}，收到 ${String(envelope.rpcId)}`,
      };
    }

    const result = envelope.result;
    if (result === undefined) {
      return { ok: false, code: 'protocol/bad-json', message: '响应缺少 result 字段' };
    }
    if (result.ok === false) {
      const code = result.error?.code ?? '';
      return {
        ok: false,
        code: code === 'gateway/arguments-invalid' ? 'protocol/arguments-invalid' : 'http/error',
        message: `${code}：${result.error?.message ?? '未知错误'}`,
      };
    }
    return { ok: true, value: result.value as T };
  }

  /** 会话全量列表（含投影）。这是状态灯的主数据源。 */
  async listSessions(): Promise<DshRpcResult<{ items?: DshSessionListItem[] }>> {
    return this.call<{ items?: DshSessionListItem[] }>('session/list', { _request: {} });
  }

  /** 单个会话的投影（比 list 更新，`asOfSeq` 可作增量锚点）。 */
  async sessionProjections(sessionId: string): Promise<DshRpcResult<{ values?: unknown }>> {
    return this.call<{ values?: unknown }>('session/projections', { request: { sessionId } });
  }

  /**
   * 探活：`GET /` 是否返回 dsh 的 index.html。
   *
   * 用途：端口自动发现时区分「是 dsh web」和「是别的 HTTP 服务」。
   * ⚠️ 必须带上本客户端的 cookie——不带的话永远是 401，
   * 会把本机实例误判成远端实例（这个 bug 真的出现过，别删这行）。
   *
   * 401 也是**有效信息**：那条文案是 dsh 自己写的，且说明本机密钥不匹配。
   */
  async probe(): Promise<{ reachable: boolean; isDshWeb: boolean; status: number; hint: string }> {
    try {
      const res = await fetch(`${this.base}/`, {
        method: 'GET',
        headers: { accept: 'text/html', cookie: this.cookie.header },
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
        hint: marker ? `index.html 特征匹配（${marker}）` : '返回 200 但无 dsh 特征',
      };
    } catch (err) {
      return { reachable: false, isDshWeb: false, status: 0, hint: `不可达：${errText(err)}` };
    }
  }
}

/** dsh web 首页特征串（任一命中即认为是 dsh web）。 */
export const DSH_HTML_MARKERS = ['__DSH_BOOT__', 'data-dsh', 'dsh web', 'dsh-client'] as const;

// ---------------------------------------------------------------------------
// 状态判定
// ---------------------------------------------------------------------------

/**
 * 判定一个 dsh 会话的状态。
 *
 * 优先级**严格照搬 dsh 自己的实现**
 * （dsh-client-ui-workspace/lib/client.js:1383-1432）：
 *   pendingInteraction > runningSubagentCount > running > completed > idle
 * 再叠加本项目的 failed / starting 语义。
 *
 * ⚠️ `pendingInteraction` 是**插件精确上报**的信号（PRD 里最值钱的那个态：
 * 卡住等你授权）。没装插件时它是 undefined，此时**故意不以 `plan.pending` 顶替**——
 * 宁可判 running/idle，也不要为了"看起来更准"而误报 waiting（假黄灯会让人白等）。
 * 未装插件的实例走 `plan` 近似判定，由调用方显式选择（见 deriveFromListItem）。
 */
export function deriveSessionStatus(input: {
  readonly running?: boolean;
  readonly agentAvailable?: boolean;
  readonly pendingInteraction?: 'approval' | 'plan-review' | 'question';
  readonly runningSubagentCount?: number;
  readonly planPending?: boolean;
  readonly updatedAt?: number;
  readonly now?: number;
  readonly errorMessage?: string;
  /** 静默多久算「不在跑了」，默认 60s（PRD §5.4 防灯一直是绿的）。 */
  readonly silenceMs?: number;
  /** 刚刚有活动 → 视为 starting 的窗口，默认 5s。 */
  readonly connectGraceMs?: number;
}): TaskStatus {
  const now = input.now ?? Date.now();
  const silenceMs = input.silenceMs ?? 60_000;
  const connectGraceMs = input.connectGraceMs ?? 5_000;

  // failed 一票否决（PRD §4.4：failed 优先级最高）
  if (input.errorMessage !== undefined && input.errorMessage !== '') {
    return 'failed';
  }

  // ① 等待人类：插件精确上报优先
  if (input.pendingInteraction !== undefined) return 'waiting';

  /*
   * ②★ 静默过久 -> 一律不再当作在跑。
   *
   * 【这条必须放在 running 判定**之前** —— 这是一个真实 bug 的修复】
   * 原实现把静默判定放在 running / runningSubagentCount **之后**，
   * 于是只要 dsh 还报着 `running: true`，或 `subagentCatalog` 里留着
   * 一个永远没写 `settledAt` 的陈旧条目，这个会话就会**永远显示蓝色**。
   *
   * 实测抓到过：某会话 `running=true`、未结算子代理=2、**静默 727 秒**，
   * 仍然判 running —— 用户的原话是"明明都执行完成了怎么显示还是运行中"。
   *
   * 语义依据：PRD §5.4「防灯一直是绿的」的镜像要求 ——
   * 也**不能一直是蓝的**。静默超过阈值就说明没人在这条会话上干活了。
   * `updatedAt` 缺失时不做此判定（没有时间信息就不能假设它静默了）。
   */
  if (
    input.updatedAt !== undefined &&
    now - input.updatedAt > silenceMs &&
    input.pendingInteraction === undefined
  ) {
    return 'idle';
  }

  // ③ 子代理在跑也算运行中（dsh 自己就是这么判的）
  if ((input.runningSubagentCount ?? 0) > 0) return 'running';

  // ④ 主 agent 在跑
  if (input.running === true) return 'running';

  // ⑤ 刚刚有活动 → starting，避免刚发消息时灯闪一下 idle
  if (input.updatedAt !== undefined && now - input.updatedAt < connectGraceMs) return 'starting';

  // ⑥ agent 已不在 → idle
  if (input.agentAvailable === false) return 'idle';

  // ⑦ 其余：活跃但没在跑
  return 'idle';
}

/**
 * 从 `session/list` 的一个条目推导**轮询侧**的状态。
 *
 * ⚠️ 这里**只用轮询拿得到的信息**：`running` / `agentAvailable` /
 * `plan.pending` / `subagentCatalog`。
 * 插件的**精确**信号（`pendingInteraction`）刻意不在这里合并 ——
 * 合并要放在 `mergeExactIntoPolled()`（dsh-arbiter.ts），
 * 因为那条路径还要保证「轮询已判 failed 时不许被 waiting 粉饰」（PRD §4.4）。
 * 若在这里就把精确值混进来，那条保护就失效了。
 *
 * `plan.pending` 是本函数能给出的**最佳近似**：没有插件时它就是"有人在等审计划"
 * 的唯一线索。它是近似的（可能误报），但比什么都不报强，且调用方可选择关闭。
 */
export function deriveFromListItem(
  item: DshSessionListItem,
  now: number = Date.now(),
  options: { allowPlanPendingHeuristic?: boolean } = {},
): TaskStatus {
  const values = item.projections?.values;
  const unsettled = (values?.subagentCatalog ?? []).filter((s) => s.settledAt === undefined).length;

  const allowPlan = options.allowPlanPendingHeuristic !== false;
  const planPending = allowPlan && values?.plan?.pending === true;

  return deriveSessionStatus({
    running: item.running,
    agentAvailable: item.agentAvailable,
    // 仅用近似信号；精确信号由上层 merge 负责
    ...(planPending ? { pendingInteraction: 'plan-review' as const } : {}),
    runningSubagentCount: unsettled,
    updatedAt: item.updatedAt,
    now,
  });
}
