/**
 * SPEC-027 / AC-01 ~ AC-10：目标收件箱导入逻辑。
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GoalsStore } from '../src/main/goals-store';
import { drainGoalInbox } from '../src/main/goals-inbox';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function setup(): {
  dir: string;
  inboxPath: string;
  failedPath: string;
  store: GoalsStore;
  goalId: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiti-goals-inbox-'));
  tempDirs.push(dir);
  let counter = 0;
  const store = new GoalsStore({
    filePath: path.join(dir, 'goals.json'),
    debounceMs: 0,
    now: () => 1761100000000,
    randomId: () => `id-${++counter}`,
  });
  store.addGoal('AI信号灯软件开发');
  store.addGoal('其他目标');
  const goalId = store
    .getView()
    .goals.find((goal) => goal.title === 'AI信号灯软件开发')!.id;
  return {
    dir,
    inboxPath: path.join(dir, 'goal-inbox.jsonl'),
    failedPath: path.join(dir, 'goal-inbox.jsonl.failed.jsonl'),
    store,
    goalId,
  };
}

function writeInbox(filePath: string, lines: Array<string | Record<string, unknown>>): void {
  const text = lines
    .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
    .join('\n');
  fs.writeFileSync(filePath, `${text}\n`, 'utf8');
}

describe('drainGoalInbox', () => {
  it('收件箱不存在时无操作', () => {
    const h = setup();
    expect(drainGoalInbox({ inboxPath: h.inboxPath, store: h.store })).toEqual({
      applied: 0,
      failed: 0,
    });
    expect(fs.existsSync(h.failedPath)).toBe(false);
  });

  it('按标题/ID 导入、按行顺序追加、清空收件箱', () => {
    const h = setup();
    writeInbox(h.inboxPath, [
      { goal: 'AI信号灯软件开发', kind: 'progress', text: '  第一条进展  ' },
      { goalId: h.goalId, kind: 'issue', text: '第二个问题' },
    ]);

    expect(drainGoalInbox({ inboxPath: h.inboxPath, store: h.store })).toEqual({
      applied: 2,
      failed: 0,
    });
    const entries = h.store.getView().goals.find((goal) => goal.id === h.goalId)!.entries;
    expect(entries).toHaveLength(2);
    expect(entries[0]!.text).toBe('第二个问题');
    expect(entries[0]!.kind).toBe('issue');
    expect(entries[1]!.text).toBe('第一条进展');
    expect(fs.existsSync(h.inboxPath)).toBe(false);
    expect(fs.existsSync(h.failedPath)).toBe(false);
  });

  it('非法行写入 failed 文件，合法行照常导入', () => {
    const h = setup();
    writeInbox(h.inboxPath, [
      '{ broken json',
      { goal: 'AI信号灯软件开发', text: '' },
      { goal: '不存在的目标', text: '找不到' },
      { goal: 'AI信号灯软件开发', kind: 'done', text: '手动完成' },
      { goal: 'AI信号灯软件开发', text: 'x'.repeat(501) },
      { goal: 'AI信号灯软件开发', text: '唯一合法的一条' },
    ]);

    const result = drainGoalInbox({ inboxPath: h.inboxPath, store: h.store });
    expect(result).toEqual({ applied: 1, failed: 5 });
    const entries = h.store.getView().goals.find((goal) => goal.id === h.goalId)!.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe('唯一合法的一条');

    expect(fs.existsSync(h.failedPath)).toBe(true);
    const failedLines = fs
      .readFileSync(h.failedPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { reason: string });
    expect(failedLines).toHaveLength(5);
    expect(failedLines.every((line) => typeof line.reason === 'string' && line.reason.length > 0)).toBe(true);
  });

  it('同名目标不猜测：标题写入失败，ID 仍可导入', () => {
    const h = setup();
    h.store.addGoal('同名目标');
    h.store.addGoal('同名目标');
    writeInbox(h.inboxPath, [
      { goal: '同名目标', text: '按标题无法确定' },
      { goalId: h.store.getView().goals.find((goal) => goal.title === '同名目标')!.id, text: '按 ID 可以' },
    ]);

    const result = drainGoalInbox({ inboxPath: h.inboxPath, store: h.store });
    expect(result).toEqual({ applied: 1, failed: 1 });
    expect(fs.readFileSync(h.failedPath, 'utf8')).toContain('同名');
  });

  it('遗留的 .processing-* 文件也会被导入并清理', () => {
    const h = setup();
    const stale = `${h.inboxPath}.processing-999`;
    writeInbox(stale, [{ goal: 'AI信号灯软件开发', text: '崩溃后遗留的进展' }]);

    expect(drainGoalInbox({ inboxPath: h.inboxPath, store: h.store }).applied).toBe(1);
    const entries = h.store.getView().goals.find((goal) => goal.id === h.goalId)!.entries;
    expect(entries[0]!.text).toBe('崩溃后遗留的进展');
    expect(fs.existsSync(stale)).toBe(false);
  });

  it('空行被忽略，kind 省略时默认 progress', () => {
    const h = setup();
    fs.writeFileSync(h.inboxPath, '\n\n' + JSON.stringify({ goal: 'AI信号灯软件开发', text: '默认进展' }) + '\n\n', 'utf8');
    expect(drainGoalInbox({ inboxPath: h.inboxPath, store: h.store })).toEqual({
      applied: 1,
      failed: 0,
    });
    expect(h.store.getView().goals.find((goal) => goal.id === h.goalId)!.entries[0]!.kind).toBe(
      'progress',
    );
  });
});
