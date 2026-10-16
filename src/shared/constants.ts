/**
 * 全局常量 —— 状态色 / 优先级 / 超时默认值 / 文案的**单一来源**。
 *
 * 依赖: 仅 `import type` 引用 shared/types.ts（编译期擦除，运行时常量模块零依赖）。
 *
 * 【强制约定】架构 §8.1：状态色只在本文件定义一次，其他文件一律 import，禁止硬编码色值。
 */

import type {
  AppSettings,
  ColorOverrides,
  LampSettings,
  NotifyActionConfig,
  NotifySettings,
  StateTimeoutDefaults,
  TaskStatus,
} from './types';

/* ============================================================================
 * 状态颜色与优先级
 * ==========================================================================*/

/** PRD §5.1 视觉规范逐字色值 —— 全项目唯一色值来源。 */
export const STATUS_COLOR: Readonly<Record<TaskStatus, string>> = Object.freeze({
  idle: '#6B7280', // 灰
  starting: '#93C5FD', // 淡蓝
  running: '#3B82F6', // 蓝
  waiting: '#F59E0B', // 黄
  success: '#22C55E', // 绿
  failed: '#EF4444', // 红
  unknown: '#4B5563', // 深灰
});

/**
 * 聚合托盘灯优先级 + 面板列表排序（PRD §5.2 / §7.3）。
 * failed > waiting > running > success > starting > idle > unknown
 * 注：列表排序里 unknown 排在 idle 之前（失联比空闲更需关注）；
 *     托盘聚合时 unknown 与 idle 同级灰（见 computeAggregate 的取用方式）。
 */
export const STATUS_PRIORITY: readonly TaskStatus[] = Object.freeze([
  'failed',
  'waiting',
  'running',
  'success',
  'starting',
  'idle',
  'unknown',
] as const);

/** 状态 -> 面板展示文案（中文，PRD §7.3 面板样式）。 */
export const STATUS_LABEL: Readonly<Record<TaskStatus, string>> = Object.freeze({
  idle: '空闲',
  starting: '启动中',
  running: '运行中',
  waiting: '等待授权',
  success: '已完成',
  failed: '失败',
  unknown: '失联',
});

/** 状态 -> 面板左侧标记字符（PRD §7.3：✕/▶/⏸/✓/⬤）。 */
export const STATUS_ICON: Readonly<Record<TaskStatus, string>> = Object.freeze({
  idle: '○',
  starting: '◌',
  running: '▶',
  waiting: '⏸',
  success: '✓',
  failed: '✕',
  unknown: '?',
});

/** 状态 -> CSS 动画类后缀（PRD §5.1：常亮/慢呼吸/快闪/绿闪/双闪）。 */
export const STATUS_ANIMATION: Readonly<Record<TaskStatus, string>> = Object.freeze({
  idle: 'anim-steady',
  starting: 'anim-breathe-slow',
  running: 'anim-breathe',
  waiting: 'anim-blink-fast',
  success: 'anim-flash-once',
  failed: 'anim-alarm',
  unknown: 'anim-steady',
});

/** 数值越小越优先，与 STATUS_PRIORITY 同序。 */
export function statusRank(status: TaskStatus): number {
  const idx = STATUS_PRIORITY.indexOf(status);
  return idx === -1 ? STATUS_PRIORITY.length : idx;
}

/**
 * 计算聚合态：取所有**非暂停**任务里优先级最高的那个。
 * 全部为 idle/unknown 时返回 idle（灰），符合 PRD §5.2「全部空闲 → 灰」。
 */
export function computeAggregate(statuses: readonly TaskStatus[]): TaskStatus {
  if (statuses.length === 0) {
    return 'idle';
  }
  const present = new Set<TaskStatus>(statuses);
  for (const candidate of STATUS_PRIORITY) {
    if (candidate === 'unknown') {
      continue; // unknown 与 idle 同级灰，统一落到 idle 分支
    }
    if (present.has(candidate)) {
      return candidate;
    }
  }
  return 'idle';
}

/** 按 STATUS_PRIORITY 对任务排序（稳定排序，同级保持配置顺序）。 */
export function sortByStatus<T extends { status: TaskStatus }>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const diff = statusRank(a.item.status) - statusRank(b.item.status);
      return diff !== 0 ? diff : a.index - b.index;
    })
    .map((entry) => entry.item);
}

/* ============================================================================
 * 超时默认值（架构 §8.2，可被 YAML defaults 覆盖）
 * ==========================================================================*/

export const DEFAULT_STATE_TIMEOUT: Readonly<StateTimeoutDefaults> = Object.freeze({
  startTimeoutMs: 10_000, // PRD §5.4 start_timeout
  staleTimeoutMs: 60_000, // PRD §5.4 stale_timeout（防灯一直是绿的）
  waitingTimeoutMs: 1_800_000, // 30min，waiting 悬挂保护
  dismissAfterMs: 600_000, // 10min，已完成任务自动清理
});

export const DEFAULT_POLL_INTERVAL_MS = 3_000; // PRD app.pollIntervalMs
export const DEFAULT_NOTIFY_DEBOUNCE_MS = 30_000; // PRD P1-5
export const DEFAULT_IDLE_AFTER_SILENCE_MS = 60_000; // PRD P0-9
export const DEFAULT_HOOK_PORT = 17_890; // PRD P1-1
export const DEFAULT_START_END_BYTES = 65_536; // 64KB 首次 tail
export const DEFAULT_EXIT_GRACE_MS = 3_000; // 进程消失后的判定宽限
export const DEFAULT_ON_DEMAND_INTERVAL_MS = 10_000; // process onDemand 模式的轮询间隔

/* ============================================================================
 * 应用级默认值
 * ==========================================================================*/

export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = Object.freeze({
  startMinimized: true,
  autoLaunch: false,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  locale: 'zh-CN',
  processPollMode: 'resident',
  hookPort: DEFAULT_HOOK_PORT,
});

export const DEFAULT_LAMP_SETTINGS: Readonly<LampSettings> = Object.freeze({
  enabled: true,
  x: -1, // -1 = 首次运行未设置，落默认位置
  y: 60,
  size: 28,
  opacity: 0.92,
  alwaysOnTop: true,
  showBadge: true,
  clickThrough: false,
  resetOnSuccess: true,
});

export const DEFAULT_NOTIFY_STATES: TaskStatus[] = [
  'waiting',
  'success',
  'failed',
];

export const DEFAULT_NOTIFY_SETTINGS: Readonly<NotifySettings> = Object.freeze({
  popup: true,
  sound: true,
  soundOnlyOnFailure: false,
  debounceMs: DEFAULT_NOTIFY_DEBOUNCE_MS,
  notifyStates: DEFAULT_NOTIFY_STATES,
  doNotDisturbOnFullscreen: true,
  actions: Object.freeze([
    Object.freeze({ id: 'focus_terminal' as const, label: '打开终端' }),
    Object.freeze({ id: 'open_log' as const, label: '打开日志' }),
    Object.freeze({ id: 'open_dir' as const, label: '打开目录' }),
  ]) as NotifyActionConfig[],
});

/** PRD §6 defaults.colors 的默认值即 STATUS_COLOR（此处仅用于 mergeDefaults 的兜底）。 */
export const DEFAULT_COLOR_OVERRIDES: Readonly<ColorOverrides> = Object.freeze({});

/* ============================================================================
 * 托盘图标与字模
 * ==========================================================================*/

/** 托盘图标基准边长（Windows 托盘按 DPI 缩放，主图 16px + @2x 32px）。 */
export const TRAY_ICON_SIZES: readonly number[] = Object.freeze([16, 32] as const);

/** 徽标显示上限：超过 99 显示 '+'（PRD §7.1「1~99+」）。 */
export const BADGE_MAX = 99;

/** 徽标最小显示位数（running=0 时不显示徽标，见 PRD P0-5）。 */
export const BADGE_MIN_SHOW = 1;

/* ============================================================================
 * HTTP 安全（架构 §4.4）
 * ==========================================================================*/

export const HOOK_BODY_LIMIT_BYTES = 64 * 1024; // 超限返回 413
export const HOOK_TOKEN_HEADER = 'x-indicator-token';
export const LOOPBACK_HOST = '127.0.0.1';

/**
 * 浏览器扩展桥接端口（决策 D73 路线②）。
 *
 * 【为什么是固定端口而不是配置项】扩展侧也硬编码同一个端口，
 * 做成配置项反而要求用户同时改两处；固定常量让"装一次、两端对齐"。
 * 与 hookPort（17890）相邻但不同，避免和 webhook 抢端口。
 */
export const EXTENSION_BRIDGE_PORT = 17_891;

/**
 * 扩展桥接请求必须携带的标记头。
 *
 * 【为什么需要它 —— 防网页 CSRF】桥接端点没有 token，任何本地进程都能调；
 * 但网页 fetch 想带**自定义头**会先发预检请求，而桥接不返回任何 CORS 头，
 * 预检必然失败 —— 于是普通网页无法伪造请求。扩展在 host_permissions
 * 授权下不受 CORS 约束，可以正常带上该头。
 */
export const EXTENSION_BRIDGE_HEADER = 'x-indicator-extension';

/* ============================================================================
 * 进程与 focus（POC §2.2 / §6）
 * ==========================================================================*/

/** 所有 spawn 的统一超时：超时只记日志，不抛到 UI（POC §6 / PRD P0-7）。 */
export const SPAWN_TIMEOUT_MS = 5_000;

/**
 * Win32 无效句柄哨兵。
 *
 * 【重要】0 号 HWND 是**有效的桌面窗口**（不是哨兵），本项目不使用它做任何判定；
 * 仅用于「spawn 出来的子进程 pid 无效」这一场景的显式校验，避免误判。
 */
export const INVALID_HANDLE = 0;

/** Windows Terminal 的窗口类名（POC §2.1：比进程名可靠）。 */
export const WT_WINDOW_CLASS = 'CASCADIA_HOSTING_WINDOW_CLASS';

/** 判定属于「终端类宿主」的进程名（POC §2.1：用户终端可能落在多种宿主上）。 */
export const TERMINAL_PROCESS_NAMES: readonly string[] = Object.freeze([
  'windowsterminal.exe',
  'wt.exe',
  'powershell.exe',
  'pwsh.exe',
  'cmd.exe',
  'conhost.exe',
  'openconsole.exe',
  'mobaxterm.exe',
  'securecrt.exe',
]);

/** L2 层 PowerShell 聚焦脚本使用的窗口类/进程名兜底顺序。 */
export const FOCUS_LEVELS = Object.freeze({
  SPAWN: 'L1',
  WINDOW_FOCUS: 'L2',
  EXPLORER: 'L3',
  NOTEPAD: 'L4',
  NONE: 'L5-none',
} as const);

/* ============================================================================
 * 监控器运行时（POC §8）
 * ==========================================================================*/

/** 长驻 PowerShell 子进程的重启退避序列（毫秒），上限 30s，最多 MAX_RESTART 次。 */
export const RESTART_BACKOFF_MS: readonly number[] = Object.freeze([
  1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
]);

/** 超过该重启次数仍失败 -> 任务转 unknown 并托盘气泡告警（POC §8）。 */
export const MAX_RESTART_ATTEMPTS = 5;

/** 长驻 PS 的默认进程枚举间隔（毫秒）。 */
export const DEFAULT_PROCESS_POLL_MS = 3_000;

/** 配置热重载 debounce（PRD P1-2：5s 内生效；300ms 去抖合并编辑器连续写）。 */
export const CONFIG_WATCH_DEBOUNCE_MS = 300;

/** 灯位置写回配置的 debounce（架构 §1.3）。 */
export const LAMP_POSITION_DEBOUNCE_MS = 500;

/**
 * 停靠形态判定的 debounce（比位置写回短得多）。
 *
 * `moved` 在拖动过程中高频触发；每帧改窗口尺寸会让拖动发抖。
 * 等手停下来 ~160ms 再定型，既不抖也不觉得迟钝。
 * 与位置写回分开计时：形态要"跟手"，落盘可以慢。
 */
export const LAMP_DOCK_DEBOUNCE_MS = 160;

/** 暂停监控时长（PRD §7.2 托盘菜单：暂停 30min）。 */
export const PAUSE_DURATION_MS = 30 * 60 * 1000;

/* ============================================================================
 * 日志
 * ==========================================================================*/

export const LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error'] as const);
export type LogLevel = (typeof LOG_LEVELS)[number];

/** 日志保留天数（架构 §8.4）。 */
export const LOG_RETENTION_DAYS = 7;

/* ============================================================================
 * 文件与路径
 * ==========================================================================*/

/** 配置文件名与默认目录名（PRD §6 / 架构 D7）。 */
export const CONFIG_DIR_NAME = '.ai-task-indicator';
export const CONFIG_FILE_NAME = 'config.yaml';
export const CONFIG_BACKUP_SUFFIX = '.bak';
export const CONFIG_EXAMPLE_FILE_NAME = 'config.example.yaml';

/** IPC 标记：渲染层 HTML 上用 data-* 标注自己是谁，便于 preload 区分 overlay / panel。 */
export const WINDOW_ROLE_ATTR = 'data-indicator-role';
export type WindowRole = 'overlay' | 'panel';
