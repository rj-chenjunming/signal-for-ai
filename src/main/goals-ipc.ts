/**
 * 目标清单 IPC 处理层（SPEC-024 / AC-03 ~ AC-09、AC-15 ~ AC-17）。
 *
 * 纯逻辑：不直接依赖 Electron。真正的对话框/文件写入通过 deps 注入，
 * 这样可以在 vitest 中验证参数校验、导出内容与取消/失败路径。
 */

import type {
  GoalExportResult,
  GoalsView,
  TaskActionResponse,
} from '../shared/types';
import type { GoalsStore } from './goals-store';
import { buildGoalsMarkdown } from './goals-export';

/** 导出动作需要宿主提供的副作用。 */
export interface GoalsExportDeps {
  /** 把 markdown 写入用户选择的位置；取消时返回 {ok:true,canceled:true}。 */
  exportMarkdown: (markdown: string, suggestedName: string) => Promise<GoalExportResult>;
  openGoals: () => void;
  hideGoals: () => void;
  /** 导出时间与文件名用的时钟；默认 Date.now。 */
  now?: () => number;
}

/** 生成的 IPC 处理器集合（index.ts 直接映射到通道）。 */
export interface GoalsHandlers {
  get: () => GoalsView;
  add: (request: unknown) => TaskActionResponse;
  remove: (request: unknown) => TaskActionResponse;
  updateTitle: (request: unknown) => TaskActionResponse;
  setProgress: (request: unknown) => TaskActionResponse;
  complete: (request: unknown) => TaskActionResponse;
  addEntry: (request: unknown) => TaskActionResponse;
  deleteEntry: (request: unknown) => TaskActionResponse;
  move: (request: unknown) => TaskActionResponse;
  export: () => Promise<GoalExportResult>;
  hide: () => void;
  open: () => TaskActionResponse;
}

const INVALID = '请求参数无效';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(request: unknown, key: string): string | null {
  if (!isRecord(request)) {
    return null;
  }
  const value = request[key];
  return typeof value === 'string' ? value : null;
}

function numberField(request: unknown, key: string): number | null {
  if (!isRecord(request)) {
    return null;
  }
  const value = request[key];
  return typeof value === 'number' ? value : null;
}

export function createGoalsHandlers(
  store: GoalsStore,
  deps: GoalsExportDeps,
): GoalsHandlers {
  const now = deps.now ?? Date.now;

  return {
    get: () => store.getView(),

    add: (request) => {
      const title = stringField(request, 'title');
      if (title === null) {
        return invalidRequest();
      }
      return store.addGoal(title);
    },

    remove: (request) => {
      const id = stringField(request, 'id');
      if (id === null) {
        return invalidRequest();
      }
      return store.deleteGoal(id);
    },

    updateTitle: (request) => {
      const id = stringField(request, 'id');
      const title = stringField(request, 'title');
      if (id === null || title === null) {
        return invalidRequest();
      }
      return store.updateTitle(id, title);
    },

    setProgress: (request) => {
      const id = stringField(request, 'id');
      const progress = numberField(request, 'progress');
      if (id === null || progress === null) {
        return invalidRequest();
      }
      return store.setProgress(id, progress);
    },

    complete: (request) => {
      const id = stringField(request, 'id');
      if (id === null) {
        return invalidRequest();
      }
      return store.complete(id);
    },

    addEntry: (request) => {
      const goalId = stringField(request, 'goalId');
      const kind = stringField(request, 'kind');
      const text = stringField(request, 'text');
      if (goalId === null || text === null) {
        return invalidRequest();
      }
      // 完成记录只能由 complete() 自动追加，渲染层不得手动创建。
      if (kind !== 'progress' && kind !== 'issue') {
        return invalidRequest();
      }
      return store.addEntry(goalId, kind, text);
    },

    deleteEntry: (request) => {
      const goalId = stringField(request, 'goalId');
      const entryId = stringField(request, 'entryId');
      if (goalId === null || entryId === null) {
        return invalidRequest();
      }
      return store.deleteEntry(goalId, entryId);
    },

    move: (request) => {
      if (!isRecord(request)) {
        return invalidRequest();
      }
      const id = stringField(request, 'id');
      if (id === null) {
        return invalidRequest();
      }
      const beforeId = request['beforeId'];
      if (beforeId !== null && typeof beforeId !== 'string') {
        return invalidRequest();
      }
      return store.moveGoal(id, beforeId);
    },

    export: async () => {
      const view = store.getView();
      const at = now();
      const markdown = buildGoalsMarkdown(view, at);
      return deps.exportMarkdown(markdown, goalsExportFileName(at));
    },

    hide: () => {
      deps.hideGoals();
    },

    open: () => {
      deps.openGoals();
      return { ok: true };
    },
  };
}

/** 导出建议文件名：goals-YYYY-MM-DD.md（本地时区）。 */
export function goalsExportFileName(at: number): string {
  const date = new Date(at);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `goals-${y}-${m}-${d}.md`;
}

/** 校验失败时的统一形状。 */
export function invalidRequest(): TaskActionResponse {
  return { ok: false, message: INVALID };
}
