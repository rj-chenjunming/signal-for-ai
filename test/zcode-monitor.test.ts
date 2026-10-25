import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { ZCodeMonitor } from '../src/main/monitors/zcode';
import { MonitorHost } from '../src/main/monitors/host';
import { TaskStore } from '../src/main/store';
import { validateConfig } from '../src/main/config';
import { compileRules } from '../src/main/monitors/pattern';
import type { MonitorEvent } from '../src/main/monitors/base';
import type { TaskConfig, ZCodeMonitorConfig } from '../src/shared/types';

// vite 的解析器不把 node:sqlite 当内置模块：类型走 import type（编译期擦除），
// 值走 createRequire 运行时加载。
import type { DatabaseSync } from 'node:sqlite';
const nodeRequire = createRequire(`${process.cwd()}/`);
const { DatabaseSync: NodeDatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSync };

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), logError: vi.fn() };
let dir: string;
let now: number;
let seq: number;
let monitors: ZCodeMonitor[];

/** 建一个与真实 ZCode 会话库同构的夹具库（只建监控器查询会触碰的列）。 */
async function seedDb(seed: (db: DatabaseSync) => void, fileOverride?: string): Promise<string> {
  const file = fileOverride ?? join(dir, `db-${++seq}.sqlite`);
  const db = new NodeDatabaseSync(file);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, task_type TEXT, directory TEXT, path TEXT, time_updated INTEGER, time_deleted INTEGER, time_archived INTEGER, last_outcome TEXT);
    CREATE TABLE tool_usage (id TEXT PRIMARY KEY, session_id TEXT, status TEXT, approval_status TEXT, started_at INTEGER, completed_at INTEGER);
    CREATE TABLE model_usage (id TEXT PRIMARY KEY, session_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER);
    CREATE TABLE turn_usage (session_id TEXT, turn_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER, error_type TEXT, cancelled_by_user INTEGER);
    CREATE TABLE session_input (id TEXT PRIMARY KEY, session_id TEXT, kind TEXT, payload TEXT, time_created INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER);
  `);
  seed(db);
  db.close();
  return file;
}

const session = (
  db: DatabaseSync,
  id: string,
  o: { directory?: string; timeUpdated?: number; deleted?: boolean; taskType?: string; lastOutcome?: string } = {},
) =>
  db
    .prepare(
      'INSERT INTO session (id, task_type, directory, path, time_updated, time_deleted, time_archived, last_outcome) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
    )
    .run(id, o.taskType ?? 'interactive', o.directory ?? null, o.directory ?? null, o.timeUpdated ?? now, o.deleted ? now : null, o.lastOutcome ?? null);

const openTool = (db: DatabaseSync, sessionId: string, o: { startedAt?: number; approval?: string } = {}) =>
  db
    .prepare('INSERT INTO tool_usage (id, session_id, status, approval_status, started_at, completed_at) VALUES (?, ?, ?, ?, ?, NULL)')
    .run(`tu-${++seq}`, sessionId, 'running', o.approval ?? 'none', o.startedAt ?? now);

const openModel = (db: DatabaseSync, sessionId: string, o: { startedAt?: number } = {}) =>
  db
    .prepare('INSERT INTO model_usage (id, session_id, status, started_at, completed_at) VALUES (?, ?, ?, ?, NULL)')
    .run(`mu-${++seq}`, sessionId, 'running', o.startedAt ?? now);

const turn = (
  db: DatabaseSync,
  sessionId: string,
  o: { status: string; startedAt?: number; completedAt?: number; errorType?: string },
) =>
  db
    .prepare('INSERT INTO turn_usage (session_id, turn_id, status, started_at, completed_at, error_type, cancelled_by_user) VALUES (?, ?, ?, ?, ?, ?, 0)')
    .run(sessionId, `tn-${++seq}`, o.status, o.startedAt ?? (o.completedAt ?? now) - 1000, o.completedAt ?? now, o.errorType ?? null);

/** SPEC-043：提示词输入行（真实库在提交时刻即落库；payload 正文列不查询）。 */
const input = (db: DatabaseSync, sessionId: string, o: { timeCreated?: number; kind?: string } = {}) =>
  db
    .prepare('INSERT INTO session_input (id, session_id, kind, payload, time_created) VALUES (?, ?, ?, NULL, ?)')
    .run(`si-${++seq}`, sessionId, o.kind ?? 'sendText', o.timeCreated ?? now);

/** SPEC-043：part 行（流式输出期间持续落库；data 正文列不查询）。 */
const part = (db: DatabaseSync, sessionId: string, o: { timeCreated?: number } = {}) =>
  db
    .prepare('INSERT INTO part (id, session_id, data, time_created) VALUES (?, ?, NULL, ?)')
    .run(`pt-${++seq}`, sessionId, o.timeCreated ?? now);

function fixture(dbPath: string, overrides: Partial<ZCodeMonitorConfig> = {}) {
  const events: MonitorEvent[] = [];
  const task = (): TaskConfig => ({
    id: 'zcode',
    name: 'ZCode',
    enabled: true,
    monitor: { type: 'zcode', dbPath, activeWithinMs: 10000, intervalMs: 500, ...overrides },
  });
  const store = new TaskStore([task()]);
  const monitor = new ZCodeMonitor(
    {
      task: task(),
      logger,
      rules: compileRules([]),
      timeouts: { startTimeoutMs: 1000, staleTimeoutMs: 30000, waitingTimeoutMs: 30000 },
      ackedCompletionAt: () => store.getTask('zcode')?.ackedCompletionAt ?? 0,
      sink: (id, ev) => {
        events.push(ev);
        if (ev.kind === 'status') store.apply(id, { ...ev, isSignal: true });
      },
    },
    task().monitor as ZCodeMonitorConfig,
  );
  monitors.push(monitor);
  return { monitor, events, store, status: () => store.getTask('zcode')?.status };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lamp-zcode-'));
  monitors = [];
  now = Date.now();
  seq = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(async () => {
  for (const monitor of monitors) await monitor.stop();
});

describe('SPEC-041 ZCode 会话库状态判定', () => {
  it('开放模型请求（流式思考期）判 running', async () => {
    const file = await seedDb(db => {
      session(db, 's1', { directory: 'C:\\Work\\Alpha' });
      openModel(db, 's1');
    });
    const f = fixture(file);
    await f.monitor.start();
    expect(f.status()).toBe('running');
  });

  it('开放工具调用判 running', async () => {
    const file = await seedDb(db => {
      session(db, 's1', { directory: 'C:\\Work\\Alpha' });
      openTool(db, 's1');
    });
    const f = fixture(file);
    await f.monitor.start();
    expect(f.status()).toBe('running');
  });

  it('等待授权的工具判 waiting，且优先于 running', async () => {
    const file = await seedDb(db => {
      session(db, 's1', { directory: 'C:\\Work\\Alpha' });
      openTool(db, 's1', { approval: 'pending' });
      openModel(db, 's1');
    });
    const f = fixture(file);
    await f.monitor.start();
    expect(f.status()).toBe('waiting');
  });

  it('回合完成判 success 并带完成水位；确认后同一完成不复亮', async () => {
    const file = await seedDb(db => {
      session(db, 's1', { directory: 'C:\\Work\\Alpha', lastOutcome: 'completed' });
      turn(db, 's1', { status: 'completed', completedAt: now });
    });
    const f = fixture(file);
    await f.monitor.start();
    expect(f.status()).toBe('success');
    expect(f.store.getTask('zcode')).toMatchObject({ unread: true, lastCompletionAt: now });
    f.store.markRead('zcode');
    await f.monitor.pollOnce();
    expect(f.status()).toBe('idle');
  });

  it('回合错误判 failed', async () => {
    const file = await seedDb(db => {
      session(db, 's1', { directory: 'C:\\Work\\Alpha', lastOutcome: 'error' });
      turn(db, 's1', { status: 'error', completedAt: now, errorType: 'unknown_error' });
    });
    const f = fixture(file);
    await f.monitor.start();
    expect(f.status()).toBe('failed');
  });

  it('cancelled 回合视为 idle（用户主动中止，同 Codex turn_aborted 口径）', async () => {
    const file = await seedDb(db => {
      session(db, 's1', { directory: 'C:\\Work\\Alpha' });
      turn(db, 's1', { status: 'cancelled', completedAt: now });
    });
    const f = fixture(file);
    await f.monitor.start();
    expect(f.status()).toBe('idle');
  });

  it('活跃会话但无开放行也无新收尾回合时判 idle', async () => {
    const file = await seedDb(db => {
      session(db, 's1', { directory: 'C:\\Work\\Alpha', timeUpdated: now });
    });
    const f = fixture(file);
    await f.monitor.start();
    expect(f.status()).toBe('idle');
  });

  it('SPEC-043/AC-01: 提示词已提交且回合未收尾判 running（流式思考期）', async () => {
    const file = await seedDb(db => {
      session(db, 's1', { directory: 'C:\\Work\\Alpha' });
      turn(db, 's1', { status: 'completed', completedAt: now - 120000 });
      input(db, 's1', { timeCreated: now - 30000 });
      part(db, 's1', { timeCreated: now - 1000 });
    });
    const f = fixture(file);
    await f.monitor.start();
    expect(f.status()).toBe('running');
  });

  it('SPEC-043/AC-02: 回合收尾行晚于最后输入不再判 running（绿灯不被顶成蓝）', async () => {
    const file = await seedDb(db => {
      session(db, 's1', { directory: 'C:\\Work\\Alpha', lastOutcome: 'completed' });
      input(db, 's1', { timeCreated: now - 60000 });
      part(db, 's1', { timeCreated: now - 1000 });
      turn(db, 's1', { status: 'completed', completedAt: now });
    });
    const f = fixture(file);
    await f.monitor.start();
    expect(f.status()).toBe('success');
  });

  it('SPEC-043/AC-03: 输入未收尾但活动超出新鲜窗判 idle（崩溃残留保护）', async () => {
    const file = await seedDb(db => {
      session(db, 's1', { directory: 'C:\\Work\\Alpha' });
      turn(db, 's1', { status: 'completed', completedAt: now - 1800000 });
      input(db, 's1', { timeCreated: now - 1200000 });
      part(db, 's1', { timeCreated: now - 1200000 });
    });
    const f = fixture(file);
    await f.monitor.start();
    expect(f.status()).toBe('idle');
  });

  it('开放行超出新鲜窗后不判 running（防崩溃残留永久亮蓝）', async () => {
    const file = await seedDb(db => {
      session(db, 's1', { directory: 'C:\\Work\\Alpha', timeUpdated: now - 20000 });
      openTool(db, 's1', { startedAt: now - 20000 });
    });
    const f = fixture(file);
    await f.monitor.start();
    expect(f.status()).toBe('idle');
  });

  it('未来时间戳的开放行不判 running（时钟偏移保护）', async () => {
    const file = await seedDb(db => {
      session(db, 's1', { directory: 'C:\\Work\\Alpha' });
      openTool(db, 's1', { startedAt: now + 600000 });
    });
    const f = fixture(file);
    await f.monitor.start();
    expect(f.status()).toBe('idle');
  });

  it('projects 过滤按归一化目录匹配；留空聚合全部项目', async () => {
    const file = await seedDb(db => {
      session(db, 's1', { directory: 'C:\\Work\\Alpha' });
      session(db, 's2', { directory: 'C:\\Work\\Beta' });
      openTool(db, 's2');
    });
    const filtered = fixture(file, { projects: ['c:/work/alpha'] });
    await filtered.monitor.start();
    expect(filtered.status()).toBe('idle');
    await filtered.monitor.stop();

    const all = fixture(file);
    await all.monitor.start();
    expect(all.status()).toBe('running');
  });

  it('子代理会话计入所属项目（task_type=subagent_child）', async () => {
    const file = await seedDb(db => {
      session(db, 'child', { directory: 'C:\\Work\\Alpha', taskType: 'subagent_child' });
      openTool(db, 'child');
    });
    const f = fixture(file);
    await f.monitor.start();
    expect(f.status()).toBe('running');
  });

  it('软删除/归档会话不参与判定', async () => {
    const file = await seedDb(db => {
      session(db, 'gone', { directory: 'C:\\Work\\Alpha', deleted: true });
      openTool(db, 'gone');
      session(db, 'live', { directory: 'C:\\Work\\Alpha' });
    });
    const f = fixture(file);
    await f.monitor.start();
    expect(f.status()).toBe('idle');
  });

  it('等待授权不受新鲜窗约束（用户可以离开很久），但取消/超时交给状态机', async () => {
    const file = await seedDb(db => {
      session(db, 's1', { directory: 'C:\\Work\\Alpha', timeUpdated: now - 3600_000 });
      openTool(db, 's1', { startedAt: now - 3600_000, approval: 'pending' });
    });
    const f = fixture(file);
    await f.monitor.start();
    expect(f.status()).toBe('waiting');
  });

  it('数据库缺失时连续失败转 unknown，恢复可读后回到真实状态', async () => {
    const late = join(dir, 'late.sqlite');
    const f = fixture(late, { maxFailures: 2 });
    await f.monitor.start();
    await f.monitor.pollOnce();
    expect(f.status()).toBe('unknown');

    await seedDb(db => {
      session(db, 's1', { directory: 'C:\\Work\\Alpha' });
      openModel(db, 's1');
    }, late);
    await f.monitor.pollOnce();
    expect(f.status()).toBe('running');
  });

  it('启动前陈旧完成不补亮，启动宽限期内的完成仍提醒（SPEC-007 同口径）', async () => {
    const file = await seedDb(db => {
      session(db, 'old', { directory: 'C:\\Work\\Alpha', lastOutcome: 'completed' });
      turn(db, 'old', { status: 'completed', completedAt: now - 1800_000 });
    });
    const f = fixture(file);
    await f.monitor.start();
    expect(f.status()).toBe('idle');
    expect(f.events.some(e => e.kind === 'status' && e.status === 'success')).toBe(false);
    await f.monitor.stop();

    now += 1000;
    const file2 = await seedDb(db => {
      session(db, 'fresh', { directory: 'C:\\Work\\Alpha', lastOutcome: 'completed' });
      turn(db, 'fresh', { status: 'completed', completedAt: now });
    });
    const f2 = fixture(file2);
    await f2.monitor.start();
    expect(f2.status()).toBe('success');
  });

  it('多会话聚合取优先级最高态；success 水位取最新完成', async () => {
    const file = await seedDb(db => {
      session(db, 'done', { directory: 'C:\\Work\\Alpha', lastOutcome: 'completed' });
      turn(db, 'done', { status: 'completed', completedAt: now - 5000 });
      session(db, 'busy', { directory: 'C:\\Work\\Alpha' });
      openTool(db, 'busy');
    });
    const f = fixture(file);
    await f.monitor.start();
    expect(f.status()).toBe('running');
    await f.monitor.stop();

    now += 1000;
    const file2 = await seedDb(db => {
      session(db, 'a', { directory: 'C:\\Work\\Alpha', lastOutcome: 'completed' });
      turn(db, 'a', { status: 'completed', completedAt: now - 5000 });
      session(db, 'b', { directory: 'C:\\Work\\Alpha', lastOutcome: 'completed' });
      turn(db, 'b', { status: 'completed', completedAt: now });
    });
    const f2 = fixture(file2);
    await f2.monitor.start();
    expect(f2.status()).toBe('success');
    expect(f2.store.getTask('zcode')?.lastCompletionAt).toBe(now);
  });
});

describe('SPEC-041 ZCode 宿主与闸门接线', () => {
  it('宿主创建 ZCode 监控并在暂停/恢复时清理', async () => {
    const file = await seedDb(db => {
      session(db, 's1', { directory: 'C:\\Work\\Alpha' });
      openModel(db, 's1');
    });
    const { config } = validateConfig({
      version: 1,
      tasks: [{ id: 'zcode', name: 'ZCode', enabled: true, monitor: { type: 'zcode', dbPath: file, intervalMs: 500, activeWithinMs: 10000 } }],
    });
    const store = new TaskStore(config.tasks);
    const host = new MonitorHost({ config, store, logger });
    try {
      await host.start();
      expect(host.activeCount).toBe(1);
      expect(store.getTask('zcode')?.status).toBe('running');
      await host.setPaused(true);
      expect(host.activeCount).toBe(0);
      await host.setPaused(false);
      expect(host.activeCount).toBe(1);
    } finally {
      await host.stopAll();
    }
  });
});
