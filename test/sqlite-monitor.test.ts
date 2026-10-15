/**
 * `sqlite` 型监控器测试 —— 核心是**产品语义本身**。
 *
 * 要锁死的语义（用户定义）：
 *   | 情形 | 灯 |
 *   |---|---|
 *   | 进程不在 | **隐藏**（浮窗只显示活着的） |
 *   | 进程在、没任务在跑 | **灰**（idle） |
 *   | 进程在、有任务在跑 | **蓝**（running） |
 *
 * ★ 最关键的断言是"陈旧 working 不能判成 running" ——
 * 实测真库里有 `status='working'` 但 `last_activity_at` 已静默 20 小时的
 * **遗留记录**。只看 status 会永远亮蓝，那就等于灯不反映真实状态。
 */

import { describe, expect, it } from 'vitest';
import {
  buildQueryScript,
  deriveSqliteVerdict,
  resolveSystemNode,
  type SqliteProbeRow,
} from '../src/main/monitors/sqlite';
import { SqliteMonitor } from '../src/main/monitors/sqlite';
import { validateConfig } from '../src/main/config';
import type { SqliteMonitorConfig } from '../src/shared/types';

/** 造一个数据库汇总行。 */
const row = (over: Partial<SqliteProbeRow> = {}): SqliteProbeRow => ({
  activeCount: 0,
  freshActiveCount: 0,
  lastDoneAt: 0,
  totalCount: 10,
  lastActivityAt: 0,
  ...over,
});

describe('★ 三态语义（用户定义的核心行为）', () => {
  it('进程不在 -> 隐藏（unknown 由调用方上报）', () => {
    const v = deriveSqliteVerdict(row({ activeCount: 3, freshActiveCount: 3 }), false);
    expect(v.hidden).toBe(true);
    expect(v.message).toContain('进程不在');
  });

  it('★ 进程不在时**即使有新鲜活跃会话**也隐藏', () => {
    // 进程都没了，库里的 working 只能是残留 —— 不该让灯亮着
    const v = deriveSqliteVerdict(row({ activeCount: 1, freshActiveCount: 1 }), false);
    expect(v.hidden).toBe(true);
  });

  it('进程在 + 有新鲜活跃会话 -> 蓝（running）', () => {
    const v = deriveSqliteVerdict(row({ activeCount: 1, freshActiveCount: 1 }), true);
    expect(v.status).toBe('running');
    expect(v.hidden).toBe(false);
    expect(v.message).toContain('1 个任务在执行');
  });

  it('进程在 + 无活跃会话 -> 灰（idle）', () => {
    const v = deriveSqliteVerdict(row(), true);
    expect(v.status).toBe('idle');
    expect(v.hidden).toBe(false);
    expect(v.message).toContain('没有任务在执行');
  });
});

describe('★★ 陈旧 working 的坑（真库实测存在）', () => {
  it('★ 有 working 但无新鲜活动 -> idle，**不是 running**', () => {
    // 这就是真库的现状：activeCount=2, freshActiveCount=0
    const v = deriveSqliteVerdict(
      row({ activeCount: 2, freshActiveCount: 0, totalCount: 56 }),
      true,
    );
    expect(v.status).toBe('idle');
    expect(v.status).not.toBe('running');
  });

  it('★ 陈旧 case 的文案要说明"状态陈旧"，不能假装没这回事', () => {
    const v = deriveSqliteVerdict(row({ activeCount: 2, freshActiveCount: 0 }), true);
    expect(v.message).toContain('陈旧');
    expect(v.message).toContain('2');
  });

  it('不区分"陈旧"与"完全没有"会让诊断变难', () => {
    const stale = deriveSqliteVerdict(row({ activeCount: 2, freshActiveCount: 0 }), true);
    const none = deriveSqliteVerdict(row({ activeCount: 0 }), true);
    // 两者状态相同（都 idle），但文案必须不同
    expect(stale.status).toBe(none.status);
    expect(stale.message).not.toBe(none.message);
  });

  it('新鲜数 > 0 时优先判 running（陈旧数不干扰）', () => {
    const v = deriveSqliteVerdict(
      row({ activeCount: 5, freshActiveCount: 1, totalCount: 56 }),
      true,
    );
    expect(v.status).toBe('running');
    expect(v.message).toContain('1 个任务在执行');
  });
});

describe('★★ 完成提醒：亮到点击才熄（水位语义）', () => {
  const DONE = 1_700_000_000_000;

  it('★ 有未确认的完成 -> success（绿），不是 idle（灰）', () => {
    // 用户报的问题：任务一结束就从蓝直接跳灰，
    // 而灰色同时还表示"进程在但没事干" —— "刚做完"和"一直闲着"无法区分。
    const v = deriveSqliteVerdict(row({ lastDoneAt: DONE }), true);
    expect(v.status).toBe('success');
    expect(v.status).not.toBe('idle');
    expect(v.hidden).toBe(false);
    expect(v.message).toContain('点击');
  });

  it('★ success 必须带 completionAt（store 的确认闸门靠它）', () => {
    const v = deriveSqliteVerdict(row({ lastDoneAt: DONE }), true);
    expect(v.completionAt).toBe(DONE);
  });

  it('★ 已确认过这个完成（水位相同）-> 不再亮绿灯', () => {
    // 这就是"点击熄灭后不会立刻复亮"的核心：
    // 点掉时把水位记进 ackedCompletionAt，之后读到的同一个完成事件被忽略
    const v = deriveSqliteVerdict(row({ lastDoneAt: DONE }), true, DONE);
    expect(v.status).toBe('idle');
  });

  it('★ 已确认水位更高（更晚的完成已点过）-> 也不亮', () => {
    const v = deriveSqliteVerdict(row({ lastDoneAt: DONE }), true, DONE + 5000);
    expect(v.status).toBe('idle');
  });

  it('★ 有**更新的**完成 -> 再次亮绿灯（新任务完成要重新提醒）', () => {
    const v = deriveSqliteVerdict(row({ lastDoneAt: DONE + 60_000 }), true, DONE);
    expect(v.status).toBe('success');
    expect(v.completionAt).toBe(DONE + 60_000);
  });

  it('★ running 优先于 success（刚跑完又开新任务时应显示蓝）', () => {
    // 若 success 优先，则连续任务时灯会一直停在上一个的绿，看不出当前在干活
    const v = deriveSqliteVerdict(
      row({ freshActiveCount: 1, lastDoneAt: DONE }),
      true,
    );
    expect(v.status).toBe('running');
  });

  it('从未完成过（lastDoneAt=0）-> idle，不会凭 0 亮绿灯', () => {
    const v = deriveSqliteVerdict(row({ lastDoneAt: 0 }), true, 0);
    expect(v.status).toBe('idle');
  });

  it('进程不在时即使有未确认的完成也隐藏（进程没了就别显示）', () => {
    const v = deriveSqliteVerdict(row({ lastDoneAt: DONE }), false);
    expect(v.hidden).toBe(true);
  });
});

describe('未配置进程闸门时的行为', () => {
  it('processAlive=undefined（无闸门）+ 有新鲜活跃 -> running', () => {
    const v = deriveSqliteVerdict(row({ activeCount: 1, freshActiveCount: 1 }), undefined);
    expect(v.status).toBe('running');
  });

  it('processAlive=undefined + 无活跃 -> idle（不隐藏）', () => {
    const v = deriveSqliteVerdict(row(), undefined);
    expect(v.status).toBe('idle');
    expect(v.hidden).toBe(false);
  });
});

describe('buildQueryScript —— 生成的脚本必须安全且正确', () => {
  it('把 activeStatus 与窗口嵌进脚本', () => {
    const s = buildQueryScript('D:/x/y.db', 'working', 120_000);
    expect(s).toContain('"working"');
    expect(s).toContain('120000');
    expect(s).toContain('D:/x/y.db');
  });

  it('★ 用 JSON.stringify 转义，状态值里的引号不会破坏脚本', () => {
    // 若用字符串拼接而不是 JSON.stringify，这会造出语法错误甚至注入
    const s = buildQueryScript('D:/x/y.db', 'wo"rking', 1000);
    expect(s).toContain('"wo\\"rking"');
    // 生成的脚本必须是合法 JS —— 用 Function 解析一遍（不执行）
    expect(() => new Function(s)).not.toThrow();
  });

  it('★ 路径里的引号/反斜杠同样被安全转义', () => {
    const s = buildQueryScript('D:/we"ird\\path.db', 'working', 1000);
    expect(() => new Function(s)).not.toThrow();
  });

  it('查询大小写不敏感（真库里同时存在 terminated / Terminated）', () => {
    // 实测 sessions.status 既有 'terminated' 也有 'Terminated' ——
    // 该字段不受纪律，所以比较必须 lower() 归一化
    const s = buildQueryScript('D:/x/y.db', 'working', 1000);
    expect(s).toContain('lower(status)');
    expect(s).toContain('lower(?)');
  });

  it('同时算 activeCount 与 freshActiveCount（两条件缺一不可）', () => {
    const s = buildQueryScript('D:/x/y.db', 'working', 5000);
    expect(s).toContain('AS activeCount');
    expect(s).toContain('AS freshActiveCount');
    expect(s).toContain('last_activity_at');
  });

  it('★ 完成水位用 COALESCE(MAX(updated_at), 0) 且**不设时间窗口**', () => {
    // 不设窗口是刻意的：该不该亮绿灯由 store 的确认水位决定，
    // 时间窗口会把还等着用户点击的信号冲掉（那正是要修的行为）。
    const s = buildQueryScript('D:/x/y.db', 'working', 5000);
    expect(s).toContain('AS lastDoneAt');
    expect(s).toContain('MAX(CASE WHEN');
    expect(s).toContain('updated_at');
    // updated_at 只应出现在完成水位这一处，不该被 "now - updated_at <= x" 限制
    expect(s).not.toMatch(/updated_at\)\s*<=/u);
  });

  it('只读打开（绝不写用户的库）', () => {
    const s = buildQueryScript('D:/x/y.db', 'working', 1000);
    expect(s).toContain('readOnly: true');
  });
});

describe('resolveSystemNode', () => {
  it('返回非空可执行路径或退回 "node"', () => {
    const bin = resolveSystemNode();
    expect(typeof bin).toBe('string');
    expect(bin.length).toBeGreaterThan(0);
  });
});

describe('SqliteMonitor 生命周期', () => {
  const mkCtx = () => {
    const events: { status?: string; kind: string }[] = [];
    return {
      events,
      ctx: {
        task: {
          id: 't',
          name: 'T',
          enabled: true,
          monitor: { type: 'sqlite' as const, database: 'D:/nonexistent-zz.db' },
        },
        sink: (_id: string, ev: { kind: string; status?: string }) => {
          events.push({ kind: ev.kind, status: ev.status });
        },
        logger: {
          debug: () => undefined,
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
          logError: () => undefined,
        },
        rules: { waiting: [], running: [], success: [], failed: [] },
        timeouts: { startTimeoutMs: 5_000, staleTimeoutMs: 60_000, waitingTimeoutMs: 1_800_000 },
      },
    };
  };

  it('stop() 幂等（可重复调用）', async () => {
    const { ctx } = mkCtx();
    const cfg: SqliteMonitorConfig = { type: 'sqlite', database: 'D:/nonexistent-zz.db' };
    const m = new SqliteMonitor(ctx as never, cfg);
    await m.stop();
    await m.stop(); // 第二次不该抛
    expect(m.isDisposed).toBe(true);
  });

  it('★ 库不存在时不崩，且最终转 unknown（浮窗隐藏该行）', async () => {
    const { ctx, events } = mkCtx();
    const cfg: SqliteMonitorConfig = {
      type: 'sqlite',
      database: 'D:/zz-definitely-missing-lamp-test.db',
      maxFailures: 1,
      intervalMs: 100_000, // 只跑 start() 里那一次
    };
    const m = new SqliteMonitor(ctx as never, cfg);
    await m.start();
    // 等子进程返回
    await new Promise((r) => setTimeout(r, 3_000));
    await m.stop();

    const unknown = events.filter((e) => e.kind === 'status' && e.status === 'unknown');
    expect(unknown.length).toBeGreaterThan(0);
  }, 20_000);
});

describe('配置校验（sqlite 型）', () => {
  const base = { app: { hookPort: 17_890 }, tasks: [] as unknown[] };
  const task = (monitor: unknown) => ({
    id: 'w',
    name: 'W',
    enabled: true,
    monitor,
  });

  it('合法配置被接受', () => {
    const out = validateConfig({
      ...base,
      tasks: [
        task({
          type: 'sqlite',
          database: 'D:/your-appdata/.workbuddy/workbuddy.db',
          activeStatus: 'working',
          activeWithinMs: 60_000,
          requireProcess: [{ processNames: ['WorkBuddy.exe'] }],
        }),
      ],
    });
    expect(out.config.tasks).toHaveLength(1);
    const m = out.config.tasks[0]?.monitor as SqliteMonitorConfig;
    expect(m.type).toBe('sqlite');
    expect(m.activeStatus).toBe('working');
    expect(m.activeWithinMs).toBe(60_000);
    expect(m.requireProcess?.[0]?.processNames).toEqual(['WorkBuddy.exe']);
  });

  it('缺 database -> 丢弃该任务并告警', () => {
    const out = validateConfig({ ...base, tasks: [task({ type: 'sqlite' })] });
    expect(out.config.tasks).toHaveLength(0);
    expect(out.warnings.join(' ')).toContain('database');
  });

  it('database 不是 .db 文件 -> 丢弃该任务', () => {
    const out = validateConfig({
      ...base,
      tasks: [task({ type: 'sqlite', database: 'D:/x/notes.txt' })],
    });
    expect(out.config.tasks).toHaveLength(0);
    expect(out.warnings.join(' ')).toContain('SQLite');
  });

  it('可选字段非法只丢该字段，不影响任务', () => {
    const out = validateConfig({
      ...base,
      tasks: [
        task({
          type: 'sqlite',
          database: 'D:/x/y.db',
          activeWithinMs: -5, // 非法 -> 忽略
          intervalMs: 10, // 过小 -> 忽略
          maxFailures: 0, // 非法 -> 忽略
        }),
      ],
    });
    expect(out.config.tasks).toHaveLength(1);
    const m = out.config.tasks[0]?.monitor as SqliteMonitorConfig;
    expect(m.activeWithinMs).toBeUndefined();
    expect(m.intervalMs).toBeUndefined();
    expect(m.maxFailures).toBeUndefined();
  });

  it('requireProcess 规则形状非法 -> 忽略闸门但仍保留任务', () => {
    const out = validateConfig({
      ...base,
      tasks: [
        task({
          type: 'sqlite',
          database: 'D:/x/y.db',
          requireProcess: [{ cmdlineContains: ['x'] }], // 缺 processNames
        }),
      ],
    });
    expect(out.config.tasks).toHaveLength(1);
    const m = out.config.tasks[0]?.monitor as SqliteMonitorConfig;
    expect(m.requireProcess).toBeUndefined();
    expect(out.warnings.join(' ')).toContain('processNames');
  });
});
