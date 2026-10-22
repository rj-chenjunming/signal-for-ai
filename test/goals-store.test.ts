/**
 * SPEC-024 / AC-03 ~ AC-14、AC-20：目标数据仓库的行为测试。
 *
 * 这些用例先于实现编写；在骨架实现上会因目标行为缺失而失败（Red），
 * 实现后应全部通过（Green）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  GOAL_ENTRIES_MAX,
  GOAL_ENTRY_TEXT_MAX,
  GOAL_TITLE_MAX,
  GOALS_MAX,
  GoalsStore,
  formatGoalTime,
} from '../src/main/goals-store';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiti-goals-'));
  tempDirs.push(dir);
  return dir;
}

interface Harness {
  store: GoalsStore;
  filePath: string;
  dir: string;
  setClock: (value: number) => void;
  advance: (ms: number) => void;
  clock: () => number;
}

function makeStore(
  overrides: Partial<{
    filePath: string;
    debounceMs: number;
    now: () => number;
  }> = {},
): Harness {
  const dir = tempDir();
  const filePath = overrides.filePath ?? path.join(dir, 'goals.json');
  let current = 1761100000000;
  let counter = 0;
  const store = new GoalsStore({
    filePath,
    debounceMs: overrides.debounceMs ?? 0,
    now: overrides.now ?? (() => current),
    randomId: () => `id-${++counter}`,
  });
  return {
    store,
    filePath,
    dir,
    setClock: (value) => {
      current = value;
    },
    advance: (ms) => {
      current += ms;
    },
    clock: () => current,
  };
}

function rawGoal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'g-raw',
    title: '原始目标',
    progress: 0,
    status: 'active',
    createdAt: 1761100000000,
    updatedAt: 1761100000000,
    entries: [],
    ...overrides,
  };
}

function writeFile(filePath: string, content: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    'utf8',
  );
}

function readJSON(filePath: string): { version: number; goals: Array<Record<string, unknown>> } {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
    version: number;
    goals: Array<Record<string, unknown>>;
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('GoalsStore 基本 CRUD', () => {
  it('新增目标会 trim 标题、写入默认值并立即持久化', () => {
    const h = makeStore();
    const result = h.store.addGoal('  把 AI 任务指示灯做出来  ');
    expect(result.ok).toBe(true);

    const goals = h.store.getView().goals;
    expect(goals).toHaveLength(1);
    expect(goals[0]!.title).toBe('把 AI 任务指示灯做出来');
    expect(goals[0]!.progress).toBe(0);
    expect(goals[0]!.status).toBe('active');
    expect(goals[0]!.createdAt).toBe(h.clock());
    expect(goals[0]!.entries).toEqual([]);

    const file = readJSON(h.filePath);
    expect(file.version).toBe(1);
    expect(file.goals).toHaveLength(1);
  });

  it('空标题、纯空白和超长标题被拒绝且不产生目标', () => {
    const h = makeStore();
    expect(h.store.addGoal('').ok).toBe(false);
    expect(h.store.addGoal('    ').ok).toBe(false);
    expect(h.store.addGoal('x'.repeat(GOAL_TITLE_MAX + 1)).ok).toBe(false);
    expect(h.store.getView().goals).toHaveLength(0);

    expect(h.store.addGoal('x'.repeat(GOAL_TITLE_MAX)).ok).toBe(true);
  });

  it('目标数量达到上限后拒绝新增', () => {
    const h = makeStore({ debounceMs: 100000 });
    for (let i = 0; i < GOALS_MAX; i += 1) {
      expect(h.store.addGoal(`目标 ${i}`).ok).toBe(true);
    }
    const rejected = h.store.addGoal('第 201 个目标');
    expect(rejected.ok).toBe(false);
    expect(h.store.getView().goals).toHaveLength(GOALS_MAX);
  });

  it('标题可修改，校验与目标存在性都生效', () => {
    const h = makeStore();
    h.store.addGoal('旧标题');
    const id = h.store.getView().goals[0]!.id;

    h.advance(1000);
    expect(h.store.updateTitle(id, ' 新标题 ').ok).toBe(true);
    expect(h.store.getView().goals[0]!.title).toBe('新标题');
    expect(h.store.getView().goals[0]!.updatedAt).toBe(h.clock());

    expect(h.store.updateTitle(id, '   ').ok).toBe(false);
    expect(h.store.updateTitle('missing', '任意').ok).toBe(false);
  });

  it('进度只接受 0..100 的整数', () => {
    const h = makeStore();
    h.store.addGoal('进度目标');
    const id = h.store.getView().goals[0]!.id;

    expect(h.store.setProgress(id, 0).ok).toBe(true);
    expect(h.store.setProgress(id, 40).ok).toBe(true);
    expect(h.store.getView().goals[0]!.progress).toBe(40);
    expect(h.store.setProgress(id, 100).ok).toBe(true);

    for (const bad of [-1, 101, 1.5, Number.NaN]) {
      expect(h.store.setProgress(id, bad).ok).toBe(false);
    }
    expect(h.store.getView().goals[0]!.progress).toBe(100);
    expect(h.store.setProgress('missing', 10).ok).toBe(false);
  });

  it('删除目标会连同时间线一起删除', () => {
    const h = makeStore();
    h.store.addGoal('A');
    h.store.addGoal('B');
    // 新目标在顶部；按标题取 A，避免把「排序约定」写死进本用例。
    const id = h.store.getView().goals.find((goal) => goal.title === 'A')!.id;
    h.store.addEntry(id, 'progress', '一条记录');

    expect(h.store.deleteGoal(id).ok).toBe(true);
    expect(h.store.getView().goals).toHaveLength(1);
    expect(h.store.getView().goals[0]!.title).toBe('B');
    expect(h.store.deleteGoal(id).ok).toBe(false);
  });

  it('getView 返回深拷贝，外部修改不会污染仓库', () => {
    const h = makeStore();
    h.store.addGoal('原目标');
    const view = h.store.getView();
    view.goals[0]!.title = '被篡改';
    view.goals[0]!.entries.push({ id: 'x', at: 0, kind: 'progress', text: 'x' });

    const fresh = h.store.getView();
    expect(fresh.goals[0]!.title).toBe('原目标');
    expect(fresh.goals[0]!.entries).toHaveLength(0);
  });
});

describe('GoalsStore 时间线', () => {
  it('追加进展/问题记录，最新在前且内容被 trim', () => {
    const h = makeStore();
    h.store.addGoal('目标');
    const goalId = h.store.getView().goals[0]!.id;

    h.advance(1000);
    expect(h.store.addEntry(goalId, 'progress', '  调研完成  ').ok).toBe(true);
    h.advance(1000);
    expect(h.store.addEntry(goalId, 'issue', 'Windows 真机还欠一次').ok).toBe(true);

    const entries = h.store.getView().goals[0]!.entries;
    expect(entries).toHaveLength(2);
    expect(entries[0]!.kind).toBe('issue');
    expect(entries[0]!.at).toBe(h.clock());
    expect(entries[1]!.kind).toBe('progress');
    expect(entries[1]!.text).toBe('调研完成');
  });

  it('拒绝空内容、超长内容与手动创建完成记录', () => {
    const h = makeStore();
    h.store.addGoal('目标');
    const goalId = h.store.getView().goals[0]!.id;

    expect(h.store.addEntry(goalId, 'progress', '').ok).toBe(false);
    expect(h.store.addEntry(goalId, 'progress', '   ').ok).toBe(false);
    expect(
      h.store.addEntry(goalId, 'issue', 'x'.repeat(GOAL_ENTRY_TEXT_MAX + 1)).ok,
    ).toBe(false);
    expect(h.store.addEntry(goalId, 'done', '手动完成记录').ok).toBe(false);
    expect(h.store.addEntry('missing', 'progress', '记录').ok).toBe(false);
    expect(h.store.getView().goals[0]!.entries).toHaveLength(0);
  });

  it('单目标记录数量达到上限后拒绝追加', () => {
    const h = makeStore({ debounceMs: 100000 });
    h.store.addGoal('目标');
    const goalId = h.store.getView().goals[0]!.id;
    for (let i = 0; i < GOAL_ENTRIES_MAX; i += 1) {
      expect(h.store.addEntry(goalId, 'progress', `记录 ${i}`).ok).toBe(true);
    }
    expect(h.store.addEntry(goalId, 'progress', '超出上限').ok).toBe(false);
    expect(h.store.getView().goals[0]!.entries).toHaveLength(GOAL_ENTRIES_MAX);
  });

  it('可以删除单条记录，缺失 id 返回失败', () => {
    const h = makeStore();
    h.store.addGoal('目标');
    const goalId = h.store.getView().goals[0]!.id;
    h.store.addEntry(goalId, 'progress', '可删除');
    const entryId = h.store.getView().goals[0]!.entries[0]!.id;

    expect(h.store.deleteEntry(goalId, entryId).ok).toBe(true);
    expect(h.store.getView().goals[0]!.entries).toHaveLength(0);
    expect(h.store.deleteEntry(goalId, entryId).ok).toBe(false);
    expect(h.store.deleteEntry('missing', entryId).ok).toBe(false);
  });
});

describe('GoalsStore 完成', () => {
  it('标记完成会置 100%、记录完成时间并自动追加完成记录', () => {
    const h = makeStore();
    h.store.addGoal('要完成的目标');
    const goalId = h.store.getView().goals[0]!.id;
    h.advance(5000);

    expect(h.store.complete(goalId).ok).toBe(true);
    const goal = h.store.getView().goals[0]!;
    expect(goal.status).toBe('done');
    expect(goal.progress).toBe(100);
    expect(goal.completedAt).toBe(h.clock());
    expect(goal.entries[0]!.kind).toBe('done');
    expect(goal.entries[0]!.at).toBe(h.clock());

    expect(h.store.complete(goalId).ok).toBe(false);
  });
});

describe('GoalsStore 持久化与恢复', () => {
  it('flush 后重新打开可以恢复目标、进度、状态与记录', () => {
    const h = makeStore({ debounceMs: 100000 });
    h.store.addGoal('持久化目标');
    const goalId = h.store.getView().goals[0]!.id;
    h.store.setProgress(goalId, 40);
    h.store.addEntry(goalId, 'issue', '记得验收');
    h.store.flush();
    h.store.dispose();

    const reopened = new GoalsStore({ filePath: h.filePath, debounceMs: 0 });
    const goal = reopened.getView().goals[0]!;
    expect(goal.title).toBe('持久化目标');
    expect(goal.progress).toBe(40);
    expect(goal.entries).toHaveLength(1);
    expect(goal.entries[0]!.text).toBe('记得验收');
  });

  it('防抖期间不写盘，flush 立即落盘', async () => {
    const h = makeStore({ debounceMs: 60 });
    h.store.addGoal('稍后写盘');
    expect(fs.existsSync(h.filePath)).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fs.existsSync(h.filePath)).toBe(false);

    h.store.flush();
    expect(fs.existsSync(h.filePath)).toBe(true);
  });

  it('文件不存在时以空列表启动，首次新增后创建 version 1 文件', () => {
    const h = makeStore();
    expect(h.store.getView().goals).toHaveLength(0);
    expect(h.store.getView().warning).toBeUndefined();
    expect(fs.existsSync(h.filePath)).toBe(false);

    h.store.addGoal('第一个目标');
    const file = readJSON(h.filePath);
    expect(file.version).toBe(1);
    expect(file.goals).toHaveLength(1);
  });

  it('主文件损坏但备份有效时从备份恢复并隔离损坏文件', () => {
    const h = makeStore();
    h.store.addGoal('可恢复的目标');
    h.store.flush();
    const backupPath = `${h.filePath}.bak`;
    fs.copyFileSync(h.filePath, backupPath);
    writeFile(h.filePath, '{ broken json');

    const recovered = new GoalsStore({ filePath: h.filePath, debounceMs: 0 });
    const view = recovered.getView();
    expect(view.goals).toHaveLength(1);
    expect(view.goals[0]!.title).toBe('可恢复的目标');
    expect(view.warning).toContain('备份');

    const quarantine = fs
      .readdirSync(h.dir)
      .filter((name) => name.includes('.corrupt-'));
    expect(quarantine.length).toBeGreaterThanOrEqual(1);
  });

  it('主文件与备份都损坏时以空列表启动并保留隔离文件', () => {
    const h = makeStore();
    fs.mkdirSync(h.dir, { recursive: true });
    writeFile(h.filePath, '{ broken');
    writeFile(`${h.filePath}.bak`, 'not json either');

    const store = new GoalsStore({ filePath: h.filePath, debounceMs: 0 });
    expect(store.getView().goals).toHaveLength(0);
    expect(store.getView().warning).toBeTruthy();

    const quarantine = fs
      .readdirSync(h.dir)
      .filter((name) => name.includes('.corrupt-'));
    expect(quarantine.length).toBeGreaterThanOrEqual(1);
  });

  it('未知版本按损坏处理，不尝试解析', () => {
    const h = makeStore();
    writeFile(h.filePath, { version: 2, goals: [rawGoal()] });

    const store = new GoalsStore({ filePath: h.filePath, debounceMs: 0 });
    expect(store.getView().goals).toHaveLength(0);
    expect(store.getView().warning).toBeTruthy();
  });

  it('个别非法目标被丢弃，合法目标继续加载并给出告警', () => {
    const h = makeStore();
    writeFile(h.filePath, {
      version: 1,
      goals: [
        rawGoal({ id: 'ok', title: '合法目标' }),
        rawGoal({ id: 'bad-progress', progress: 140 }),
        rawGoal({ id: 'bad-status', status: 'paused' }),
      ],
    });

    const store = new GoalsStore({ filePath: h.filePath, debounceMs: 0 });
    expect(store.getView().goals).toHaveLength(1);
    expect(store.getView().goals[0]!.title).toBe('合法目标');
    expect(store.getView().warning).toBeTruthy();
  });

  it('保存失败时保留内存数据并给出告警', () => {
    const dir = tempDir();
    const blocker = path.join(dir, 'blocker-file');
    fs.writeFileSync(blocker, 'x', 'utf8');
    const filePath = path.join(blocker, 'goals.json');

    const store = new GoalsStore({ filePath, debounceMs: 0 });
    expect(store.addGoal('会保存失败的目标').ok).toBe(true);
    expect(store.getView().goals).toHaveLength(1);
    expect(store.getView().warning).toMatch(/保存|写入/);
  });
});

describe('formatGoalTime', () => {
  it('输出本地时区的 YYYY-MM-DD HH:mm', () => {
    const at = new Date(2026, 9, 22, 9, 5).getTime();
    expect(formatGoalTime(at)).toBe('2026-10-22 09:05');
  });
});
