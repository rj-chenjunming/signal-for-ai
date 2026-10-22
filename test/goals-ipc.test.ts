/**
 * SPEC-024 / AC-03 ~ AC-09、AC-15 ~ AC-17：目标 IPC 处理层的参数校验与导出路径。
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GoalsStore } from '../src/main/goals-store';
import { createGoalsHandlers } from '../src/main/goals-ipc';
import type { GoalExportResult } from '../src/shared/types';

const tempDirs: string[] = [];
const GENERATED_AT = new Date(2026, 9, 22, 11, 30).getTime();

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function setup(exportResult: GoalExportResult = { ok: true, path: 'C:/exports/goals.md' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiti-goals-ipc-'));
  tempDirs.push(dir);
  const store = new GoalsStore({
    filePath: path.join(dir, 'goals.json'),
    debounceMs: 0,
    now: () => GENERATED_AT,
    randomId: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
  });
  const exported: Array<{ markdown: string; suggestedName: string }> = [];
  let opened = 0;
  let hidden = 0;
  const handlers = createGoalsHandlers(store, {
    now: () => GENERATED_AT,
    exportMarkdown: async (markdown, suggestedName) => {
      exported.push({ markdown, suggestedName });
      return exportResult;
    },
    openGoals: () => {
      opened += 1;
    },
    hideGoals: () => {
      hidden += 1;
    },
  });
  return {
    store,
    handlers,
    exported,
    opened: () => opened,
    hidden: () => hidden,
  };
}

function firstGoalId(store: GoalsStore): string {
  return store.getView().goals[0]!.id;
}

describe('目标 IPC：参数校验', () => {
  it('add 接受合法标题并写入仓库', () => {
    const h = setup();
    expect(h.handlers.add({ title: '  把项目做出来  ' }).ok).toBe(true);
    expect(h.store.getView().goals[0]!.title).toBe('把项目做出来');
  });

  it('add 拒绝非对象、缺字段、非字符串标题', () => {
    const h = setup();
    for (const bad of [null, undefined, {}, { title: 1 }, { title: '' }, { title: '   ' }]) {
      expect(h.handlers.add(bad).ok).toBe(false);
    }
    expect(h.store.getView().goals).toHaveLength(0);
  });

  it('remove / updateTitle / setProgress / complete 校验字段类型', () => {
    const h = setup();
    h.handlers.add({ title: '目标' });
    const id = firstGoalId(h.store);

    expect(h.handlers.remove(null).ok).toBe(false);
    expect(h.handlers.remove({ id: 1 }).ok).toBe(false);
    expect(h.handlers.updateTitle({ id }).ok).toBe(false);
    expect(h.handlers.updateTitle({ id, title: 2 }).ok).toBe(false);
    expect(h.handlers.setProgress({ id, progress: '40' }).ok).toBe(false);
    expect(h.handlers.complete({}).ok).toBe(false);

    expect(h.handlers.updateTitle({ id, title: '新标题' }).ok).toBe(true);
    expect(h.handlers.setProgress({ id, progress: 40 }).ok).toBe(true);
    expect(h.handlers.complete({ id }).ok).toBe(true);
    expect(h.store.getView().goals[0]!.status).toBe('done');
  });

  it('addEntry 只接受进展/问题与合法文本', () => {
    const h = setup();
    h.handlers.add({ title: '目标' });
    const goalId = firstGoalId(h.store);

    expect(h.handlers.addEntry({ goalId, kind: 'done', text: '手动完成' }).ok).toBe(false);
    expect(h.handlers.addEntry({ goalId, kind: 'x', text: '内容' }).ok).toBe(false);
    expect(h.handlers.addEntry({ goalId, kind: 'progress', text: 1 }).ok).toBe(false);
    expect(h.handlers.addEntry({ goalId: 1, kind: 'progress', text: '内容' }).ok).toBe(false);

    expect(h.handlers.addEntry({ goalId, kind: 'progress', text: ' 第一条 ' }).ok).toBe(true);
    expect(h.store.getView().goals[0]!.entries[0]!.text).toBe('第一条');
  });

  it('deleteEntry 校验并删除指定记录', () => {
    const h = setup();
    h.handlers.add({ title: '目标' });
    const goalId = firstGoalId(h.store);
    h.handlers.addEntry({ goalId, kind: 'issue', text: '待办问题' });
    const entryId = h.store.getView().goals[0]!.entries[0]!.id;

    expect(h.handlers.deleteEntry({ goalId }).ok).toBe(false);
    expect(h.handlers.deleteEntry({ goalId, entryId: 1 }).ok).toBe(false);
    expect(h.handlers.deleteEntry({ goalId, entryId }).ok).toBe(true);
    expect(h.store.getView().goals[0]!.entries).toHaveLength(0);
  });
});

describe('目标 IPC：导出', () => {
  it('导出全部目标与记录，建议文件名为 goals-YYYY-MM-DD.md', async () => {
    const h = setup();
    h.handlers.add({ title: '把项目做出来' });
    const goalId = firstGoalId(h.store);
    h.handlers.addEntry({ goalId, kind: 'issue', text: '真机验收还欠一次' });

    const result = await h.handlers.export();
    expect(result).toEqual({ ok: true, path: 'C:/exports/goals.md' });
    expect(h.exported).toHaveLength(1);
    expect(h.exported[0]!.suggestedName).toBe('goals-2026-10-22.md');
    expect(h.exported[0]!.markdown).toContain('# 目标清单');
    expect(h.exported[0]!.markdown).toContain('把项目做出来');
    expect(h.exported[0]!.markdown).toContain('真机验收还欠一次');
  });

  it('空列表也会生成合法 Markdown', async () => {
    const h = setup();
    await h.handlers.export();
    expect(h.exported[0]!.markdown).toContain('暂无目标');
  });

  it('取消导出时把 deps 的结果原样返回，不影响数据', async () => {
    const h = setup({ ok: true, canceled: true });
    h.handlers.add({ title: '目标' });
    const result = await h.handlers.export();
    expect(result).toEqual({ ok: true, canceled: true });
    expect(h.store.getView().goals).toHaveLength(1);
  });

  it('写入失败时返回错误信息', async () => {
    const h = setup({ ok: false, message: '磁盘不可写' });
    const result = await h.handlers.export();
    expect(result.ok).toBe(false);
    expect(result.message).toBe('磁盘不可写');
  });
});

describe('目标 IPC：拖拽排序（SPEC-026）', () => {
  it('move 接受合法参数并更新顺序', () => {
    const h = setup();
    h.handlers.add({ title: 'A' });
    h.handlers.add({ title: 'B' });
    const byTitle = (title: string) =>
      h.store.getView().goals.find((goal) => goal.title === title)!.id;

    expect(h.handlers.move({ id: byTitle('A'), beforeId: byTitle('B') }).ok).toBe(true);
    expect(h.store.getView().goals.map((goal) => goal.title)).toEqual(['A', 'B']);
    expect(h.handlers.move({ id: byTitle('A'), beforeId: null }).ok).toBe(true);
    expect(h.store.getView().goals.map((goal) => goal.title)).toEqual(['B', 'A']);
  });

  it('move 校验字段类型与存在性', () => {
    const h = setup();
    h.handlers.add({ title: 'A' });
    const id = firstGoalId(h.store);

    expect(h.handlers.move(null).ok).toBe(false);
    expect(h.handlers.move({ id }).ok).toBe(false);
    expect(h.handlers.move({ id, beforeId: 1 }).ok).toBe(false);
    expect(h.handlers.move({ beforeId: id }).ok).toBe(false);
    expect(h.handlers.move({ id, beforeId: 'missing' }).ok).toBe(false);
    expect(h.store.getView().goals).toHaveLength(1);
  });
});

describe('目标 IPC：窗口入口', () => {
  it('open 调用打开回调，hide 调用隐藏回调', () => {
    const h = setup();
    expect(h.handlers.open().ok).toBe(true);
    expect(h.opened()).toBe(1);
    h.handlers.hide();
    expect(h.hidden()).toBe(1);
  });
});
