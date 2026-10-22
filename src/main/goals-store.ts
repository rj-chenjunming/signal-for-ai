/**
 * 目标清单数据仓库（SPEC-024）。
 *
 * 依赖: 仅 Node 内置模块 + shared 类型，**不依赖 Electron**，
 *       因此可在 vitest 中直接验证 CRUD、持久化与损坏恢复。
 *
 * 约定：
 *  - 主进程是唯一数据源；渲染层通过 GoalsView 读取、通过 IPC 意图写入。
 *  - 所有写方法返回 `{ok:false,message}` 而不是抛异常（非法输入不崩窗口）。
 *  - 写入防抖 + `flush()`；`before-quit` 必须调用 flush。
 *  - 保存失败不丢内存数据，通过 view.warning 暴露给窗口。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  Goal,
  GoalEntry,
  GoalEntryKind,
  GoalsFile,
  GoalsSummary,
  GoalsView,
} from '../shared/types';

/** 目标数据文件版本（与共享类型 GoalsFile 保持一致）。 */
export const GOALS_VERSION = 1 as const;

/** 单目标标题长度上限（trim 后）。 */
export const GOAL_TITLE_MAX = 120;
/** 单条时间线内容长度上限（trim 后）。 */
export const GOAL_ENTRY_TEXT_MAX = 500;
/** 目标数量上限。 */
export const GOALS_MAX = 200;
/** 单目标时间线条目上限。 */
export const GOAL_ENTRIES_MAX = 500;
/** 默认写盘防抖间隔（ms）。 */
export const GOALS_SAVE_DEBOUNCE_MS = 300;

/** 最小日志接口，避免 goals-store 依赖 logger/electron。 */
export interface GoalsLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface GoalsStoreOptions {
  /** 目标数据文件绝对路径（正式环境为 userData/goals.json）。 */
  filePath: string;
  /** 可注入时钟，便于测试确定时间与 `completedAt`。 */
  now?: () => number;
  /** 可注入 id 生成器，便于测试断言。 */
  randomId?: () => string;
  /** 写盘防抖；0 表示立即写（测试用）。 */
  debounceMs?: number;
  logger?: GoalsLogger;
}

/** 写操作结果：成功或带原因失败，绝不抛异常。 */
export type GoalMutationResult = { ok: true } | { ok: false; message: string };

type ViewListener = (view: GoalsView) => void;

const NOOP_LOGGER: GoalsLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export class GoalsStore {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly debounceMs: number;
  private readonly logger: GoalsLogger;

  private goals: Goal[] = [];
  private warning: string | undefined;
  private dirty = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<ViewListener>();

  constructor(options: GoalsStoreOptions) {
    this.filePath = options.filePath;
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? (() => randomUUID());
    this.debounceMs =
      options.debounceMs !== undefined && options.debounceMs >= 0
        ? options.debounceMs
        : GOALS_SAVE_DEBOUNCE_MS;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.load();
  }

  /** 当前视图（深拷贝，调用方修改不会污染仓库）。 */
  getView(): GoalsView {
    const goals = structuredClone(this.goals);
    return this.warning ? { goals, warning: this.warning } : { goals };
  }

  addGoal(title: string): GoalMutationResult {
    const trimmed = normalizeTitle(title);
    if (trimmed === null) {
      return { ok: false, message: `目标标题需为 1–${GOAL_TITLE_MAX} 个字符` };
    }
    if (this.goals.length >= GOALS_MAX) {
      return { ok: false, message: `目标数量已达上限（${GOALS_MAX} 个）` };
    }
    const at = this.now();
    const goal: Goal = {
      id: this.randomId(),
      title: trimmed,
      progress: 0,
      status: 'active',
      createdAt: at,
      updatedAt: at,
      entries: [],
    };
    this.goals.unshift(goal);
    this.changed();
    return { ok: true };
  }

  deleteGoal(id: string): GoalMutationResult {
    const index = this.goals.findIndex((goal) => goal.id === id);
    if (index === -1) {
      return { ok: false, message: '目标不存在' };
    }
    this.goals.splice(index, 1);
    this.changed();
    return { ok: true };
  }

  updateTitle(id: string, title: string): GoalMutationResult {
    const goal = this.findGoal(id);
    if (!goal) {
      return { ok: false, message: '目标不存在' };
    }
    const trimmed = normalizeTitle(title);
    if (trimmed === null) {
      return { ok: false, message: `目标标题需为 1–${GOAL_TITLE_MAX} 个字符` };
    }
    goal.title = trimmed;
    goal.updatedAt = this.now();
    this.changed();
    return { ok: true };
  }

  setProgress(id: string, progress: number): GoalMutationResult {
    const goal = this.findGoal(id);
    if (!goal) {
      return { ok: false, message: '目标不存在' };
    }
    if (!Number.isInteger(progress) || progress < 0 || progress > 100) {
      return { ok: false, message: '进度需为 0–100 的整数' };
    }
    if (goal.progress === progress) {
      return { ok: true };
    }
    goal.progress = progress;
    goal.updatedAt = this.now();
    this.changed();
    return { ok: true };
  }

  complete(id: string): GoalMutationResult {
    const goal = this.findGoal(id);
    if (!goal) {
      return { ok: false, message: '目标不存在' };
    }
    if (goal.status === 'done') {
      return { ok: false, message: '目标已完成' };
    }
    const at = this.now();
    goal.status = 'done';
    goal.progress = 100;
    goal.completedAt = at;
    goal.updatedAt = at;
    // 完成记录必须留住：达到上限时挤掉最旧的一条，而不是拒绝完成。
    if (goal.entries.length >= GOAL_ENTRIES_MAX) {
      goal.entries.pop();
    }
    goal.entries.unshift({
      id: this.randomId(),
      at,
      kind: 'done',
      text: '标记完成',
    });
    this.changed();
    return { ok: true };
  }

  addEntry(
    goalId: string,
    kind: GoalEntryKind,
    text: string,
  ): GoalMutationResult {
    const goal = this.findGoal(goalId);
    if (!goal) {
      return { ok: false, message: '目标不存在' };
    }
    if (kind !== 'progress' && kind !== 'issue') {
      return { ok: false, message: '记录类型只能是进展或问题' };
    }
    if (goal.entries.length >= GOAL_ENTRIES_MAX) {
      return { ok: false, message: `单个目标的时间线已达上限（${GOAL_ENTRIES_MAX} 条）` };
    }
    const trimmed = normalizeEntryText(text);
    if (trimmed === null) {
      return { ok: false, message: `记录内容需为 1–${GOAL_ENTRY_TEXT_MAX} 个字符` };
    }
    const at = this.now();
    goal.entries.unshift({ id: this.randomId(), at, kind, text: trimmed });
    goal.updatedAt = at;
    this.changed();
    return { ok: true };
  }

  deleteEntry(goalId: string, entryId: string): GoalMutationResult {
    const goal = this.findGoal(goalId);
    if (!goal) {
      return { ok: false, message: '目标不存在' };
    }
    const index = goal.entries.findIndex((entry) => entry.id === entryId);
    if (index === -1) {
      return { ok: false, message: '记录不存在' };
    }
    goal.entries.splice(index, 1);
    goal.updatedAt = this.now();
    this.changed();
    return { ok: true };
  }

  /** 同组内拖拽排序（SPEC-026）；beforeId 为 null 表示移到组末。 */
  moveGoal(id: string, beforeId: string | null): GoalMutationResult {
    const moving = this.findGoal(id);
    if (!moving) {
      return { ok: false, message: '目标不存在' };
    }

    let target: Goal | undefined;
    if (beforeId !== null) {
      if (typeof beforeId !== 'string') {
        return { ok: false, message: '排序参数无效' };
      }
      if (beforeId === id) {
        return { ok: false, message: '不能移动到自身' };
      }
      target = this.findGoal(beforeId);
      if (!target) {
        return { ok: false, message: '目标不存在' };
      }
      if (target.status !== moving.status) {
        return { ok: false, message: '只能在同一分组内排序' };
      }
    }

    const group = this.goals.filter(
      (goal) => goal.status === moving.status && goal.id !== id,
    );
    let insertIndex = group.length;
    if (target) {
      insertIndex = group.findIndex((goal) => goal.id === target.id);
      if (insertIndex < 0) {
        insertIndex = group.length;
      }
    }
    const reordered = [...group];
    reordered.splice(insertIndex, 0, moving);

    const other = this.goals.filter((goal) => goal.status !== moving.status);
    const active = moving.status === 'active' ? reordered : other;
    const done = moving.status === 'done' ? reordered : other;
    const next = [...active, ...done];

    const unchanged =
      next.length === this.goals.length &&
      next.every((goal, index) => goal.id === this.goals[index]!.id);
    if (unchanged) {
      return { ok: true };
    }
    this.goals = next;
    // 排序不是内容变更：不动 updatedAt，也不触发完成/提醒。
    this.changed();
    return { ok: true };
  }

  /** 立即把当前内存数据写盘（退出 / 测试用）。 */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty) {
      return;
    }
    this.saveNow();
  }

  /** 清理防抖定时器（测试 / 销毁窗口时用）。 */
  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.listeners.clear();
  }

  /** 订阅数据变更；返回取消订阅函数。 */
  onChange(listener: ViewListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /* ---------------------------------------------------------------- 内部 */

  private findGoal(id: string): Goal | undefined {
    return this.goals.find((goal) => goal.id === id);
  }

  private changed(): void {
    this.dirty = true;
    if (this.debounceMs <= 0) {
      this.saveNow();
    } else if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        if (this.dirty) {
          this.saveNow();
        }
      }, this.debounceMs);
      // 不阻止进程退出：真正的退出保障靠 before-quit 的 flush()。
      this.saveTimer.unref?.();
    }
    this.emit();
  }

  private emit(): void {
    if (this.listeners.size === 0) {
      return;
    }
    const view = this.getView();
    for (const listener of this.listeners) {
      try {
        listener(view);
      } catch (err) {
        this.logger.warn(`[goals] 订阅回调异常：${(err as Error).message}`);
      }
    }
  }

  private load(): void {
    let content: string;
    try {
      content = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        this.logger.warn(`[goals] 读取失败：${(err as Error).message}`);
        this.warning = '目标数据读取失败，已用空列表启动（原文件保留）';
      }
      return; // 不存在：空列表启动
    }

    const parsed = parseGoalsFile(content);
    if (parsed.ok) {
      this.goals = parsed.goals;
      if (parsed.dropped > 0) {
        this.warning = `目标数据中有 ${parsed.dropped} 条非法记录，已忽略`;
      }
      return;
    }

    // 主文件损坏：先尝试备份。
    this.logger.warn(`[goals] 主文件不可用：${parsed.reason}`);
    const backup = this.tryReadBackup();
    if (backup) {
      this.quarantineMainFile();
      this.goals = backup.goals;
      if (backup.dropped > 0) {
        this.warning = `主文件损坏，已从备份恢复（另有 ${backup.dropped} 条非法记录被忽略）`;
      } else {
        this.warning = '主文件损坏，已从备份恢复数据';
      }
      // 恢复后立刻重写主文件，避免下次启动再次走恢复路径。
      this.dirty = true;
      this.saveNow();
      return;
    }

    this.quarantineMainFile();
    this.goals = [];
    this.warning = '目标数据损坏且没有可用备份，已用空列表启动（原文件已保留）';
  }

  private tryReadBackup(): { goals: Goal[]; dropped: number } | null {
    const backupPath = `${this.filePath}.bak`;
    let content: string;
    try {
      content = fs.readFileSync(backupPath, 'utf8');
    } catch {
      return null;
    }
    const parsed = parseGoalsFile(content);
    if (!parsed.ok) {
      this.logger.warn(`[goals] 备份文件也不可用：${parsed.reason}`);
      return null;
    }
    return { goals: parsed.goals, dropped: parsed.dropped };
  }

  /** 把损坏的主文件改名保留，绝不静默覆盖。 */
  private quarantineMainFile(): void {
    if (!fs.existsSync(this.filePath)) {
      return;
    }
    const stamp = this.now();
    let target = `${this.filePath}.corrupt-${stamp}`;
    let salt = 1;
    while (fs.existsSync(target)) {
      target = `${this.filePath}.corrupt-${stamp}-${salt}`;
      salt += 1;
    }
    try {
      fs.renameSync(this.filePath, target);
    } catch (err) {
      this.logger.error(`[goals] 隔离损坏文件失败：${(err as Error).message}`);
    }
  }

  private saveNow(): void {
    if (!this.dirty) {
      return;
    }
    try {
      const file: GoalsFile = {
        version: GOALS_VERSION,
        goals: this.goals,
      };
      const text = `${JSON.stringify(file, null, 2)}\n`;
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

      const tmpPath = `${this.filePath}.tmp`;
      const fd = fs.openSync(tmpPath, 'w');
      try {
        fs.writeFileSync(fd, text, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }

      // 写前备份：主文件存在时保留上一份，供损坏恢复使用。
      if (fs.existsSync(this.filePath)) {
        try {
          fs.copyFileSync(this.filePath, `${this.filePath}.bak`);
        } catch (err) {
          this.logger.warn(`[goals] 写备份失败（不影响主写入）：${(err as Error).message}`);
        }
      }

      fs.renameSync(tmpPath, this.filePath);
      this.dirty = false;
      if (this.warning?.startsWith('目标数据保存失败')) {
        this.warning = undefined;
      }
    } catch (err) {
      this.logger.error(`[goals] 保存失败：${(err as Error).message}`);
      this.warning = `目标数据保存失败：${(err as Error).message}`;
    }
  }
}

/* ============================================================================
 * 校验与格式化
 * ==========================================================================*/

function normalizeTitle(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > GOAL_TITLE_MAX) {
    return null;
  }
  return trimmed;
}

function normalizeEntryText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > GOAL_ENTRY_TEXT_MAX) {
    return null;
  }
  return trimmed;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 校验单条记录；非法返回 null。 */
function sanitizeEntry(raw: unknown): GoalEntry | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const entry = raw as Record<string, unknown>;
  if (typeof entry.id !== 'string' || entry.id.length === 0) {
    return null;
  }
  if (!isFiniteNumber(entry.at)) {
    return null;
  }
  if (entry.kind !== 'progress' && entry.kind !== 'issue' && entry.kind !== 'done') {
    return null;
  }
  const text = normalizeEntryText(entry.text);
  if (text === null) {
    return null;
  }
  return { id: entry.id, at: entry.at, kind: entry.kind, text };
}

/** 校验单条目标；非法返回 null。 */
function sanitizeGoal(raw: unknown): Goal | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const goal = raw as Record<string, unknown>;
  if (typeof goal.id !== 'string' || goal.id.length === 0) {
    return null;
  }
  const title = normalizeTitle(goal.title);
  if (title === null) {
    return null;
  }
  if (
    typeof goal.progress !== 'number' ||
    !Number.isInteger(goal.progress) ||
    goal.progress < 0 ||
    goal.progress > 100
  ) {
    return null;
  }
  if (goal.status !== 'active' && goal.status !== 'done') {
    return null;
  }
  if (!isFiniteNumber(goal.createdAt) || !isFiniteNumber(goal.updatedAt)) {
    return null;
  }
  if (
    goal.status === 'done' &&
    !isFiniteNumber(goal.completedAt)
  ) {
    return null;
  }
  if (!Array.isArray(goal.entries)) {
    return null;
  }
  const entries: GoalEntry[] = [];
  const seen = new Set<string>();
  for (const rawEntry of goal.entries) {
    const entry = sanitizeEntry(rawEntry);
    if (!entry || seen.has(entry.id)) {
      continue;
    }
    seen.add(entry.id);
    entries.push(entry);
  }
  const sanitized: Goal = {
    id: goal.id,
    title,
    progress: goal.progress,
    status: goal.status,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    entries,
  };
  if (goal.status === 'done' && isFiniteNumber(goal.completedAt)) {
    sanitized.completedAt = goal.completedAt;
  }
  return sanitized;
}

type ParseResult =
  | { ok: true; goals: Goal[]; dropped: number }
  | { ok: false; reason: string };

function parseGoalsFile(content: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    return { ok: false, reason: `JSON 解析失败：${(err as Error).message}` };
  }
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: '根节点不是对象' };
  }
  const file = raw as Record<string, unknown>;
  if (file.version !== GOALS_VERSION) {
    return { ok: false, reason: `未知版本：${String(file.version)}` };
  }
  if (!Array.isArray(file.goals)) {
    return { ok: false, reason: 'goals 不是数组' };
  }

  const goals: Goal[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const rawGoal of file.goals) {
    const goal = sanitizeGoal(rawGoal);
    if (!goal || seen.has(goal.id)) {
      dropped += 1;
      continue;
    }
    seen.add(goal.id);
    goals.push(goal);
  }
  return { ok: true, goals, dropped };
}

/** 供测试与窗口复用的时间格式（本地时区，YYYY-MM-DD HH:mm）。 */
export function formatGoalTime(at: number): string {
  const date = new Date(at);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

/**
 * 悬浮灯「目标」行所需的摘要（SPEC-025）。
 *
 * 只统计进行中的目标：全部完成后浮窗不再挂一行常驻目标。
 * 平均进度四舍五入到整数；无进行中目标时 progress = 0。
 */
export function summarizeGoals(view: GoalsView): GoalsSummary {
  const activeGoals = view.goals.filter((goal) => goal.status === 'active');
  const doneCount = view.goals.length - activeGoals.length;
  const total = activeGoals.reduce((sum, goal) => sum + goal.progress, 0);
  return {
    active: activeGoals.length,
    done: doneCount,
    progress: activeGoals.length === 0 ? 0 : Math.round(total / activeGoals.length),
  };
}
