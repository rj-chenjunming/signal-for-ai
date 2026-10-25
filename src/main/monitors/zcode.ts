/**
 * `zcode` 型监控器 —— 只读轮询 ZCode 会话库（`~/.zcode/cli/db/db.sqlite`），
 * 把本机会话活动聚合为七态（SPEC-041）。
 *
 * 【数据源与隐私】只 SELECT 元数据列（探针结论见 SPEC-041 §6）：
 *   - `session`：目录、软删除/归档标记（判定"哪些会话参与"）
 *   - `tool_usage`：开放工具调用（completed_at IS NULL）+ approval_status（等待授权）
 *   - `model_usage`：开放模型请求（completed_at IS NULL）——工具调用之间的流式思考期
 *   - `turn_usage`：已收尾回合（completed 非空）——成功/失败边界；cancelled 视为 idle
 * 不读 message/part 正文，不读 `cli/rollout/model-io-*.jsonl` 与 `v2/credentials`。
 * 时间戳一律 epoch 毫秒；turn_usage 行只在回合结束后写入，开放判定只看 *_usage。
 *
 * 【为什么子进程跑系统 node】同 sqlite 型：Electron 内置 Node 20 没有 node:sqlite。
 * 复用 sqlite.ts 的 resolveSystemNode 与 execFile 模式。
 */

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MonitorAdapter, type MonitorContext } from './base';
import { COMPLETION_STARTUP_GRACE_MS, resolveSystemNode } from './sqlite';
import type { TaskStatus, ZCodeMonitorConfig } from '../../shared/types';

/** 默认会话库路径（WAL 模式，`?mode=ro` 只读打开不阻塞 ZCode 写入）。 */
export function defaultZcodeDbPath(): string {
  return join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
}

const DEFAULT_INTERVAL_MS = 3_000;
/** 分钟级窗口（SPEC-030 教训）：长工具执行期间会话可能不写库。 */
const DEFAULT_ACTIVE_WITHIN_MS = 600_000;
/** 单次读取失败连续多少次后判 `unknown`。 */
const DEFAULT_MAX_FAILURES = 3;
/** 子进程单次查询超时。 */
const QUERY_TIMEOUT_MS = 15_000;
/** 单轮查询的行数上限（防大库拖慢；按 time_* DESC 取最近）。 */
const LIMIT_SESSIONS = 200;
const LIMIT_OPEN = 50;
const LIMIT_TURNS = 200;

/* ============================================================================
 * 探针行（子进程 JSON 输出的形状，字段与真实 schema 同名去蛇形）
 * ==========================================================================*/

export interface ZcodeSessionRow {
  readonly id: string;
  readonly directory: string | null;
  readonly path: string | null;
  readonly timeUpdated: number;
  readonly lastOutcome: string | null;
}

export interface ZcodeOpenRow {
  readonly sessionId: string;
  readonly startedAt: number;
  readonly approvalStatus: string | null;
}

export interface ZcodeTurnRow {
  readonly sessionId: string;
  readonly status: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly errorType: string | null;
}

/** 单轮查询的完整快照。 */
export interface ZcodeProbe {
  readonly sessions: readonly ZcodeSessionRow[];
  readonly openModels: readonly ZcodeOpenRow[];
  readonly openTools: readonly ZcodeOpenRow[];
  readonly turns: readonly ZcodeTurnRow[];
}

export interface ZcodeVerdict {
  readonly status: 'running' | 'waiting' | 'failed' | 'success' | 'idle';
  readonly message: string;
  readonly completionAt?: number;
}

/* ============================================================================
 * 纯判定逻辑（不依赖 IO，可单测）
 * ==========================================================================*/

/** 目录归一化：大小写/分隔符/尾斜杠不敏感（Windows 路径书写差异大）。 */
export function normalizeZcodePath(input: string): string {
  return input.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

function matchesProjects(session: ZcodeSessionRow, projects: readonly string[]): boolean {
  if (projects.length === 0) return true;
  const candidates = [session.directory, session.path]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map(normalizeZcodePath);
  return projects.some(project => candidates.includes(normalizeZcodePath(project)));
}

/**
 * 由查询快照判定该任务的状态（优先级 waiting > running > failed > success > idle）。
 *
 *   waiting  = 开放工具行 approval_status ∉ {NULL,'none'}。等待授权不受新鲜窗约束
 *              （用户可以离开很久）；孤儿行由 store 的 waiting_timeout 兜底转 failed。
 *   running  = 开放 model/tool 行且 started_at 在新鲜窗内（未来时间戳视为时钟偏移丢弃）。
 *   failed   = 最近收尾回合 status='error'（受启动基线约束，不重放历史失败）。
 *   success  = 最近收尾回合 status='completed' 且 completedAt > max(已确认水位, 启动基线)，
 *              completionAt = completedAt（store 的确认闸门防复亮）。
 *   idle     = 其余（含 cancelled 回合：用户主动中止，同 Codex turn_aborted 口径）。
 *
 * 刻意**不使用** `session.time_updated > 最近回合完成时刻` 之类推断 running：
 * 标题生成等收尾写库会把刚完成的会话误翻蓝（绿灯闪蓝）；流式间隙由
 * model_usage 开放行覆盖，无需推断。
 */
export function deriveZcodeVerdict(
  probe: ZcodeProbe,
  opts: {
    projects?: readonly string[];
    activeWithinMs: number;
    now: number;
    ackedAt?: number;
    earliestCompletionAt?: number;
  },
): ZcodeVerdict {
  const projects = opts.projects ?? [];
  const ackedAt = opts.ackedAt ?? 0;
  const earliest = opts.earliestCompletionAt ?? 0;

  const sessions = probe.sessions.filter(session => matchesProjects(session, projects));
  const ids = new Set(sessions.map(session => session.id));
  const inScope = <T extends { sessionId: string }>(rows: readonly T[]): T[] =>
    rows.filter(row => ids.has(row.sessionId));
  const openTools = inScope(probe.openTools);
  const openModels = inScope(probe.openModels);
  const turns = inScope(probe.turns);

  const awaiting = openTools.filter(
    row => typeof row.approvalStatus === 'string' && row.approvalStatus.length > 0 && row.approvalStatus !== 'none',
  );
  if (awaiting.length > 0) {
    return { status: 'waiting', message: `${awaiting.length} 个 ZCode 工具调用等待授权` };
  }

  const liveOpen = [...openTools, ...openModels].filter(
    row => row.startedAt > 0 && row.startedAt <= opts.now && opts.now - row.startedAt <= opts.activeWithinMs,
  );
  if (liveOpen.length > 0) {
    return { status: 'running', message: `${liveOpen.length} 个 ZCode 会话执行中` };
  }

  let latest: ZcodeTurnRow | undefined;
  for (const row of turns) {
    if (!latest || row.completedAt > latest.completedAt) latest = row;
  }
  if (latest && latest.completedAt > 0 && latest.completedAt <= opts.now && latest.completedAt > earliest) {
    if (latest.status === 'error') {
      return { status: 'failed', message: 'ZCode 回合失败' };
    }
    if (latest.status === 'completed' && latest.completedAt > Math.max(ackedAt, earliest)) {
      return { status: 'success', message: 'ZCode 回合完成，点击确认', completionAt: latest.completedAt };
    }
  }

  return { status: 'idle', message: 'ZCode 无执行中会话' };
}

/* ============================================================================
 * 子进程查询
 * ==========================================================================*/

/**
 * 生成交给系统 node 执行的查询脚本。只读打开、只取元数据列、行数有界。
 * 新鲜度在主进程按 mocked 时钟判定，脚本内不用 Date.now（测试可全确定性）。
 */
export function buildZcodeQueryScript(database: string): string {
  return [
    "const { DatabaseSync } = require('node:sqlite');",
    `const db = new DatabaseSync(${JSON.stringify(database)}, { readOnly: true });`,
    "const all = (sql) => db.prepare(sql).all();",
    `const sessions = all("SELECT id, directory, path, time_updated AS timeUpdated, last_outcome AS lastOutcome FROM session WHERE time_deleted IS NULL AND time_archived IS NULL ORDER BY time_updated DESC LIMIT ${LIMIT_SESSIONS}");`,
    `const openModels = all("SELECT session_id AS sessionId, started_at AS startedAt, NULL AS approvalStatus FROM model_usage WHERE completed_at IS NULL ORDER BY started_at DESC LIMIT ${LIMIT_OPEN}");`,
    `const openTools = all("SELECT session_id AS sessionId, started_at AS startedAt, approval_status AS approvalStatus FROM tool_usage WHERE completed_at IS NULL ORDER BY started_at DESC LIMIT ${LIMIT_OPEN}");`,
    `const turns = all("SELECT session_id AS sessionId, status, started_at AS startedAt, completed_at AS completedAt, error_type AS errorType FROM turn_usage WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT ${LIMIT_TURNS}");`,
    'db.close();',
    'process.stdout.write(JSON.stringify({ sessions, openModels, openTools, turns }));',
  ].join('\n');
}

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseProbe(stdout: string): ZcodeProbe {
  const raw = JSON.parse(stdout) as Record<string, unknown>;
  const rows = (key: string): Record<string, unknown>[] =>
    Array.isArray(raw[key]) ? (raw[key] as Record<string, unknown>[]) : [];
  return {
    sessions: rows('sessions').map(row => ({
      id: String(row['id'] ?? ''),
      directory: asString(row['directory']),
      path: asString(row['path']),
      timeUpdated: asNumber(row['timeUpdated']),
      lastOutcome: asString(row['lastOutcome']),
    })),
    openModels: rows('openModels').map(row => ({
      sessionId: String(row['sessionId'] ?? ''),
      startedAt: asNumber(row['startedAt']),
      approvalStatus: asString(row['approvalStatus']),
    })),
    openTools: rows('openTools').map(row => ({
      sessionId: String(row['sessionId'] ?? ''),
      startedAt: asNumber(row['startedAt']),
      approvalStatus: asString(row['approvalStatus']),
    })),
    turns: rows('turns').map(row => ({
      sessionId: String(row['sessionId'] ?? ''),
      status: String(row['status'] ?? ''),
      startedAt: asNumber(row['startedAt']),
      completedAt: asNumber(row['completedAt']),
      errorType: asString(row['errorType']),
    })),
  };
}

/* ============================================================================
 * 适配器
 * ==========================================================================*/

export class ZCodeMonitor extends MonitorAdapter {
  private readonly cfg: ZCodeMonitorConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  /** 监控启动时刻（完成补亮的启动基线，start() 会刷新）。 */
  private startedAt = Date.now();
  private failureCount = 0;
  private reportedUnknown = false;

  constructor(ctx: MonitorContext, cfg: ZCodeMonitorConfig) {
    super(ctx);
    this.cfg = cfg;
  }

  override async start(): Promise<void> {
    if (this.isRunning || this.isDisposed) return;
    this.startedAt = Date.now();
    this.setRunning(true);
    await this.pollOnce();
    if (!this.isRunning || this.isDisposed) return;
    this.timer = setInterval(
      this.safeRun('zcode 轮询', () => {
        void this.pollOnce();
      }),
      Math.max(1_000, this.cfg.intervalMs ?? DEFAULT_INTERVAL_MS),
    );
  }

  override async stop(): Promise<void> {
    this.setRunning(false);
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.markDisposed();
  }

  /** 单轮：查库 -> 判定 -> 上报。防叠加，任何异常收敛成失败计数。 */
  async pollOnce(): Promise<void> {
    if (!this.isRunning || this.isDisposed) return;
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const probe = await this.queryDatabase();
      if (!this.isRunning || this.isDisposed) return;
      this.failureCount = 0;
      this.reportedUnknown = false;

      const now = Date.now();
      const verdict = deriveZcodeVerdict(probe, {
        projects: this.cfg.projects ?? [],
        activeWithinMs: this.cfg.activeWithinMs ?? DEFAULT_ACTIVE_WITHIN_MS,
        now,
        ackedAt: this.ctx.ackedCompletionAt?.() ?? 0,
        // 启动基线（SPEC-007 同口径）：重启后不重放启动前已存在的历史完成/失败。
        earliestCompletionAt: this.startedAt - COMPLETION_STARTUP_GRACE_MS,
      });
      if (verdict.status === 'success') {
        // 完成提醒带水位，store 用 ackedCompletionAt 闸门防复亮。
        this.emit({
          kind: 'status',
          status: 'success' as TaskStatus,
          message: verdict.message,
          completionAt: verdict.completionAt,
          at: now,
        });
      } else {
        this.emitStatus(verdict.status as TaskStatus, verdict.message);
      }
    } catch (err) {
      if (!this.isRunning || this.isDisposed) return;
      this.recordFailure(err instanceof Error ? err.message : String(err));
    } finally {
      this.inFlight = false;
    }
  }

  /** 累计失败；超过上限转 unknown（浮窗会隐藏该行）。未到上限时续心跳。 */
  private recordFailure(reason: string): void {
    this.failureCount += 1;
    const max = this.cfg.maxFailures ?? DEFAULT_MAX_FAILURES;
    if (this.failureCount >= max) {
      if (!this.reportedUnknown) {
        this.reportedUnknown = true;
        this.log.warn(`连续 ${this.failureCount} 次读取失败（${reason}），判定监控源失联`);
        this.emitStatus('unknown', `ZCode 会话库读取连续失败：${reason}`);
      }
      return;
    }
    this.log.warn(`ZCode 会话库读取失败第 ${this.failureCount} 次：${reason}`);
    this.emitHeartbeat();
  }

  /** 跑一次只读查询（子进程，同 sqlite 型：系统 node 才有 node:sqlite）。 */
  private queryDatabase(): Promise<ZcodeProbe> {
    const nodeBin = resolveSystemNode();
    const script = buildZcodeQueryScript(this.cfg.dbPath ?? defaultZcodeDbPath());
    return new Promise<ZcodeProbe>((resolve, reject) => {
      execFile(
        nodeBin,
        ['--no-warnings', '-e', script],
        { timeout: QUERY_TIMEOUT_MS, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err !== null) {
            const killed = (err as { killed?: boolean }).killed === true;
            if (killed) {
              reject(new Error(`查询超时（>${QUERY_TIMEOUT_MS}ms）`));
              return;
            }
            const code = (err as { code?: unknown }).code;
            if (code === 'ENOENT') {
              reject(new Error(`无法启动 ${nodeBin}：本监控需要系统安装 Node.js 22.5+（node:sqlite）`));
              return;
            }
            const first =
              String(stderr ?? '')
                .split(/\r?\n/u)
                .find((line: string) => line.trim().length > 0) ?? '(无 stderr)';
            reject(new Error(`查询失败：${first.slice(0, 200)}`));
            return;
          }
          try {
            resolve(parseProbe(String(stdout).trim()));
          } catch {
            reject(new Error(`查询输出不是合法 JSON：${String(stdout).slice(0, 120)}`));
          }
        },
      );
    });
  }
}
