import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildQueryScript, deriveSqliteVerdict, type SqliteProbeRow } from '../src/main/monitors/sqlite';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'indicator-sqlite-state-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function query(status: string): SqliteProbeRow {
  const database = join(dir, 'sessions.db');
  const seed = `const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(${JSON.stringify(database)}); db.exec('CREATE TABLE sessions(status TEXT,last_activity_at INTEGER,updated_at INTEGER)'); db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(${JSON.stringify(status)},Date.now(),Date.now()); db.close();`;
  execFileSync(process.execPath, ['--no-warnings', '-e', seed]);
  return JSON.parse(execFileSync(process.execPath, ['--no-warnings', '-e', buildQueryScript(database, 'working', 120000)], { encoding: 'utf8' })) as SqliteProbeRow;
}

describe('SPEC-002/AC-04 WorkBuddy 真实 SQLite 状态语义', () => {
  it.each(['failed', 'aborted', 'waiting', 'unknown'])('%s 不是成功完成', (status) => {
    const row = query(status);
    expect(row.lastDoneAt).toBe(0);
    expect(deriveSqliteVerdict(row, true).status).not.toBe('success');
  });
  it.each(['failed', 'waiting'] as const)('新鲜 %s 有明确状态，不假装空闲', (status) => {
    expect(deriveSqliteVerdict(query(status), true).status).toBe(status);
  });
  it('明确 completed 才产生完成水位', () => {
    const row = query('completed');
    expect(row.lastDoneAt).toBeGreaterThan(0);
    expect(deriveSqliteVerdict(row, true).status).toBe('success');
  });
  it('新鲜 working 仍为 running', () => {
    expect(deriveSqliteVerdict(query('working'), true).status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// SPEC-007/AC-04：重启后不为「几小时前的旧完成」亮绿灯
// ---------------------------------------------------------------------------
// 现场同一句话的后半截：重启指示灯时，库里最新的 completed 是 6.3 小时前的，
// 确认水位随进程重启清零 -> 立刻亮一次绿。灯是实时指示器，不该为陈旧完成亮。
describe('SPEC-007/AC-04 启动基线：陈旧完成不补亮绿灯', () => {
  const rowWithDone = (lastDoneAt: number): SqliteProbeRow => ({
    activeCount: 0,
    freshActiveCount: 0,
    freshWaitingCount: 0,
    freshFailedCount: 0,
    lastDoneAt,
    totalCount: 1,
    lastActivityAt: lastDoneAt,
  });

  it('完成早于启动基线（默认 10 分钟宽限）-> idle', () => {
    const now = Date.now();
    const earliest = now - 600_000;
    expect(deriveSqliteVerdict(rowWithDone(now - 6 * 3_600_000), true, 0, earliest).status).toBe('idle');
  });

  it('刚完成的（在宽限内）-> success', () => {
    const now = Date.now();
    const earliest = now - 600_000;
    expect(deriveSqliteVerdict(rowWithDone(now - 60_000), true, 0, earliest).status).toBe('success');
  });

  it('已确认水位更高时仍以已确认为准', () => {
    const now = Date.now();
    expect(deriveSqliteVerdict(rowWithDone(now - 60_000), true, now, now - 600_000).status).toBe('idle');
  });

  it('不传启动基线时保持既有语义（向后兼容）', () => {
    const now = Date.now();
    expect(deriveSqliteVerdict(rowWithDone(now - 6 * 3_600_000), true, 0).status).toBe('success');
  });
});
// ---------------------------------------------------------------------------
// SPEC-008：软删除的会话不算完成（WorkBuddy 清理会话会 bump updated_at）
// ---------------------------------------------------------------------------
// 现场：库里有 9 条 deleted_at 为正数的会话，WorkBuddy 删除它们时会刷新
// updated_at，而我们的 lastDoneAt 取的是「所有 completed 的 MAX(updated_at)」
// —— 删一个会话就等于"完成了一次"，灯凭空亮绿。
describe('SPEC-008 软删除会话不参与状态判定', () => {
  const seedAndQuery = (rows: readonly {
    status: string;
    deleted?: number | null;
    withDeletedColumn?: boolean;
  }[]): SqliteProbeRow => {
    const database = join(dir, 'sessions.db');
    const withColumn = rows.some((r) => r.withDeletedColumn !== false);
    const create = withColumn
      ? "CREATE TABLE sessions(status TEXT,last_activity_at INTEGER,updated_at INTEGER,deleted_at INTEGER)"
      : "CREATE TABLE sessions(status TEXT,last_activity_at INTEGER,updated_at INTEGER)";
    const insert = withColumn
      ? "INSERT INTO sessions VALUES(?,?,?,?)"
      : "INSERT INTO sessions VALUES(?,?,?)";
    const seed = [
      "const {DatabaseSync}=require('node:sqlite');",
      `const db=new DatabaseSync(${JSON.stringify(database)});`,
      `db.exec('${create}');`,
      `const ins=db.prepare('${insert}');`,
      ...rows.map((r) =>
        withColumn
          ? `ins.run(${JSON.stringify(r.status)},Date.now(),Date.now(),${r.deleted === undefined ? 'null' : String(r.deleted)});`
          : `ins.run(${JSON.stringify(r.status)},Date.now(),Date.now());`,
      ),
      'db.close();',
    ].join('');
    execFileSync(process.execPath, ['--no-warnings', '-e', seed]);
    return JSON.parse(
      execFileSync(process.execPath, ['--no-warnings', '-e', buildQueryScript(database, 'working', 120000)], {
        encoding: 'utf8',
      }),
    ) as SqliteProbeRow;
  };

  it('只有软删除的 completed -> 不产生完成水位（不亮绿灯）', () => {
    const row = seedAndQuery([{ status: 'completed', deleted: Date.now() }]);
    expect(row.lastDoneAt).toBe(0);
    expect(deriveSqliteVerdict(row, true).status).toBe('idle');
  });

  it('未删除 + 软删除混合 -> 水位只取未删除那条', () => {
    const row = seedAndQuery([
      { status: 'completed', deleted: Date.now() },
      { status: 'completed', deleted: null },
    ]);
    expect(row.lastDoneAt).toBeGreaterThan(0);
    expect(deriveSqliteVerdict(row, true).status).toBe('success');
  });

  it('deleted_at = -1 视为未删除（WorkBuddy 的 sentinel）', () => {
    const row = seedAndQuery([{ status: 'completed', deleted: -1 }]);
    expect(row.lastDoneAt).toBeGreaterThan(0);
  });

  it('老版本库没有 deleted_at 列时仍能查询（向后兼容）', () => {
    const row = seedAndQuery([{ status: 'completed', withDeletedColumn: false }]);
    expect(row.lastDoneAt).toBeGreaterThan(0);
    expect(deriveSqliteVerdict(row, true).status).toBe('success');
  });
});