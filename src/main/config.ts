/**
 * 配置加载与校验。
 *
 * 依赖: `yaml`（YAML 解析）、Node 内置 `fs`/`path`/`os`。
 * **刻意不 import electron** —— 路径解析通过参数注入 userDataDir，
 * 这样 validateConfig / mergeDefaults / resolveConfigPath 全部可在 vitest 中验证（架构 T02 验收）。
 *
 * 核心原则（PRD P0-7）：**非法项不崩溃** —— 逐条 try-catch，丢弃非法项 + 汇总 warning，
 * 其余项照常生效。语法错误则整体保留旧配置。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import {
  CONFIG_BACKUP_SUFFIX,
  CONFIG_DIR_NAME,
  CONFIG_EXAMPLE_FILE_NAME,
  CONFIG_FILE_NAME,
  CONFIG_WATCH_DEBOUNCE_MS,
  DEFAULT_APP_SETTINGS,
  DEFAULT_COLOR_OVERRIDES,
  DEFAULT_LAMP_SETTINGS,
  DEFAULT_NOTIFY_SETTINGS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_STATE_TIMEOUT,
} from '../shared/constants';
import {
  ALL_TASK_STATUSES,
  isTaskStatus,
  type AppConfig,
  type AppSettings,
  type ColorOverrides,
  type DshMonitorConfig,
  type CodexMonitorConfig,
  type JumpConfig,
  type LampSettings,
  type LogMonitorConfig,
  type LogRule,
  type MonitorConfig,
  type NotifyActionId,
  type NotifySettings,
  type SqliteMonitorConfig,
  type ProcessMonitorConfig,
  type StateTimeoutDefaults,
  type TaskConfig,
  type WebhookMonitorConfig,
} from '../shared/types';

/* ============================================================================
 * 校验结果
 * ==========================================================================*/

/** 校验产物：合法配置 + 全部被丢弃项的描述（用于托盘气泡汇总）。 */
export interface ValidationOutcome {
  config: AppConfig;
  warnings: string[];
}

/** 抛出的配置语法错误 —— 与「非法项」区分：语法错误必须保留旧配置。 */
export class ConfigSyntaxError extends Error {
  /** 底层的 YAML 解析异常（保留原始错误便于排查）。 */
  readonly reason: unknown;

  constructor(message: string, reason?: unknown) {
    super(message);
    this.name = 'ConfigSyntaxError';
    this.reason = reason;
  }
}

/* ============================================================================
 * 路径解析（架构 D7：--config > PRD 路径 > userData）
 * ==========================================================================*/

/** 从 `process.argv` 里解析 `--config <path>` / `--config=<path>`。 */
export function parseConfigArg(argv: readonly string[] = process.argv): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--config' || arg === '-c') {
      const next = argv[i + 1];
      return next && !next.startsWith('-') ? next : null;
    }
    if (arg.startsWith('--config=')) {
      return arg.slice('--config='.length) || null;
    }
  }
  return null;
}

/** PRD §6 主路径：`%USERPROFILE%\.ai-task-indicator\config.yaml`。 */
export function userConfigPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

/**
 * 4 级路径优先级（架构 §1.7）：
 *   1. CLI --config
 *   2. %USERPROFILE%\.ai-task-indicator\config.yaml
 *   3. <userData>/config.yaml
 *   4. 都不存在 -> 落盘模板到路径 2
 */
export function resolveConfigPath(options: {
  argv?: readonly string[];
  userDataDir: string;
  homeDir?: string;
  exists?: (p: string) => boolean;
}): { path: string; source: 'cli' | 'user' | 'userData' | 'default' } {
  const exists = options.exists ?? ((p: string) => fs.existsSync(p));
  const home = options.homeDir ?? os.homedir();

  const cli = parseConfigArg(options.argv);
  if (cli) {
    return { path: path.resolve(cli), source: 'cli' };
  }

  const userPath = userConfigPath(home);
  if (exists(userPath)) {
    return { path: userPath, source: 'user' };
  }

  const userDataPath = path.join(options.userDataDir, CONFIG_FILE_NAME);
  if (exists(userDataPath)) {
    return { path: userDataPath, source: 'userData' };
  }

  return { path: userPath, source: 'default' };
}

/* ============================================================================
 * 工具
 * ==========================================================================*/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读正整数（毫秒/像素等），非法或非正数返回 undefined 交给默认值兜底。 */
function readPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/** 读布尔值。 */
function readBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** 读字符串数组，过滤非字符串项。 */
function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return items.length > 0 ? items : undefined;
}

/** 读枚举值。 */
function readEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** 读 `#RRGGBB` / `#RGB` 形式的颜色。 */
function readColor(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim()) ? value.trim() : undefined;
}

/* ============================================================================
 * 分段校验
 * ==========================================================================*/

/** 校验 app 段。 */
function validateApp(raw: unknown, warn: (m: string) => void): AppSettings {
  if (!isPlainObject(raw)) {
    if (raw !== undefined) warn('app 段不是对象，已使用默认值');
    return { ...DEFAULT_APP_SETTINGS };
  }
  const settings: AppSettings = { ...DEFAULT_APP_SETTINGS };
  settings.startMinimized = readBool(raw.startMinimized, settings.startMinimized);
  settings.autoLaunch = readBool(raw.autoLaunch, settings.autoLaunch);
  settings.pollIntervalMs =
    readPositiveInt(raw.pollIntervalMs) ?? DEFAULT_POLL_INTERVAL_MS;
  settings.locale = typeof raw.locale === 'string' ? raw.locale : settings.locale;
  settings.processPollMode = readEnum(
    raw.processPollMode,
    ['resident', 'onDemand'] as const,
    settings.processPollMode,
  );
  settings.hookPort = readPositiveInt(raw.hookPort) ?? settings.hookPort;
  if (settings.hookPort > 65_535) {
    warn(`app.hookPort ${settings.hookPort} 超出端口范围，已回退 ${settings.hookPort}`);
    settings.hookPort = DEFAULT_APP_SETTINGS.hookPort;
  }
  // dsh 配置目录：仅 dsh 型监控使用（取 browser-session 签名密钥）。
  // 未配置时由 DshMonitor 兜底到 %USERPROFILE%/.dsh，所以这里不强填默认值。
  if (typeof raw.dshHome === 'string' && raw.dshHome.length > 0) {
    settings.dshHome = raw.dshHome;
  } else if (raw.dshHome !== undefined) {
    warn('app.dshHome 非字符串，已忽略（将使用 %USERPROFILE%/.dsh）');
  }
  return settings;
}

/** 校验 lamp 段。 */
function validateLamp(raw: unknown, warn: (m: string) => void): LampSettings {
  if (!isPlainObject(raw)) {
    if (raw !== undefined) warn('lamp 段不是对象，已使用默认值');
    return { ...DEFAULT_LAMP_SETTINGS };
  }
  const lamp: LampSettings = { ...DEFAULT_LAMP_SETTINGS };
  lamp.enabled = readBool(raw.enabled, lamp.enabled);
  // x 允许 -1（未设置），因此这里不能用 readPositiveInt。
  if (typeof raw.x === 'number' && Number.isFinite(raw.x)) lamp.x = Math.floor(raw.x);
  if (typeof raw.y === 'number' && Number.isFinite(raw.y)) lamp.y = Math.floor(raw.y);
  lamp.size = readPositiveInt(raw.size) ?? lamp.size;
  if (typeof raw.opacity === 'number' && raw.opacity > 0 && raw.opacity <= 1) {
    lamp.opacity = raw.opacity;
  } else if (raw.opacity !== undefined) {
    warn(`lamp.opacity 非法（应在 0~1 之间），已使用 ${lamp.opacity}`);
  }
  lamp.alwaysOnTop = readBool(raw.alwaysOnTop, lamp.alwaysOnTop);
  lamp.showBadge = readBool(raw.showBadge, lamp.showBadge);
  lamp.clickThrough = readBool(raw.clickThrough, lamp.clickThrough);
  lamp.resetOnSuccess = readBool(raw.resetOnSuccess, lamp.resetOnSuccess);
  return lamp;
}

const VALID_NOTIFY_ACTION_IDS: readonly NotifyActionId[] = [
  'focus_terminal',
  'open_log',
  'open_dir',
];

/** 校验 notify 段。 */
function validateNotify(raw: unknown, warn: (m: string) => void): NotifySettings {
  if (!isPlainObject(raw)) {
    if (raw !== undefined) warn('notify 段不是对象，已使用默认值');
    return { ...DEFAULT_NOTIFY_SETTINGS, actions: DEFAULT_NOTIFY_SETTINGS.actions.map((a) => ({ ...a })) };
  }
  const notify: NotifySettings = {
    ...DEFAULT_NOTIFY_SETTINGS,
    actions: DEFAULT_NOTIFY_SETTINGS.actions.map((a) => ({ ...a })),
  };
  notify.popup = readBool(raw.popup, notify.popup);
  notify.sound = readBool(raw.sound, notify.sound);
  notify.soundOnlyOnFailure = readBool(raw.soundOnlyOnFailure, notify.soundOnlyOnFailure);
  notify.debounceMs = readPositiveInt(raw.debounceMs) ?? notify.debounceMs;
  notify.doNotDisturbOnFullscreen = readBool(
    raw.doNotDisturbOnFullscreen,
    notify.doNotDisturbOnFullscreen,
  );
  if (typeof raw.soundFile === 'string' && raw.soundFile.length > 0) {
    notify.soundFile = raw.soundFile;
  }

  if (raw.notifyStates !== undefined) {
    const list = Array.isArray(raw.notifyStates)
      ? raw.notifyStates.filter((v): v is string => isTaskStatus(v))
      : [];
    const invalid = Array.isArray(raw.notifyStates)
      ? raw.notifyStates.filter((v) => !isTaskStatus(v))
      : [];
    if (invalid.length > 0) {
      warn(
        `notify.notifyStates 含非法状态 ${invalid.map(String).join(', ')}，已剔除（合法七态见 PRD §5.1）`,
      );
    }
    notify.notifyStates = (list.length > 0 ? list : [...DEFAULT_NOTIFY_SETTINGS.notifyStates]) as AppConfig['notify']['notifyStates'];
  }

  if (raw.actions !== undefined) {
    if (!Array.isArray(raw.actions)) {
      warn('notify.actions 不是数组，已使用默认按钮');
    } else {
      const actions = raw.actions.flatMap((item, index) => {
        if (!isPlainObject(item)) {
          warn(`notify.actions[${index}] 不是对象，已丢弃`);
          return [];
        }
        const id = item.id;
        if (typeof id !== 'string' || !VALID_NOTIFY_ACTION_IDS.includes(id as NotifyActionId)) {
          warn(
            `notify.actions[${index}].id 非法（${String(id)}），合法值 ${VALID_NOTIFY_ACTION_IDS.join('/')}，已丢弃`,
          );
          return [];
        }
        return [
          {
            id: id as NotifyActionId,
            label: typeof item.label === 'string' ? item.label : String(id),
          },
        ];
      });
      // Windows 通知最多 3 个按钮（PRD §7.4）
      if (actions.length > 3) {
        warn(`notify.actions 超过 3 个，已截断为前 3 个（Windows 通知按钮上限）`);
      }
      notify.actions = actions.slice(0, 3);
    }
  }
  return notify;
}

/** 校验 defaults 段（超时默认值 + 颜色覆盖）。 */
function validateDefaults(
  raw: unknown,
  warn: (m: string) => void,
): { stateTimeout: StateTimeoutDefaults; colors: ColorOverrides } {
  const stateTimeout: StateTimeoutDefaults = { ...DEFAULT_STATE_TIMEOUT };
  let colors: ColorOverrides = { ...DEFAULT_COLOR_OVERRIDES };

  if (!isPlainObject(raw)) {
    if (raw !== undefined) warn('defaults 段不是对象，已使用默认值');
    return { stateTimeout, colors };
  }

  const st = raw.stateTimeout;
  if (isPlainObject(st)) {
    for (const key of Object.keys(stateTimeout) as (keyof StateTimeoutDefaults)[]) {
      const value = readPositiveInt(st[key]);
      if (value !== undefined) {
        stateTimeout[key] = value;
      } else if (st[key] !== undefined) {
        warn(`defaults.stateTimeout.${key} 非法，已使用默认 ${stateTimeout[key]}`);
      }
    }
  } else if (st !== undefined) {
    warn('defaults.stateTimeout 不是对象，已使用默认值');
  }

  if (isPlainObject(raw.colors)) {
    const overrides: ColorOverrides = {};
    for (const [key, value] of Object.entries(raw.colors)) {
      if (!isTaskStatus(key)) {
        warn(`defaults.colors.${key} 不是合法状态名（${ALL_TASK_STATUSES.join('/')}），已丢弃`);
        continue;
      }
      const color = readColor(value);
      if (color) {
        overrides[key] = color;
      } else {
        warn(`defaults.colors.${key} 颜色格式非法（需 #RGB/#RRGGBB），已丢弃`);
      }
    }
    colors = overrides;
  } else if (raw.colors !== undefined) {
    warn('defaults.colors 不是对象，已使用默认状态色');
  }

  return { stateTimeout, colors };
}

/* ============================================================================
 * 监控配置校验
 * ==========================================================================*/

function validateLogRules(raw: unknown, taskId: string, warn: (m: string) => void): LogRule[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    warn(`任务 ${taskId}: monitor.rules 为空，该任务将永远无法判定完成/失败`);
    return [];
  }
  const rules: LogRule[] = [];
  raw.forEach((item, index) => {
    if (!isPlainObject(item)) {
      warn(`任务 ${taskId}: rules[${index}] 不是对象，已丢弃`);
      return;
    }
    if (!isTaskStatus(item.state)) {
      warn(
        `任务 ${taskId}: rules[${index}].state 非法（${String(item.state)}），合法值 ${ALL_TASK_STATUSES.join('/')}，已丢弃`,
      );
      return;
    }
    if (typeof item.match !== 'string' || item.match.length === 0) {
      warn(`任务 ${taskId}: rules[${index}].match 缺失，已丢弃`);
      return;
    }
    rules.push({ state: item.state, match: item.match });
  });
  return rules;
}

function validateProcessMonitor(
  raw: Record<string, unknown>,
  taskId: string,
  warn: (m: string) => void,
): ProcessMonitorConfig {
  const cfg: ProcessMonitorConfig = { type: 'process', match: [] };

  // 匹配规则的解析与 sqlite 型的 requireProcess 共用（语义必须一致）
  cfg.match.push(...readProcessMatchRules(raw.match, taskId, warn, 'match'));
  if (!Array.isArray(raw.match)) {
    warn(`任务 ${taskId}: monitor.match 不是数组，该任务将无法匹配任何进程`);
  }

  if (cfg.match.length === 0) {
    warn(`任务 ${taskId}: process 监控没有任何有效 match 规则，该任务不可用`);
  }

  if (isPlainObject(raw.onExit)) {
    const codes = Array.isArray(raw.onExit.successExitCodes)
      ? raw.onExit.successExitCodes.filter((v): v is number => typeof v === 'number')
      : [0];
    cfg.onExit = {
      successExitCodes: codes,
      graceMs: readPositiveInt(raw.onExit.graceMs),
    };
  }

  if (isPlainObject(raw.fallbackLog)) {
    const paths = readStringArray(raw.fallbackLog.paths);
    if (paths) {
      const state = raw.fallbackLog.stateOnNewLine;
      cfg.fallbackLog = {
        paths,
        stateOnNewLine: isTaskStatus(state) ? state : 'running',
      };
      if (!isTaskStatus(state)) {
        warn(`任务 ${taskId}: fallbackLog.stateOnNewLine 非法，已回退 running`);
      }
    }
  }

  if (readPositiveInt(raw.staleTimeoutMs) !== undefined) {
    cfg.staleTimeoutMs = readPositiveInt(raw.staleTimeoutMs);
  }
  if (readPositiveInt(raw.startTimeoutMs) !== undefined) {
    cfg.startTimeoutMs = readPositiveInt(raw.startTimeoutMs);
  }
  if (readPositiveInt(raw.debounceMs) !== undefined) {
    cfg.debounceMs = readPositiveInt(raw.debounceMs);
  }
  return cfg;
}

function validateLogMonitor(
  raw: Record<string, unknown>,
  taskId: string,
  warn: (m: string) => void,
): LogMonitorConfig {
  const paths = readStringArray(raw.paths);
  if (!paths) {
    warn(`任务 ${taskId}: log 监控缺少 paths，该任务不可用`);
  }
  const cfg: LogMonitorConfig = {
    type: 'log',
    paths: paths ?? [],
    rules: validateLogRules(raw.rules, taskId, warn),
  };
  cfg.readMode = 'tail';
  cfg.fromEndBytes = readPositiveInt(raw.fromEndBytes);
  cfg.idleAfterSilenceMs = readPositiveInt(raw.idleAfterSilenceMs);
  if (readPositiveInt(raw.staleTimeoutMs) !== undefined) {
    cfg.staleTimeoutMs = readPositiveInt(raw.staleTimeoutMs);
  }
  if (readPositiveInt(raw.startTimeoutMs) !== undefined) {
    cfg.startTimeoutMs = readPositiveInt(raw.startTimeoutMs);
  }
  if (readPositiveInt(raw.debounceMs) !== undefined) {
    cfg.debounceMs = readPositiveInt(raw.debounceMs);
  }
  return cfg;
}

function validateWebhookMonitor(
  raw: Record<string, unknown>,
  taskId: string,
  warn: (m: string) => void,
): WebhookMonitorConfig {
  const listen = typeof raw.listen === 'string' ? raw.listen : '127.0.0.1';
  if (listen !== '127.0.0.1' && listen !== 'localhost' && listen !== '::1') {
    // 架构 §4.4 安全措施 1：绝不用 0.0.0.0，强制 loopback。
    warn(
      `任务 ${taskId}: webhook.listen=${listen} 非loopback，出于安全已强制改为 127.0.0.1`,
    );
  }
  const cfg: WebhookMonitorConfig = {
    type: 'webhook',
    listen: '127.0.0.1',
    path: typeof raw.path === 'string' && raw.path.startsWith('/') ? raw.path : `/hook/${taskId}`,
  };
  if (typeof raw.path !== 'string') {
    warn(`任务 ${taskId}: webhook.path 缺失，已使用 /hook/${taskId}`);
  }
  if (typeof raw.secret === 'string' && raw.secret.length > 0) {
    cfg.secret = raw.secret;
  }
  if (isPlainObject(raw.fieldMap)) {
    const stateExpr = raw.fieldMap.state;
    if (typeof stateExpr === 'string' && stateExpr.length > 0) {
      cfg.fieldMap = { state: stateExpr };
      if (typeof raw.fieldMap.message === 'string') {
        cfg.fieldMap.message = raw.fieldMap.message;
      }
      if (typeof raw.fieldMap.progress === 'string') {
        cfg.fieldMap.progress = raw.fieldMap.progress;
      }
    } else {
      warn(`任务 ${taskId}: webhook.fieldMap.state 缺失，将使用 payload.status 兜底`);
    }
  }
  cfg.heartbeatTimeoutMs = readPositiveInt(raw.heartbeatTimeoutMs);
  if (readPositiveInt(raw.staleTimeoutMs) !== undefined) {
    cfg.staleTimeoutMs = readPositiveInt(raw.staleTimeoutMs);
  }
  if (readPositiveInt(raw.debounceMs) !== undefined) {
    cfg.debounceMs = readPositiveInt(raw.debounceMs);
  }
  return cfg;
}

function validateMonitor(raw: unknown, taskId: string, warn: (m: string) => void): MonitorConfig | null {
  if (!isPlainObject(raw)) {
    warn(`任务 ${taskId}:缺少 monitor 段，已丢弃该任务`);
    return null;
  }
  const type = raw.type;
  if (type === 'process') return validateProcessMonitor(raw, taskId, warn);
  if (type === 'log') return validateLogMonitor(raw, taskId, warn);
  if (type === 'webhook') return validateWebhookMonitor(raw, taskId, warn);
  if (type === 'dsh') return validateDshMonitor(raw, taskId, warn);
  if (type === 'codex') return validateCodexMonitor(raw, taskId, warn);
  if (type === 'sqlite') return validateSqliteMonitor(raw, taskId, warn);
  warn(
    `任务 ${taskId}: monitor.type 非法（${String(type)}），合法值 process/log/webhook/dsh/sqlite/codex，已丢弃该任务`,
  );
  return null;
}

function validateCodexMonitor(raw: Record<string, unknown>, taskId: string, warn: (m: string) => void): CodexMonitorConfig {
  const cfg: CodexMonitorConfig = { type: 'codex' };
  if (typeof raw.sessionsDir === 'string' && raw.sessionsDir.trim()) cfg.sessionsDir = raw.sessionsDir.trim();
  else if (raw.sessionsDir !== undefined) warn(`任务 ${taskId}: codex.sessionsDir 非法，使用默认目录`);
  for (const key of ['intervalMs', 'activeWithinMs'] as const) {
    const value = readPositiveInt(raw[key]);
    if (value !== undefined) cfg[key] = Math.max(key === 'intervalMs' ? 500 : 1000, value);
    else if (raw[key] !== undefined) warn(`任务 ${taskId}: codex.${key} 非法，使用默认值`);
  }
  return cfg;
}

/**
 * 校验 sqlite 型监控配置。
 *
 * 容错原则与其余各型一致：**单个字段非法只丢弃该字段并记警告**。
 * 只有 `database` 缺失/非法时才丢弃整个任务（没有库就没有监控对象）。
 */
function validateSqliteMonitor(
  raw: Record<string, unknown>,
  taskId: string,
  warn: (m: string) => void,
): SqliteMonitorConfig | null {
  const database = typeof raw.database === 'string' ? raw.database.trim() : '';
  if (database.length === 0) {
    warn(`任务 ${taskId}: sqlite.database 缺失（应为 .db 文件绝对路径），已丢弃该任务`);
    return null;
  }
  if (!/\.(db|sqlite|sqlite3)$/iu.test(database)) {
    warn(
      `任务 ${taskId}: sqlite.database=${database} 看起来不是 SQLite 文件（应以 .db/.sqlite/.sqlite3 结尾），已丢弃该任务`,
    );
    return null;
  }

  const cfg: SqliteMonitorConfig = { type: 'sqlite', database };
  if (typeof raw.completedStatus === 'string' && raw.completedStatus.trim()) cfg.completedStatus = raw.completedStatus.trim();
  for (const key of ['waitingStatuses', 'failedStatuses'] as const) {
    const values = readStringArray(raw[key]);
    if (values !== undefined) cfg[key] = values;
  }

  if (typeof raw.activeStatus === 'string' && raw.activeStatus.trim().length > 0) {
    cfg.activeStatus = raw.activeStatus.trim();
  }
  const within = readPositiveInt(raw.activeWithinMs);
  if (within !== undefined) cfg.activeWithinMs = within;
  // 完成提醒开关（默认 true；false = 完成后直接回灰，不亮绿灯）
  if (typeof raw.notifyOnDone === 'boolean') cfg.notifyOnDone = raw.notifyOnDone;
  else if (raw.notifyOnDone !== undefined) {
    warn(`任务 ${taskId}: sqlite.notifyOnDone 应为布尔值，已忽略`);
  }
  const interval = readPositiveInt(raw.intervalMs);
  if (interval !== undefined && interval >= 500) cfg.intervalMs = interval;
  const maxFail = readPositiveInt(raw.maxFailures);
  if (maxFail !== undefined) cfg.maxFailures = maxFail;

  // 可选进程闸门 —— 复用 process 型的匹配规则校验（同一套语义）
  const match = readProcessMatchRules(raw.requireProcess, taskId, warn, 'requireProcess');
  if (match.length > 0) cfg.requireProcess = match;

  return cfg;
}

/**
 * 读进程匹配规则数组（process 型的 `match` / sqlite 型的 `requireProcess` 共用）。
 *
 * 抽出来是因为两处语义必须完全一致：多组之间是**或**，
 * 组内 `processNames` 与 `cmdlineContains` 之间是**与**。
 */
function readProcessMatchRules(
  value: unknown,
  taskId: string,
  warn: (m: string) => void,
  field: string,
): { processNames: string[]; cmdlineContains?: string[] }[] {
  const rules: { processNames: string[]; cmdlineContains?: string[] }[] = [];
  if (!Array.isArray(value)) {
    warn(`任务 ${taskId}: monitor.${field} 不是数组，已忽略`);
    return rules;
  }
  value.forEach((item, index) => {
    if (!isPlainObject(item)) {
      warn(`任务 ${taskId}: monitor.${field}[${index}] 不是对象，已丢弃`);
      return;
    }
    const processNames = readStringArray(item.processNames);
    if (!processNames) {
      warn(`任务 ${taskId}: monitor.${field}[${index}].processNames 缺失或为空，已丢弃该组`);
      return;
    }
    const rule: { processNames: string[]; cmdlineContains?: string[] } = { processNames };
    const cmdline = readStringArray(item.cmdlineContains);
    if (cmdline) rule.cmdlineContains = cmdline;
    rules.push(rule);
  });
  return rules;
}

/**
 * 校验 dsh 型监控配置。
 *
 * 容错原则与其余各型一致：**单个字段非法只丢弃该字段并记警告**，
 * 其余照常生效；只有 authority 无法解析时才丢弃整个任务
 * （没有 authority 就没有监控对象，无法兜底）。
 */
function validateDshMonitor(
  raw: Record<string, unknown>,
  taskId: string,
  warn: (m: string) => void,
): DshMonitorConfig | null {
  const authority = typeof raw.authority === 'string' ? raw.authority.trim() : '';
  if (authority.length === 0) {
    warn(`任务 ${taskId}: dsh.authority 缺失（应形如 127.0.0.1:3080，或 auto），已丢弃该任务`);
    return null;
  }

  // SPEC-005：`auto` = 自动发现本机可认证的 dsh 实例（桌面端每次启动换端口）。
  const isAuto = authority.toLowerCase() === 'auto';

  // authority 必须是 host:port —— cookie 的名字与签名都绑定它，写错就必然 401
  const colon = isAuto ? 0 : authority.lastIndexOf(':');
  const host = isAuto ? 'auto' : colon === -1 ? '' : authority.slice(0, colon);
  const port = isAuto ? 1 : colon === -1 ? Number.NaN : Number(authority.slice(colon + 1));
  if (host.length === 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    warn(
      `任务 ${taskId}: dsh.authority=${authority} 不是合法的 host:port 或 auto（应形如 127.0.0.1:3080），已丢弃该任务`,
    );
    return null;
  }

  const cfg: DshMonitorConfig = { type: 'dsh', authority: isAuto ? 'auto' : authority };

  if (isAuto && typeof raw.sshHost === 'string' && raw.sshHost.length > 0) {
    warn(`任务 ${taskId}: dsh.authority=auto 时不会用 sshHost（自动发现只认本机能认证的实例），已忽略`);
  }

  if (typeof raw.dshHome === 'string' && raw.dshHome.length > 0) {
    cfg.dshHome = raw.dshHome;
  }
  if (typeof raw.sshHost === 'string' && raw.sshHost.length > 0 && !isAuto) {
    cfg.sshHost = raw.sshHost;
  }

  const intervalMs = readPositiveInt(raw.intervalMs);
  if (intervalMs !== undefined) {
    // 过密的轮询会给 dsh 造成无谓负载；下限 500ms
    if (intervalMs < 500) {
      warn(`任务 ${taskId}: dsh.intervalMs=${intervalMs} 过小，已提升到 500ms`);
      cfg.intervalMs = 500;
    } else {
      cfg.intervalMs = intervalMs;
    }
  }

  const timeoutMs = readPositiveInt(raw.timeoutMs);
  if (timeoutMs !== undefined) {
    cfg.timeoutMs = timeoutMs;
  }

  const heartbeatTimeoutMs = readPositiveInt(raw.heartbeatTimeoutMs);
  if (heartbeatTimeoutMs !== undefined) {
    cfg.heartbeatTimeoutMs = heartbeatTimeoutMs;
  }

  if (typeof raw.allowPlanPendingHeuristic === 'boolean') {
    cfg.allowPlanPendingHeuristic = raw.allowPlanPendingHeuristic;
  } else if (raw.allowPlanPendingHeuristic !== undefined) {
    warn(`任务 ${taskId}: dsh.allowPlanPendingHeuristic 非布尔值，已忽略`);
  }

  if (readPositiveInt(raw.staleTimeoutMs) !== undefined) {
    cfg.staleTimeoutMs = readPositiveInt(raw.staleTimeoutMs);
  }

  return cfg;
}

/* ============================================================================
 * jump 校验
 * ==========================================================================*/

function validateJump(raw: unknown, taskId: string, warn: (m: string) => void): JumpConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isPlainObject(raw)) {
    warn(`任务 ${taskId}: jump 段不是对象，已忽略跳转配置`);
    return undefined;
  }
  const jump: JumpConfig = {};
  if (typeof raw.cwd === 'string' && raw.cwd.length > 0) {
    jump.cwd = raw.cwd;
  }
  if (typeof raw.logFile === 'string' && raw.logFile.length > 0) {
    jump.logFile = raw.logFile;
  }
  if (typeof raw.openWith === 'string' && raw.openWith.length > 0) {
    jump.openWith = raw.openWith;
  }

  // ★ openUrl：只接受 http / https
  //
  // 【为什么要限协议】这个值最终会交给系统去"打开"。若不限，
  // 配置就能写成 `file:///…` 甚至自定义协议处理程序，
  // 变成一个可被配置驱动的任意行为入口。任务配置不是可信输入
  // （可能来自别人分享的示例文件），所以协议必须走白名单。
  //
  // 空字符串按"未配置"处理且**不告警** —— 和 cwd/logFile 一致。
  // YAML 里留个空 key 很常见（把内容注释掉但保留 key），
  // 为它刷警告只会让"警告"这个信号变廉价。
  if (typeof raw.openUrl === 'string' && raw.openUrl.trim().length === 0) {
    // 显式空值：当作未配置，静默跳过
  } else if (typeof raw.openUrl === 'string') {
    const url = raw.openUrl.trim();
    let scheme = '';
    try {
      scheme = new URL(url).protocol;
    } catch {
      scheme = '';
    }
    if (scheme === 'http:' || scheme === 'https:') {
      jump.openUrl = url;
    } else {
      warn(
        `任务 ${taskId}: jump.openUrl=${url} 不是合法的 http/https URL，已忽略（点击会退回窗口聚焦/目录兜底）`,
      );
    }
  } else if (raw.openUrl !== undefined) {
    warn(`任务 ${taskId}: jump.openUrl 应为字符串，已忽略`);
  }

  // openUrlTitleMatch：浏览器窗口标题片段（用于"切到已打开的页面"）
  if (typeof raw.openUrlTitleMatch === 'string' && raw.openUrlTitleMatch.trim().length > 0) {
    jump.openUrlTitleMatch = raw.openUrlTitleMatch.trim();
  } else if (typeof raw.openUrlTitleMatch === 'string') {
    // 空串按"未配置"处理，静默跳过（与 openUrl 一致）
  } else if (raw.openUrlTitleMatch !== undefined) {
    warn(`任务 ${taskId}: jump.openUrlTitleMatch 应为字符串，已忽略`);
  }

  // openUrlDebugPort：Chrome DevTools 远程调试 HTTP 端口（用于精确切到已开的标签页）
  if (
    typeof raw.openUrlDebugPort === 'number' &&
    Number.isInteger(raw.openUrlDebugPort) &&
    raw.openUrlDebugPort >= 1 &&
    raw.openUrlDebugPort <= 65535
  ) {
    jump.openUrlDebugPort = raw.openUrlDebugPort;
  } else if (raw.openUrlDebugPort !== undefined) {
    warn(`任务 ${taskId}: jump.openUrlDebugPort 应为 1..65535 的整数，已忽略`);
  }

  // openUrlViaExtension：走本地浏览器扩展精确切标签（用日常浏览器）
  if (typeof raw.openUrlViaExtension === 'boolean') {
    jump.openUrlViaExtension = raw.openUrlViaExtension;
  } else if (raw.openUrlViaExtension !== undefined) {
    warn(`任务 ${taskId}: jump.openUrlViaExtension 应为布尔值，已忽略`);
  }

  if (raw.terminal !== undefined) {
    if (!isPlainObject(raw.terminal)) {
      warn(`任务 ${taskId}: jump.terminal 不是对象，已忽略（点击跳转会走 explorer 兜底）`);
    } else if (raw.terminal.type === 'windowProcess') {
      const names = (readStringArray(raw.terminal.processNames) ?? []).map((name) => name.trim()).filter(Boolean);
      if (names.length === 0) {
        warn(`任务 ${taskId}: windowProcess.processNames 必须包含进程名，已忽略定位`);
      } else {
        jump.terminal = {
          type: 'windowProcess',
          processNames: names,
          ...(typeof raw.terminal.titleContains === 'string' && raw.terminal.titleContains.trim()
            ? { titleContains: raw.terminal.titleContains.trim() } : {}),
        };
      }
    } else if (raw.terminal.type === 'windowTitle') {
      if (typeof raw.terminal.match === 'string' && raw.terminal.match.length > 0) {
        const wj: { type: 'windowTitle'; match: string; processNames?: string[] } = {
          type: 'windowTitle',
          match: raw.terminal.match,
        };
        // 可选进程名过滤：区分"原生客户端窗口"与"浏览器里的同名页面"
        const procs = readStringArray(raw.terminal.processNames);
        if (procs !== undefined) wj.processNames = procs;
        jump.terminal = wj;
      } else {
        warn(`任务 ${taskId}: jump.terminal.match 缺失，已忽略 windowTitle 定位`);
      }
    } else if (raw.terminal.type === 'spawn') {
      if (typeof raw.terminal.cmd === 'string' && raw.terminal.cmd.length > 0) {
        jump.terminal = {
          type: 'spawn',
          cmd: raw.terminal.cmd,
          args: readStringArray(raw.terminal.args) ?? [],
        };
      } else {
        warn(`任务 ${taskId}: jump.terminal.cmd 缺失，已忽略 spawn 定位`);
      }
    } else if (raw.terminal.type === 'none') {
      jump.terminal = { type: 'none' };
    } else {
      warn(
        `任务 ${taskId}: jump.terminal.type 非法（${String(raw.terminal.type)}），合法值 windowTitle/windowProcess/spawn/none，已忽略`,
      );
    }
  }
  return jump;
}

/* ============================================================================
 * 顶层校验（纯函数，vitest 可直接验证）
 * ==========================================================================*/

/**
 * 展开字符串里的环境变量占位符。
 *
 * 【为什么需要 —— 这是实测踩过的坑】
 * 用户配置里习惯写 `%USERPROFILE%/.workbuddy/logs/*.log`，
 * 但 Node 的 fs / glob API **不会**展开它。不处理的话，
 * glob 会拿着字面量 `%USERPROFILE%/...` 去匹配 → 0 个文件，
 * 而且**不报任何错**（静默失效，最难排查的一种）。
 *
 * 支持两种语法：
 *   - `%NAME%`            Windows 风格
 *   - `$NAME` / `${NAME}`  POSIX 风格
 *
 * 未定义的变量替换为空串（与 shell 一致），避免路径里残留 "%FOO%" 噪声。
 */
export function expandEnvVars(input: string): string {
  return input
    .replace(/%([^%\s]+)%/g, (_whole, name: string) => process.env[name] ?? '')
    .replace(/\$\{([^}]+)\}/g, (_whole, name: string) => process.env[name] ?? '')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name: string) =>
      process.env[name] === undefined ? whole : process.env[name]!,
    );
}

/** 递归展开对象/数组里所有字符串值（含 key）。带循环引用保护。 */
function expandDeep(node: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof node === 'string') {
    return expandEnvVars(node);
  }
  if (Array.isArray(node)) {
    return node.map((item) => expandDeep(item, seen));
  }
  if (isPlainObject(node)) {
    if (seen.has(node)) {
      return node;
    }
    seen.add(node);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      out[expandEnvVars(k)] = expandDeep(v, seen);
    }
    return out;
  }
  return node;
}

/**
 * 校验并合并默认值。
 *
 * **不抛异常**：任何非法项都只产生一条 warning，其余部分照常生效（PRD P0-7）。
 * 只有 YAML 语法错误才由 parseYaml 抛出 ConfigSyntaxError。
 */
export function validateConfig(raw: unknown): ValidationOutcome {
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);

  if (!isPlainObject(raw)) {
    return {
      config: emptyConfig(warnings),
      warnings: ['配置根节点不是对象/为空，已使用全默认配置', ...warnings],
    };
  }

  // 统一展开环境变量后再校验各段。
  // 顺序很关键：若放在校验之后，路径里的 %VAR% 会被当成合法字符放过，
  // 最终 glob 匹配 0 个文件却毫无提示（这正是实测遇到的静默失效）。
  // 用局部变量承接结果，避免丢掉 isPlainObject 带来的类型收窄。
  const expanded = expandDeep(raw);
  const cfgObj = isPlainObject(expanded) ? expanded : {};

  const app = validateApp(cfgObj.app, warn);
  const lamp = validateLamp(cfgObj.lamp, warn);
  const notify = validateNotify(cfgObj.notify, warn);
  const defaults = validateDefaults(cfgObj.defaults, warn);

  const tasks: TaskConfig[] = [];
  const seenIds = new Set<string>();
  if (cfgObj.tasks !== undefined && !Array.isArray(cfgObj.tasks)) {
    warn('tasks 段不是数组，已忽略全部任务');
  } else if (Array.isArray(cfgObj.tasks)) {
    cfgObj.tasks.forEach((item, index) => {
      if (!isPlainObject(item)) {
        warn(`tasks[${index}] 不是对象，已丢弃`);
        return;
      }
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      if (!id) {
        warn(`tasks[${index}].id 缺失或为空，已丢弃`);
        return;
      }
      if (seenIds.has(id)) {
        warn(`任务 id 重复（${id}），已丢弃后一条`);
        return;
      }
      const monitor = validateMonitor(item.monitor, id, warn);
      if (!monitor) {
        return;
      }
      seenIds.add(id);
      const task: {
        id: string;
        name: string;
        enabled: boolean;
        monitor: MonitorConfig;
        jump: JumpConfig | undefined;
        shortLabel?: string;
      } = {
        id,
        name: typeof item.name === 'string' && item.name.length > 0 ? item.name : id,
        enabled: readBool(item.enabled, true),
        monitor,
        jump: validateJump(item.jump, id, warn),
      };
      // 灯带短标签：显式配置优先于"从端口号推导"
      if (typeof item.shortLabel === 'string' && item.shortLabel.trim().length > 0) {
        task.shortLabel = item.shortLabel.trim();
      } else if (item.shortLabel !== undefined && typeof item.shortLabel !== 'string') {
        warn(`任务 ${id}: shortLabel 应为字符串，已忽略（将按监控类型推导）`);
      }
      tasks.push(task);
    });
  }

  const version = typeof cfgObj.version === 'number' ? cfgObj.version : 1;
  if (version !== 1) {
    warn(`配置 version=${version}，当前实现按 v1 解析（未知字段将被忽略）`);
  }

  return {
    config: { version, app, lamp, notify, tasks, defaults },
    warnings,
  };
}

/** 全默认配置（配置文件不存在 / 损坏时的兜底）。 */
export function emptyConfig(extraWarnings: string[] = []): AppConfig {
  void extraWarnings;
  return {
    version: 1,
    app: { ...DEFAULT_APP_SETTINGS },
    lamp: { ...DEFAULT_LAMP_SETTINGS },
    notify: {
      ...DEFAULT_NOTIFY_SETTINGS,
      actions: DEFAULT_NOTIFY_SETTINGS.actions.map((a) => ({ ...a })),
    },
    tasks: [],
    defaults: {
      stateTimeout: { ...DEFAULT_STATE_TIMEOUT },
      colors: { ...DEFAULT_COLOR_OVERRIDES },
    },
  };
}

/** YAML 文本 -> AppConfig。语法错误抛 ConfigSyntaxError（调用方保留旧配置）。 */
export function parseConfigText(text: string): ValidationOutcome {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    throw new ConfigSyntaxError(
      `YAML 语法错误：${(err as Error).message}`,
      err,
    );
  }
  return validateConfig(parsed);
}

/* ============================================================================
 * 读写与热重载
 * ==========================================================================*/

/** 最小日志接口（避免本模块反向依赖 logger/electron）。 */
export interface ConfigLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * 配置文件管理器：负责加载、备份写入、热重载监听。
 * 与纯函数 `validateConfig` 分离，便于单测只测纯逻辑。
 */
export class ConfigManager {
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private cachedConfig: AppConfig | null = null;
  private cachedPath: string;
  /**
   * 应用最近一次写盘的内容。
   *
   * 用来分辨"这次文件变化是不是我自己写的"（见 `isSelfWrite`）——
   * 否则写回位置之后必然收到一次自回声式的「配置已重载」提示。
   */
  private lastWrittenText: string | null = null;

  constructor(
    configPath: string,
    private readonly logger: ConfigLogger,
    /** 项目内config.example.yaml 的位置，用于首次运行落盘模板。 */
    private readonly examplePath: string,
  ) {
    this.cachedPath = configPath;
  }

  get path(): string {
    return this.cachedPath;
  }

  get config(): AppConfig {
    if (!this.cachedConfig) {
      throw new Error('ConfigManager 尚未 load()');
    }
    return this.cachedConfig;
  }

  /** 切换配置路径（托盘「打开配置文件」定位用）。 */
  setPath(next: string): void {
    this.cachedPath = next;
  }

  /**
   * 加载配置。
   * @returns 校验后的配置；文件不存在时先落盘模板再返回全默认配置。
   */
  load(): ValidationOutcome {
    const filePath = this.cachedPath;

    if (!fs.existsSync(filePath)) {
      this.logger.warn(`配置文件不存在：${filePath}`);
      this.writeTemplate(filePath);
      const outcome = validateConfig(undefined);
      this.cachedConfig = outcome.config;
      return outcome;
    }

    const text = fs.readFileSync(filePath, 'utf8');
    const outcome = parseConfigText(text);
    this.cachedConfig = outcome.config;
    for (const w of outcome.warnings) {
      this.logger.warn(`配置项降级：${w}`);
    }
    return outcome;
  }

  /** 首次运行时把 config.example.yaml 复制到用户配置路径。 */
  private writeTemplate(target: string): void {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (fs.existsSync(this.examplePath)) {
        fs.copyFileSync(this.examplePath, target);
        this.logger.info(`已生成默认配置：${target}`);
      } else {
        fs.writeFileSync(target, DEFAULT_CONFIG_TEXT, 'utf8');
        this.logger.info(`已生成内置默认配置：${target}`);
      }
    } catch (err) {
      // 落盘失败不能阻断启动：用内存默认值继续跑，并提示用户手动创建。
      this.logger.error(`生成默认配置失败（${target}）：${(err as Error).message}`);
    }
  }

  /**
   * 写回配置（拖动灯位置、切换开关时用）。
   * **写前备份**（架构 §8.6）。
   */
  update(mutator: (config: AppConfig) => AppConfig): AppConfig {
    const current = this.cachedConfig ?? emptyConfig();
    const next = mutator(current);
    this.cachedConfig = next;
    this.persist(next);
    return next;
  }

  private persist(config: AppConfig): void {
    const target = this.cachedPath;
    try {
      const text = stringifyYaml(config, { indent: 2 });

      /*
       * ★ 内容没变就**不写盘** —— 这道闸是必须的。
       *
       * 【为什么】文件监听器只看"文件被写过"，分辨不出是谁写的。于是
       * 「写回 -> 监听器醒来 -> 判定配置变了 -> 弹「配置已重载」」会自己咬自己：
       * 实测用户每拖一次灯（改尺寸同样会触发 moved）就收到一条毫无意义的提示，
       * 日志里 25 分钟出现 34 次写回 + 37 次重载。
       *
       * 值没变时连备份都不做 —— 没变化就没有可备份的东西。
       */
      let current: string | null = null;
      try {
        current = fs.readFileSync(target, 'utf8');
      } catch {
        current = null; // 首次写盘（文件还不存在）
      }
      if (current === text) {
        return;
      }

      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (current !== null) {
        fs.copyFileSync(target, `${target}${CONFIG_BACKUP_SUFFIX}`);
      }
      fs.writeFileSync(target, text, 'utf8');
      // 记下"这份内容是我自己写的"，供 isSelfWrite() 分辨自回声
      this.lastWrittenText = text;
      this.logger.info(`配置已写回：${target}`);
    } catch (err) {
      this.logger.error(`配置写回失败（${target}）：${(err as Error).message}`);
    }
  }

  /**
   * 磁盘上的内容是否就是应用自己刚写下去的（"自回声"）。
   *
   * 【为什么要分辨】写回位置/托盘开关之后，文件监听器**必然**醒来并触发一次
   * 热重载 —— 那是应用自己的动作，不该弹「配置已重载」打扰用户。
   * 那条提示的意义是"用户改了配置文件，我读到了"，只该为真实的用户改动出现。
   *
   * 判据刻意用**内容相等**而不是"距上次写盘 N 毫秒内"：时间窗口既可能误伤
   * （用户恰好在这一秒里改了文件，提示被吞掉），也可能漏判（系统卡顿导致
   * 监听器迟到）。内容相等没有歧义 —— 磁盘上就是我自己写的那一份，说明没人动过。
   */
  isSelfWrite(): boolean {
    if (this.lastWrittenText === null) {
      return false;
    }
    try {
      return fs.readFileSync(this.cachedPath, 'utf8') === this.lastWrittenText;
    } catch {
      return false;
    }
  }

  /**
   * 监听配置文件变化（PRD P1-2，5s 内生效）。
   *
   * @param onChange 回调。**语法错误时不会被调用**，而是走 onError，
   *                这样调用方可以「保留旧配置 + 气泡提示」，状态机与监控器完全不动。
   */
  watch(onChange: (outcome: ValidationOutcome) => void, onError: (err: Error) => void): void {
    this.unwatch();
    if (!fs.existsSync(this.cachedPath)) {
      return;
    }
    try {
      this.watcher = fs.watch(this.cachedPath, () => {
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          try {
            const text = fs.readFileSync(this.cachedPath, 'utf8');
            const outcome = parseConfigText(text);
            // 语法 OK 才替换缓存；语义非法项已在 validateConfig 内降级 + warning。
            this.cachedConfig = outcome.config;
            for (const w of outcome.warnings) {
              this.logger.warn(`配置热重载降级：${w}`);
            }
            onChange(outcome);
          } catch (err) {
            // 语法错误 -> 保留旧配置（this.cachedConfig 未被触碰）
            onError(err as Error);
          }
        }, CONFIG_WATCH_DEBOUNCE_MS);
      });
      this.logger.info(`已监听配置文件变化：${this.cachedPath}`);
    } catch (err) {
      this.logger.warn(`监听配置文件失败（${this.cachedPath}）：${(err as Error).message}`);
    }
  }

  unwatch(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.watcher?.close();
    this.watcher = null;
  }

  dispose(): void {
    this.unwatch();
  }
}

/* ============================================================================
 * 内置兜底模板
 * ==========================================================================*/

/**
 * 内置的最小可用配置文本。
 * 仅在项目内config.example.yaml 缺失时使用（例如打包后 asar 里没带）。
 * 刻意保持极简：三个任务分别是 process/log/webhook 三种监控方式。
 */
export const DEFAULT_CONFIG_TEXT = `# AI 任务指示灯 — 内置兜底配置（完整示例见项目根目录 config.example.yaml）
version: 1

app:
  startMinimized: true
  autoLaunch: false
  pollIntervalMs: 3000
  hookPort: 17890

lamp:
  enabled: true
  x: -1
  y: 60
  size: 28
  opacity: 0.92
  alwaysOnTop: true
  showBadge: true

notify:
  popup: true
  sound: true
  debounceMs: 30000
  notifyStates: [waiting, success, failed]

tasks: []

defaults:
  stateTimeout:
    startTimeoutMs: 10000
    staleTimeoutMs: 60000
    waitingTimeoutMs: 1800000
    dismissAfterMs: 600000
`;

/** 供 electron-builder 的 extraResources / 开发脚本引用。 */
export { CONFIG_EXAMPLE_FILE_NAME };
