/**
 * `sqlite` 型监控器 —— 用一个 SQLite 库里的**任务状态**驱动灯色。
 *
 * ============================================================================
 * 【为什么需要它】
 * ============================================================================
 * WorkBuddy 的 `process` 型监控只能说"进程活着"，于是只要应用开着就永远是蓝灯。
 * 但你真正要的语义是：
 *
 *   | 情形 | 灯 |
 *   |---|---|
 *   | 进程不在 | **隐藏**（浮窗只显示活着的） |
 *   | 进程在、没任务在跑 | **灰**（idle） |
 *   | 进程在、有任务在跑 | **蓝**（running） |
 *
 * 而 `workbuddy.db` 的 `sessions` 表恰好有权威信号：
 * `status`（`working` / `completed` …）+ `last_activity_at`。
 *
 * ============================================================================
 * 【★★ 关键：为什么必须同时看 status 和 last_activity_at】
 * ============================================================================
 * 实测该库里有 `status='working'` 但 `last_activity_at` **已静默 20 小时**
 * 的**遗留记录**（应用异常退出/会话被弃置时状态没回写）。
 * 只看 `status` 会**永远亮蓝** —— 那就回到"灯不反映真实状态"的老问题上了。
 * 所以判据是：`status = activeStatus` **且** 时间戳在 `activeWithinMs` 内。
 *
 * ============================================================================
 * 【为什么用子进程跑系统 node，而不是主进程直接读】
 * ============================================================================
 * 实测：Electron 33 内置 **Node 20.18**，而 `node:sqlite` 要 **Node 22.5+** ——
 * 主进程里 `require('node:sqlite')` 直接 `No such built-in module`。
 * 系统 `node.exe`（v24）能读，所以走「spawn 子进程 + 读 JSON」。
 *
 * 这与 `process` 型的做法一致：那里也是 spawn PowerShell 长驻枚举器。
 * 代价是引入"系统装了 Node"这个外部依赖 —— 未装时本监控优雅降级为失败
 * （由 `maxFailures` 转 unknown，也就是浮窗隐藏该行），而不是让应用崩。
 *
 * @module monitors/sqlite
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

import { MonitorAdapter, type MonitorContext } from './base';
import type { SqliteMonitorConfig } from '../../shared/types';

/** 单次读取失败连续多少次后判 `unknown`。 */
const DEFAULT_MAX_FAILURES = 3;
/** 视为"仍在活动"的静默窗口。 */
const DEFAULT_ACTIVE_WITHIN_MS = 120_000;

/**
 * 启动宽限期（SPEC-007/AC-04）：监控启动前这么久以内完成的，仍算"刚完成"要提醒。
 *
 * 与 store 的 `dismissAfterMs`（默认 10 分钟）对齐：已经展示过一轮完成就不再补亮，
 * 更早的历史完成一律不亮，避免重启后凭空亮一次绿。
 */
export const COMPLETION_STARTUP_GRACE_MS = 600_000;
/** 子进程单次查询超时。 */
const QUERY_TIMEOUT_MS = 15_000;

/* ============================================================================
 * 纯判定逻辑（不依赖 IO，可单测）
 * ==========================================================================*/

/** 从数据库读出的一行汇总。 */
export interface SqliteProbeRow {
  readonly freshWaitingCount?: number;
  readonly freshFailedCount?: number;
  /** `status` 等于 activeStatus 的会话数。 */
  readonly activeCount: number;
  /** 其中**最近活动时间**在窗口内的数量（最权威的那个数）。 */
  readonly freshActiveCount: number;
  /**
   * **最近一次完成的时刻**（明确 completedStatus 会话里最大的 `updated_at`），0 表示没有。
   *
   * 这是一个**单调递增的水位**：每次有会话真正跑完它都会变大。
   * 用它而不是"时间窗口内的完成数"，是为了支持「亮到点击才熄」：
   * 水位是稳定的事实，**该不该显示绿灯由 store 的确认水位决定**
   * （见 store 的 `ackedCompletionAt` 闸门），而不是让时间窗口把信号冲掉。
   *
   * 用 `updated_at` 而非 `last_activity_at`：实测完成时会额外刷一次
   * `updated_at`，它比 `last_activity_at` 晚（几百毫秒到几秒），
   * 更能代表"写完完成状态的那一刻"。
   */
  readonly lastDoneAt: number;
  /** 全部会话数（诊断用）。 */
  readonly totalCount: number;
  /** 最近一次活动的 epoch ms（诊断用，可为 0）。 */
  readonly lastActivityAt: number;
}

/** 判定结果：状态 + 给用户看的说明。 */
export interface SqliteVerdict {
  readonly status: 'running' | 'success' | 'idle' | 'waiting' | 'failed';
  readonly message: string;
  /**
   * 本次上报对应的**完成时刻**（仅 status==='success' 时有意义）。
   *
   * store 用它和"已确认水位"比较：若 `completionAt <= 已确认水位`，
   * 说明这个完成事件用户**已经点过了**，绿灯不该再亮 —— 于是丢弃。
   */
  readonly completionAt?: number;
}

/**
 * 由数据库汇总 + 进程闸门，判定该任务的状态。
 *
 * 规则就是产品语义本身，单独抽出来是为了能被测试穷举：
 *   - 进程闸门未通过        -> hidden（调用方转 unknown，浮窗隐藏该行）
 *   - 有新鲜的活跃会话      -> `running`（蓝）
 *   - 有**未确认的**完成    -> `success`（绿）★ 完成提醒，亮到点击
 *   - 其余                  -> `idle`（灰）
 *
 * ============================================================================
 * 【★ 完成提醒为什么需要"确认水位"】
 * ============================================================================
 * 用户要的形态是：**执行完亮绿灯保持不动，点击后跳转并熄灭**。
 *
 * 麻烦在于 sqlite 型是**轮询**的：点掉之后下一轮（默认 5s）又会从数据库
 * 读到"有会话完成了"，于是绿灯**立刻重新亮起** —— 点击等于没点。
 *
 * 解法是把"完成"当成一个**单调水位**而不是一个瞬时事件：
 *   - 监控每轮都报 `lastDoneAt`（最近一次完成是什么时候）
 *   - store 记住用户点掉时的水位 `ackedCompletionAt`
 *   - 只有当 `lastDoneAt > ackedCompletionAt` 时才认为有**新**完成要提醒
 *
 * 这样"同一个完成事件"只会亮一次，而**新任务完成会再次点亮**。
 *
 * @param row          数据库汇总
 * @param processAlive 进程闸门结果；`undefined` 表示未配置闸门
 * @param ackedAt      已确认水位（store 传入）；`undefined`/0 表示还没确认过
 */
export function deriveSqliteVerdict(
  row: SqliteProbeRow,
  processAlive: boolean | undefined,
  ackedAt: number | undefined = 0,
  /**
   * 启动基线（SPEC-007/AC-04）：早于它的完成不补亮绿灯。
   *
   * 确认水位不跨进程持久化，所以重启后 `ackedAt` 归零；若不设下限，
   * 库里几小时前的旧 `completed` 会立刻把灯点亮（用户现场："重启后它又自己亮了"）。
   * 调用方传 `启动时刻 - 宽限期`，于是"刚完成的"仍会提醒，陈旧的不会。
   */
  earliestCompletionAt = 0,
): SqliteVerdict & { hidden: boolean } {
  // ① 进程不在 -> 隐藏这一行（unknown 属于被隐藏的状态）
  if (processAlive === false) {
    return { status: 'idle', message: '进程不在', hidden: true };
  }

  if ((row.freshFailedCount ?? 0) > 0) {
    return { status: 'failed', message: `${row.freshFailedCount} 个任务失败`, hidden: false };
  }
  if ((row.freshWaitingCount ?? 0) > 0) {
    return { status: 'waiting', message: `${row.freshWaitingCount} 个任务等待处理`, hidden: false };
  }

  // ② 有**新鲜**的活跃会话 -> 真的在干活
  //
  // 注意顺序：running 优先于 success —— 若刚跑完一个又开始了新的，
  // 应该显示蓝（正在干活），而不是继续显示上一个的绿。
  if (row.freshActiveCount > 0) {
    return {
      status: 'running',
      message: `${row.freshActiveCount} 个任务在执行`,
      hidden: false,
    };
  }

  // ③ ★ 有**未确认**的完成 -> 绿（提醒，亮到点击）
  //    `earliestCompletionAt` = 启动基线：陈旧的历史完成不补亮（SPEC-007）。
  if (row.lastDoneAt > 0 && row.lastDoneAt > Math.max(ackedAt ?? 0, earliestCompletionAt)) {
    return {
      status: 'success',
      message: '任务已完成，点击查看',
      hidden: false,
      completionAt: row.lastDoneAt,
    };
  }

  // ④ 进程在但没有新鲜活跃会话 -> 空闲（灰）
  //
  // 这里刻意**区分两种情况**并写进 message：
  // 有陈旧的 working 记录 vs 完全没有 —— 后者是常态，前者值得你注意
  // （可能是应用上次异常退出留下的残留）。
  if (row.activeCount > 0) {
    return {
      status: 'idle',
      message: `进程在，${row.activeCount} 个会话状态陈旧（未在执行）`,
      hidden: false,
    };
  }

  return { status: 'idle', message: '进程在，当前没有任务在执行', hidden: false };
}

/* ============================================================================
 * 子进程查询
 * ==========================================================================*/

/**
 * 生成交给系统 node 执行的查询脚本。
 *
 * 用 `-e` 内联而不是写临时文件：少一次磁盘 IO，也避免留下垃圾文件。
 * 脚本只做一件事：算出四个计数，把结果打成一行 JSON。
 */
export function buildQueryScript(
  database: string,
  activeStatus: string,
  activeWithinMs: number,
  states: Pick<SqliteMonitorConfig, 'completedStatus' | 'waitingStatuses' | 'failedStatuses'> = {},
): string {
  // 路径与状态值都来自配置，用 JSON.stringify 安全地嵌进 JS 字面量
  return [
    "const { DatabaseSync } = require('node:sqlite');",
    `const dbPath = ${JSON.stringify(database)};`,
    `const activeStatus = ${JSON.stringify(activeStatus)};`,
    `const completedStatus = ${JSON.stringify(states.completedStatus ?? 'completed')};`,
    `const waitingStatuses = ${JSON.stringify(JSON.stringify(states.waitingStatuses ?? ['waiting', 'awaiting_approval', 'needs_input']))};`,
    `const failedStatuses = ${JSON.stringify(JSON.stringify(states.failedStatuses ?? ['failed', 'error']))};`,
    `const withinMs = ${Number(activeWithinMs)};`,
    'const db = new DatabaseSync(dbPath, { readOnly: true });',
    'const now = Date.now();',
    // SPEC-008：软删除的会话不参与判定。
    //   WorkBuddy 删除会话时会刷新 updated_at，而完成水位取的是 completed 的
    //   MAX(updated_at) —— 删一条旧会话会被误判成"刚完成一次"，凭空亮绿灯。
    //   老版本库可能没有该列，所以先查 schema 再决定是否加过滤（向后兼容）。
    "const cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);",
    "const liveFilter = cols.includes('deleted_at') ? ' WHERE (deleted_at IS NULL OR deleted_at <= 0)' : '';",
    // 一次扫描出全部计数，避免多次查库
    'const row = db.prepare(',
    "  'SELECT ' +",
    "    \"SUM(CASE WHEN lower(status) = lower(?) THEN 1 ELSE 0 END) AS activeCount, \" +",
    "    \"SUM(CASE WHEN lower(status) = lower(?) AND last_activity_at IS NOT NULL \" +",
    "    \"AND (? - last_activity_at) <= ? THEN 1 ELSE 0 END) AS freshActiveCount, \" +",
    // 仅明确 completed，不能把失败、取消、等待或未知枚举洗成绿灯。
    //   不设时间窗口 —— "该不该亮绿灯"由 store 的确认水位决定，
    //   时间窗口会把还等着用户点击的信号冲掉（那正是要修的行为）
    "    \"COALESCE(MAX(CASE WHEN lower(status) = lower(?) \" +",
    "    \"THEN updated_at END), 0) AS lastDoneAt, \" +",
    "    \"SUM(CASE WHEN lower(status) IN (SELECT lower(value) FROM json_each(?)) AND (? - updated_at) BETWEEN 0 AND ? THEN 1 ELSE 0 END) AS freshWaitingCount, \" +",
    "    \"SUM(CASE WHEN lower(status) IN (SELECT lower(value) FROM json_each(?)) AND (? - updated_at) BETWEEN 0 AND ? THEN 1 ELSE 0 END) AS freshFailedCount, \" +",
    "    'COUNT(*) AS totalCount, ' +",
    "    'MAX(last_activity_at) AS lastActivityAt ' +",
    "    'FROM sessions' + liveFilter",
    ').get(activeStatus, activeStatus, now, withinMs, completedStatus, waitingStatuses, now, withinMs, failedStatuses, now, withinMs);',
    'db.close();',
    'process.stdout.write(JSON.stringify({',
    '  activeCount: Number(row.activeCount || 0),',
    '  freshActiveCount: Number(row.freshActiveCount || 0),',
    '  freshWaitingCount: Number(row.freshWaitingCount || 0),',
    '  freshFailedCount: Number(row.freshFailedCount || 0),',
    '  lastDoneAt: Number(row.lastDoneAt || 0),',
    '  totalCount: Number(row.totalCount || 0),',
    '  lastActivityAt: Number(row.lastActivityAt || 0),',
    '}));',
  ].join('\n');
}

/** 定位系统 node 可执行文件。全都找不到时退回 `'node'`（交给 PATH 解析）。 */
export function resolveSystemNode(): string {
  // 依次尝试：显式环境变量 / 常见安装位置
  const candidates = [
    process.env['NODE_BINARY'],
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ].filter((c): c is string => typeof c === 'string' && c.length > 0);

  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      /* 继续找 */
    }
  }
  // 退而求其次：交给 PATH 解析（Windows 上 spawn/execFile 会补 .exe）
  return 'node';
}

/* ============================================================================
 * 适配器
 * ==========================================================================*/

export class SqliteMonitor extends MonitorAdapter {
  private readonly cfg: SqliteMonitorConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  /** 监控启动时刻（SPEC-007/AC-04 的启动基线，start() 会刷新）。 */
  private startedAt = Date.now();
  private failureCount = 0;
  private reportedUnknown = false;
  /** 最近一次闸门结果（undefined = 未配置闸门）。 */
  private processAlive: boolean | undefined;

  constructor(ctx: MonitorContext, cfg: SqliteMonitorConfig) {
    super(ctx);
    this.cfg = cfg;
  }

  override async start(): Promise<void> {
    if (this.isRunning || this.isDisposed) return;
    const interval = this.cfg.intervalMs ?? this.ctx.timeouts.startTimeoutMs ?? 5_000;
    // SPEC-007/AC-04：重启/重载后重建启动基线，陈旧完成不补亮
    this.startedAt = Date.now();
    this.setRunning(true);

    // 先跑一次，让灯尽快反映真实状态（而不是等一个周期）
    await this.safePoll();
    if (!this.isRunning || this.isDisposed) return;

    this.timer = setInterval(
      this.safeRun('sqlite 轮询', () => {
        void this.safePoll();
      }),
      Math.max(1_000, interval),
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

  /** 单轮：查库（+ 可选闸门）-> 判定 -> 上报。任何异常都收敛成失败计数。 */
  private async safePoll(): Promise<void> {
    if (!this.isRunning || this.isDisposed) return;
    // 防叠加：上一轮还没回来就跳过（查询可能比间隔慢）
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      // ① 进程闸门（配置了才查）
      if (this.cfg.requireProcess !== undefined && this.cfg.requireProcess.length > 0) {
        this.processAlive = await this.probeProcessAlive();
      }

      // ② 查库
      if (!this.isRunning || this.isDisposed) return;
      const row = await this.queryDatabase();
      if (!this.isRunning || this.isDisposed) return;
      this.failureCount = 0;
      this.reportedUnknown = false;

      // 已确认水位由 store 提供（它才是"用户点过没有"的真相所在）
      const ackedAt = this.ctx.ackedCompletionAt?.() ?? 0;
      // SPEC-007/AC-04：启动基线 = 监控启动时刻 - 宽限期。
      // 重启后 ackedAt 归零，没有这条下限就会为几小时前的旧完成亮绿灯。
      const earliestCompletion = this.startedAt - COMPLETION_STARTUP_GRACE_MS;
      const verdict = deriveSqliteVerdict(row, this.processAlive, ackedAt, earliestCompletion);
      // 关掉完成提醒时，把 success 降级成 idle（完成后直接回灰，不亮绿灯）
      const muted = this.cfg.notifyOnDone === false && verdict.status === 'success';
      if (verdict.hidden) {
        // 进程不在 -> unknown（浮窗按"只显示活着的"规则隐藏该行）
        this.emitStatus('unknown', verdict.message);
      } else if (verdict.status === 'success' && !muted) {
        // ★ 完成提醒：把完成水位一起报上去，store 用它做确认闸门
        this.emit({
          kind: 'status',
          status: 'success',
          message: verdict.message,
          completionAt: verdict.completionAt,
          at: Date.now(),
        });
      } else if (muted) {
        this.emitStatus('idle', '进程在，当前没有任务在执行');
      } else {
        this.emitStatus(verdict.status, verdict.message);
      }
    } catch (err) {
      if (!this.isRunning || this.isDisposed) return;
      this.recordFailure(err instanceof Error ? err.message : String(err));
    } finally {
      this.inFlight = false;
    }
  }

  /** 累计失败；超过上限转 unknown（浮窗会隐藏该行）。 */
  private recordFailure(reason: string): void {
    this.failureCount += 1;
    const max = this.cfg.maxFailures ?? DEFAULT_MAX_FAILURES;
    if (this.failureCount >= max) {
      if (!this.reportedUnknown) {
        this.reportedUnknown = true;
        this.log.warn(`连续 ${this.failureCount} 次读取失败（${reason}），判定监控源失联`);
        this.emitStatus('unknown', `数据库读取连续失败：${reason}`);
      }
      return;
    }
    this.log.warn(`数据库读取失败第 ${this.failureCount} 次：${reason}`);
    // 未到上限时续心跳，避免框架 stale_timeout 先把任务打成 unknown
    this.emitHeartbeat();
  }

  /**
   * 跑一次 SQLite 查询（子进程）。
   *
   * 用系统 `node.exe`：Electron 内置 Node 20 没有 `node:sqlite`（实测）。
   * 用 `execFile` 而不是 `spawn`：自带 timeout + 缓冲输出，
   * 且不必和 ChildProcess 的重载类型较劲（`spawn` 在 TS 里推成了 never）。
   */
  private queryDatabase(): Promise<SqliteProbeRow> {
    const nodeBin = resolveSystemNode();
    const script = buildQueryScript(
      this.cfg.database,
      this.cfg.activeStatus ?? 'working',
      this.cfg.activeWithinMs ?? DEFAULT_ACTIVE_WITHIN_MS,
      this.cfg,
    );

    return new Promise<SqliteProbeRow>((resolve, reject) => {
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
            // 找不到 node 会走这里（ENOENT）
            const code = (err as { code?: unknown }).code;
            if (code === 'ENOENT') {
              reject(
                new Error(`无法启动 ${nodeBin}：本监控需要系统安装 Node.js 22.5+（node:sqlite）`),
              );
              return;
            }
            const first =
              String(stderr ?? '')
                .split(/\r?\n/u)
                .find((l) => l.trim().length > 0) ?? '(无 stderr)';
            reject(new Error(`查询失败：${first.slice(0, 200)}`));
            return;
          }

          try {
            const parsed = JSON.parse(String(stdout).trim()) as Partial<SqliteProbeRow>;
            resolve({
              activeCount: Number(parsed.activeCount ?? 0),
              freshActiveCount: Number(parsed.freshActiveCount ?? 0),
              freshWaitingCount: Number(parsed.freshWaitingCount ?? 0),
              freshFailedCount: Number(parsed.freshFailedCount ?? 0),
              lastDoneAt: Number(parsed.lastDoneAt ?? 0),
              totalCount: Number(parsed.totalCount ?? 0),
              lastActivityAt: Number(parsed.lastActivityAt ?? 0),
            });
          } catch {
            reject(new Error(`查询输出不是合法 JSON：${String(stdout).slice(0, 120)}`));
          }
        },
      );
    });
  }

  /**
   * 进程闸门：系统里是否存在匹配 `requireProcess` 的进程。
   *
   * 复用 `process-enum` 的一次性 CIM 查询（而不是长驻枚举器）——
   * 闸门每次轮询（默认 5s）查一次足够，没必要为此常驻一个 PowerShell。
   */
  private async probeProcessAlive(): Promise<boolean> {
    const rules = this.cfg.requireProcess ?? [];
    if (rules.length === 0) return true;

    const { runCimOnce } = await import('./process-enum');
    return new Promise<boolean>((resolve, reject) => {
      // 无法枚举不等于进程存在；交给读取失败策略，不报告成功。
      runCimOnce(this.cfg.intervalMs ?? 5_000, (result, err) => {
        if (err !== null) {
          reject(new Error(`进程闸门查询失败：${err.message}`));
          return;
        }
        const alive = result.processes.some((p) => {
          const name = (p.name ?? '').toLowerCase();
          const cmd = (p.commandLine ?? '').toLowerCase();
          return rules.some((r) => {
            const nameOk = r.processNames.some((n) => n.toLowerCase() === name);
            if (!nameOk) return false;
            const wants = r.cmdlineContains ?? [];
            return wants.every((w) => cmd.includes(w.toLowerCase()));
          });
        });
        resolve(alive);
      });
    });
  }
}
