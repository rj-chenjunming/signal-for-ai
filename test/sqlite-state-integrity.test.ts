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
