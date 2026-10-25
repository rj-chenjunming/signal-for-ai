/**
 * 全量共享类型定义 —— 主进程 / preload / 渲染层 三方共用的唯一类型来源。
 *
 * 依赖: 无（纯类型，编译期擦除）。渲染层可用 `import type` 引用，运行时不产生依赖。
 *
 * 字段命名约定（架构 §8.3）：
 *   - 配置文件字段保持 snake_case 风格且与 PRD §6 YAML 逐字一致（如 `cmdlineContains`、`staleTimeoutMs`）
 *   - TS 类型/接口 PascalCase，变量/函数 camelCase，常量 SCREAMING_SNAKE
 */

/* ============================================================================
 * 状态枚举与基础类型
 * ==========================================================================*/

/** PRD §5.1 七态枚举，顺序即声明顺序，聚合优先级另见 constants.ts 的 STATUS_PRIORITY。 */
export type TaskStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'success'
  | 'failed'
  | 'unknown';

/** 三类监控方式（PRD P0-8 / P0-9 / P1-1）。 */
export type MonitorType = MonitorConfig['type'];

/** 七态全集，遍历/校验用。 */
export const ALL_TASK_STATUSES: readonly TaskStatus[] = [
  'idle',
  'starting',
  'running',
  'waiting',
  'success',
  'failed',
  'unknown',
] as const;

/** 判断任意字符串是否为合法 TaskStatus（外部输入校验，如 webhook payload）。 */
export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (ALL_TASK_STATUSES as readonly string[]).includes(value);
}

/* ============================================================================
 * 监控配置（对应 PRD §6 YAML schema）
 * ==========================================================================*/

/** 三类监控器共享的可选字段，缺省值取 defaults.stateTimeout。 */
export interface MonitorConfigBase {
  /** 信号静默多久后转 unknown（PRD §5.4 stale_timeout，默认 60000）。 */
  staleTimeoutMs?: number;
  /** starting 态持续多久无新信号自动回 idle（PRD §5.4 start_timeout，默认 10000）。 */
  startTimeoutMs?: number;
  /** 事件去抖间隔，避免日志高频命中规则时刷屏。 */
  debounceMs?: number;
}

/** 进程匹配规则：processNames 与 cmdlineContains 之间为「与」，多组之间为「或」。 */
export interface ProcessMatchRule {
  /** 进程名（不含路径，大小写不敏感比较），如 ["node.exe", "workbuddy.exe"]。 */
  processNames: string[];
  /** 命令行需同时包含的全部子串（大小写不敏感）；不填则只比进程名。 */
  cmdlineContains?: string[];
}

/** 进程消失后的结果判定（PRD §6 onExit）。 */
export interface ProcessExitRule {
  /** 视作成功的退出码；不在此列表内的退出码判定为 failed。 */
  successExitCodes: number[];
  /** 进程消失后等多久再定状态（留出日志刷尾时间，默认 3000）。 */
  graceMs?: number;
}

/** 无匹配进程时的兜底信号源（PRD §6 fallbackLog，应对 node.exe 这类名字被复用的场景）。 */
export interface FallbackLogConfig {
  paths: string[];
  /** 日志出现新行时切到该状态。 */
  stateOnNewLine: TaskStatus;
}

export interface ProcessMonitorConfig extends MonitorConfigBase {
  type: 'process';
  /** 任一 match 命中即认为该任务存活。 */
  match: ProcessMatchRule[];
  onExit?: ProcessExitRule;
  fallbackLog?: FallbackLogConfig;
}

/** 日志正则规则：按数组顺序匹配，命中即返回该状态（failed 建议放最后但引擎会做优先级提升）。 */
export interface LogRule {
  state: TaskStatus;
  /** 正则字符串（用户书写），编译见 monitors/pattern.ts。 */
  match: string;
}

export interface LogMonitorConfig extends MonitorConfigBase {
  type: 'log';
  /** 支持 `**` 递归通配的路径列表。 */
  paths: string[];
  /** 目前仅支持 'tail'（增量读），字段保留以便未来支持 'full'。 */
  readMode?: 'tail';
  /** 首次接入只读文件末尾多少字节（默认 65536），避免全量重扫大文件。 */
  fromEndBytes?: number;
  rules: LogRule[];
  /** 静默超过此时长转 idle（PRD P0-9 idleAfterSilenceMs，默认 60000，防长尾误判）。 */
  idleAfterSilenceMs?: number;
}

export interface WebhookMonitorConfig extends MonitorConfigBase {
  type: 'webhook';
  /** 监听地址，强制 loopback（默认 127.0.0.1，PRD P1-1）。 */
  listen: string;
  /** 端点路径，形如 /hook/:taskId。 */
  path: string;
  /** 请求头 x-indicator-token 必须匹配；未配置则不做 token 校验（仅本机可用）。 */
  secret?: string;
  /** 从 JSON payload 提取字段的路径表达式（支持 `$.a.b` 语法）。 */
  fieldMap?: WebhookFieldMap;
  /** 心跳超时；超过此时长无推送则转 unknown（默认 120000）。 */
  heartbeatTimeoutMs?: number;
}

/** webhook payload 字段映射（PRD §6 fieldMap）。 */
export interface WebhookFieldMap {
  state: string;
  message?: string;
  progress?: string;
}

/**
 * dsh 多端口监控配置（新增监控类型，设计决策 D2/D4/D5）。
 *
 * 与 webhook 型的区别，以及为什么**两者都要**：
 *   - `webhook` 型是**被动的**：等 dsh 侧插件来推。信号精确（能拿到
 *     `pendingInteraction` 真值），但**要求插件已装**，且插件挂了就断。
 *   - `dsh` 型是**主动的**：自己枚举端口、自己签 cookie、自己调 RPC。
 *     零侵入 dsh、不依赖插件，覆盖所有实例（含远端隧道），
 *     但拿不到"等待授权"的**精确**信号，只能用 `plan.pending` 近似。
 *   - 决策 D2 的混合方案 = `dsh` 型打底 + `webhook` 型增强，插件失效自动退回。
 *
 * 典型配置（一个 dsh 型管所有端口 + 每个实例一条 webhook 兜精确信号）：
 * ```yaml
 * - id: dsh-port-3080
 *   name: dsh @3080
 *   monitor:
 *     type: dsh
 *     authority: 127.0.0.1:3080
 *     dshHome: "%USERPROFILE%/.dsh"     # 本机密钥来源
 *     sshHost: user@your-host  # 可选：隧道型实例的远端密钥来源
 * - id: dsh-port-13080
 *   name: dsh @13080（隧道）
 *   monitor:
 *     type: dsh
 *     authority: 127.0.0.1:13080
 *     sshHost: user@your-host
 * ```
 */
export interface DshMonitorConfig extends MonitorConfigBase {
  type: 'dsh';
  /**
   * 目标实例，形如 `127.0.0.1:3080`；cookie 名与签名都绑定它。
   *
   * 也可写 `auto`（SPEC-005）：自动发现本机**能用本机密钥认证**的实例。
   * 桌面端 dsh 每次启动都会换端口（3080 → 19387 → 52119 实测），写死会让灯
   * 在 dsh 重启后永久变灰。
   */
  authority: string;
  /** 本机 dsh 配置目录（含 `.credentials.yaml`），默认 `%USERPROFILE%/.dsh`。 */
  dshHome?: string;
  /**
   * 远端/隧道型实例的 SSH 主机（如 `user@host`）。
   * 本机密钥对隧道端口会 401（已实测），此时需要从远端取密钥。
   * 未配置则远端实例只做可达性探测。
   */
  sshHost?: string;
  /** 轮询间隔，默认 5000。 */
  intervalMs?: number;
  /** 单次 RPC 超时，默认 8000。 */
  timeoutMs?: number;
  /** 无插件时是否允许用 `plan.pending` 近似判 waiting（默认 true）。 */
  allowPlanPendingHeuristic?: boolean;
  /** 心跳超时；超过此时长无成功轮询则转 unknown（默认 120000）。 */
  heartbeatTimeoutMs?: number;
}

export interface SqliteMonitorConfig extends MonitorConfigBase {
  type: 'sqlite';
  /** 只把明确完成值计入完成水位，不能将任意非 active 状态判成成功。 */
  completedStatus?: string;
  /** 可覆盖数据源中的等待/失败状态名称；空数组禁用该类映射。 */
  waitingStatuses?: string[];
  failedStatuses?: string[];
  /**
   * 要查询的 SQLite 数据库文件（绝对路径）。
   *
   * 典型场景：WorkBuddy 把会话状态存在 `workbuddy.db` 的 `sessions` 表里，
   * 字段 `status` / `last_activity_at` 是**权威**的"有没有任务在跑"信号。
   */
  database: string;
  /** 轮询间隔，默认 5000。 */
  intervalMs?: number;
  /**
   * 「正在跑」的判定：`sessions.status` 等于该值，
   * **且** `last_activity_at` 在 `activeWithinMs` 之内。
   *
   * ⚠️ **两个条件缺一不可**。实测：库里有 `status='working'` 但
   * `last_activity_at` 已静默 20 小时的**遗留记录** —— 只看 status 会永远亮蓝。
   */
  activeStatus?: string;
  /** 视为"仍在活动"的静默窗口（毫秒），默认 120000（2 分钟）。 */
  activeWithinMs?: number;
  /**
   * 完成提醒的开关（默认 true）。
   *
   * 绿灯的**时长**不再由时间决定 —— 用户确认的形态是
   * 「执行完亮绿灯保持不动，点击后跳转并熄灭」，
   * 所以绿灯一直亮到用户点击（见 `TaskState.ackedCompletionAt` 的水位闸门）。
   *
   * 设 `false` 可关掉完成提醒（完成后直接回灰，不亮绿灯）。
   */
  notifyOnDone?: boolean;
  /**
   * 可选的"进程闸门"：只有匹配到该进程时，才认为监控对象存在。
   *
   * 用于实现你要求的三态语义：
   *   - 进程不在            -> `unknown`（浮窗会隐藏该行）
   *   - 进程在但无活跃会话  -> `idle`（灰）
   *   - 进程在且有活跃会话  -> `running`（蓝）
   *
   * 不配则省略闸门（数据库查得到就算存在）。
   */
  requireProcess?: ProcessMatchRule[];
  /** 数据库读取失败连续多少次后判 unknown（默认 3）。 */
  maxFailures?: number;
}

/** Codex 桌面/CLI 本地 rollout 的只读事件监控；不读取认证文件。 */
export interface CodexMonitorConfig extends MonitorConfigBase {
  type: 'codex';
  sessionsDir?: string;
  /** Optional sanitized events written by the trusted Codex status Hook. */
  approvalEventsFile?: string;
  intervalMs?: number;
  activeWithinMs?: number;
}

/**
 * ZCode 会话库（`~/.zcode/cli/db/db.sqlite`）的只读轮询监控（SPEC-041）。
 *
 * 只 SELECT 元数据列（session/tool_usage/turn_usage/model_usage 的状态与时间戳），
 * 不读 message/part 正文，不读 model-io 转储与凭据目录。
 */
export interface ZCodeMonitorConfig extends MonitorConfigBase {
  type: 'zcode';
  /** 会话库路径，默认 `%USERPROFILE%/.zcode/cli/db/db.sqlite`。 */
  dbPath?: string;
  /**
   * 按 `session.directory` 过滤的项目目录（归一化比较：大小写/分隔符不敏感）；
   * 空/缺省 = 全部项目聚合为一行。
   */
  projects?: string[];
  /** 轮询间隔，默认 3000。 */
  intervalMs?: number;
  /**
   * 开放回合/工具/模型请求仍视为运行中的新鲜窗（毫秒），默认 600000。
   * 分钟级窗口吸取 SPEC-030 教训：长工具执行期间会话可能不写库。
   */
  activeWithinMs?: number;
  /** 数据库读取失败连续多少次后判 unknown（默认 3）。 */
  maxFailures?: number;
}

export type MonitorConfig =
  | ProcessMonitorConfig
  | LogMonitorConfig
  | WebhookMonitorConfig
  | DshMonitorConfig
  | SqliteMonitorConfig
  | CodexMonitorConfig
  | ZCodeMonitorConfig;

/** 依据 `type` 字段做类型收窄的运行时分派器。 */
export function isProcessMonitor(cfg: MonitorConfig): cfg is ProcessMonitorConfig {
  return cfg.type === 'process';
}
export function isLogMonitor(cfg: MonitorConfig): cfg is LogMonitorConfig {
  return cfg.type === 'log';
}
export function isWebhookMonitor(cfg: MonitorConfig): cfg is WebhookMonitorConfig {
  return cfg.type === 'webhook';
}

/** dsh 多端口监控的类型收窄（与上方各守卫同风格）。 */
export function isDshMonitor(cfg: MonitorConfig): cfg is DshMonitorConfig {
  return cfg.type === 'dsh';
}

/** ZCode 会话库监控的类型收窄（与上方各守卫同风格）。 */
export function isZcodeMonitor(cfg: MonitorConfig): cfg is ZCodeMonitorConfig {
  return cfg.type === 'zcode';
}

/** SQLite 监控的类型收窄（WorkBuddy 任务态语义）。 */
export function isSqliteMonitor(cfg: MonitorConfig): cfg is SqliteMonitorConfig {
  return cfg.type === 'sqlite';
}

/* ============================================================================
 * 跳转配置（PRD §6 jump / §7.5）
 * ==========================================================================*/

/**
 * 终端跳转方式。
 * - windowTitle：按窗口标题定位**已有**窗口（POC §3 实测标题有重名歧义，仅作兜底）
 * - spawn：直接 spawn 指定命令（首选，零中间层开销，POC §6）
 * - none：不跳终端
 */
export type TerminalJump =
  | { type: 'windowProcess'; processNames: string[]; titleContains?: string }
  | {
      type: 'windowTitle';
      match: string;
      /**
       * ★ 可选：只匹配**这些进程**拥有的窗口（含 `.exe` 或省略都行，大小写不敏感）。
       *
       * 【为什么需要它 —— 实测踩到的坑】
       * 本机同时跑着 dsh 的**原生客户端**（`DeepSeek Harness.exe`，窗口标题
       * `… — DeepSeek Harness`）和**浏览器里的 dsh web**
       * （Chrome，窗口标题 `… — DeepSeek Harness - Google Chrome`）。
       *
       * 两者标题都含 `DeepSeek Harness`，于是按标题匹配会**切到 Chrome** ——
       * 用户看到的正是"点 dsh 却切到浏览器，而且切不到想要的标签"。
       * 加上进程名过滤才能精确锁定原生窗口。
       */
      processNames?: string[];
    }
  | { type: 'spawn'; cmd: string; args: string[] }
  | { type: 'none' };

export interface JumpConfig {
  terminal?: TerminalJump;
  /** 项目目录，用于 explorer.exe 兜底跳转。 */
  cwd?: string;
  /**
   * ★ 要打开的 **URL**（Web 界面）。
   *
   * 为什么需要它：`dsh` 这类任务的"界面"就是个网页
   * （`http://127.0.0.1:3080`）。而 `cwd` 兜底只会弹出资源管理器，
   * 完全到不了那个界面 —— 用户点了会觉得"没反应"。
   *
   * 只允许 `http` / `https` 两种协议（见 config.ts 的校验），
   * 避免被配置成 `file://` / 自定义协议处理程序造成意外行为。
   *
   * 优先级最高：显式配了 URL 就是明确意图，不再走窗口聚焦/目录兜底。
   */
  openUrl?: string;
  /**
   * ★ 浏览器窗口标题的匹配片段，用于**切到已打开的页面**而不是新开标签页。
   *
   * 【为什么需要它】只配 `openUrl` 时，每点一次都会**多一个新标签页**。
   * 实测用户反馈：「虽然点击有效 但是不是跳转页面 而是新增页面」。
   *
   * 配了本字段后，点击的顺序变成：
   *   1. 先按这个片段找**浏览器窗口**（Chrome 的窗口标题是
   *      `<页面标题> - Google Chrome`，所以页面标题的子串就能匹配上）
   *      → 找到就把它切到前台（不新开页面）
   *   2. 找不到才用 `openUrl` 新开
   *
   * 例如 dsh 的页面标题若含 "dsh"，就写 `openUrlTitleMatch: dsh`。
   * 不配则行为不变（总是新开）。
   */
  openUrlTitleMatch?: string;
  /**
   * ★ Chrome DevTools 远程调试 HTTP 端口，用于**精确切到已打开的标签页**。
   *
   * 【为什么需要它 —— 决策 D73 的边界终于被跨过】
   * `openUrlTitleMatch` 只能把浏览器**窗口**切到前台（Chrome 窗口标题只反映
   * 激活标签，切不到非激活标签）。配了这个端口后，点击会先通过 CDP 的
   * `GET /json/list` + `GET /json/activate/<id>` 精确激活目标 URL 所在的
   * **标签**（无论它是不是激活标签），只在拿不到时才退回标题匹配/新开。
   *
   * 【前提】Chrome 必须以 `--remote-debugging-port=<此端口>` 启动
   * （已运行的 Chrome 事后无法补开该端口）。端口不可达时**优雅降级**，
   * 不会报错、不会崩。
   *
   * 值域：1..65535 的整数。未配则跳过 CDP 路径。
   */
  openUrlDebugPort?: number;
  /**
   * ★ 通过本地浏览器扩展精确切到已打开的标签页（用你的**日常浏览器**）。
   *
   * 【为什么还要有它 —— 决策 D73 的路线②，也是 Chrome 139 之后的唯一可行路】
   * 路线①（CDP `openUrlDebugPort`）在 Chrome 136 之后被官方限制：默认用户数据
   * 目录下 `--remote-debugging-port` 被静默忽略，只能用在**专用调试实例**上，
   * 碰不到用户的主浏览器。扩展走 `chrome.tabs.update`，不受该限制。
   *
   * 打开后点击的顺序变成：
   *   1. 若本地扩展正在轮询（说明装了且活着）→ 让它把该 URL 的标签切到前台；
   *      扩展回报"找到了"才算成功（**不新开**）
   *   2. 扩展没装/没找到 → 退回 CDP / 标题匹配 / 新开
   *
   * 扩展本体与安装步骤见项目内 `extension/README.md`。不配置则完全不走这条路。
   */
  openUrlViaExtension?: boolean;
  /** 日志文件路径。 */
  logFile?: string;
  /** 用哪个程序打开日志（架构 A12：显式 notepad，不依赖系统文件关联）。 */
  openWith?: string;
}

/* ============================================================================
 * 任务定义与运行时状态
 * ==========================================================================*/

export interface TaskConfig {
  id: string;
  name: string;
  enabled: boolean;
  monitor: MonitorConfig;
  jump?: JumpConfig;
  /**
   * 灯带上显示的**短标签**（可选）。不配则按监控类型推导：
   * `dsh` 型取 authority 的端口号，其余取任务 id。
   *
   * 【为什么需要】`dsh` 型默认显示端口号，但端口号对人不总有意义 ——
   * 例如 dsh 桌面客户端的本地服务在 19387，用户心里叫它"本地客户端"，
   * 看到 `19387` 完全对不上号。这里让配置直接给一个可读的短名。
   *
   * 建议 ≤6 个汉字 / 12 个字符：灯带一行只有约 96px，超出会被省略号截断。
   */
  shortLabel?: string;
}

/** 任务运行时状态（TaskStore 持有的唯一真相）。 */
export interface TaskState {
  /** Confirmed desktop process presence; undefined for ungated sources. */
  processPresent?: boolean;
  taskId: string;
  /** 主进程推导的显示元数据；旧快照由渲染层兜底。 */
  toolKind?: 'codex' | 'dsh' | 'dsh-web' | 'workbuddy' | 'zcode' | 'generic';
  availableActions?: TaskAction[];
  name: string;
  status: TaskStatus;
  /** 最近一条信号携带的描述（webhook message / 命中的日志行摘要）。 */
  message?: string;
  /** 0..1，来自 webhook progress。 */
  progress?: number;
  /** 本轮任务开始时间（epoch ms）。 */
  startedAt?: number;
  /** 本轮任务结束时间（epoch ms），进入 success/failed 时写入。 */
  endedAt?: number;
  /** endedAt - startedAt，毫秒。 */
  durationMs?: number;
  /** 项目目录（从 jump.cwd 同步过来，面板直接展示）。 */
  cwd?: string;
  /** 最后一次收到任意信号的时间，用于 stale 判定（PRD US8）。 */
  lastSignalAt: number;
  /** success/failed 后未读标记（PRD P0-4）。 */
  unread: boolean;
  error?: string;
  /**
   * 运行时暂停（托盘「暂停监控」）。暂停中的任务不参与聚合。
   *
   * ⚠️ 与下面的 `enabled` 是**两件事**，不要混用：
   *   - `paused`  ：用户临时停掉监控（运行时，可随时恢复）
   *   - `enabled` ：配置里这个任务是否启用（来自 yaml，重启后仍是那个值）
   * 曾经把两者塞进同一个字段，导致"只改 enabled 不改名字"时
   * 热重载同步不到（syncTasks 把它写在 nameChanged 分支里）。
   */
  paused?: boolean;
  /**
   * 配置里该任务是否启用（`TaskConfig.enabled` 的运行时镜像）。
   *
   * 为什么运行时状态也要带这个：浮窗要按「配置禁用的任务不显示」过滤，
   * 而只在配置对象上查是拿不到的 —— store 里只有 TaskState。
   * 缺了它就会出现"明明 enabled:false，灯带上还挂着一行"。
   */
  enabled?: boolean;
  /**
   * 用户**已确认**的完成水位（点掉绿灯时的完成时刻）。
   *
   * sqlite 型是**轮询**的：点掉之后下一轮又会读到"有会话完成了"，
   * 于是绿灯立刻复亮 —— 点击等于没点。用这个水位做闸门：
   * 只有 `completionAt > ackedCompletionAt` 才算**新**完成、才亮绿灯。
   */
  ackedCompletionAt?: number;
  /**
   * 当前正在提醒的那次完成的水位。
   *
   * 与 `ackedCompletionAt` 配对：用户点掉时把本字段的值搬进
   * `ackedCompletionAt`，于是这个完成事件不再触发绿灯。
   */
  lastCompletionAt?: number;
  /**
   * 灯带上这一行显示的短标签（设计决策 D9）。
   *
   * 例：`dsh` 型任务取 authority 的端口号 → `3080`；其余任务退回 taskId。
   * 在 store 初始化时算一次即可 —— 渲染层拿不到 monitor 配置，
   * 而且 classic script 里也不该做这种解析。
   */
  portLabel?: string;
}

/** 写入 TaskStore 的补丁 —— store.apply() 是唯一写入口。 */
export interface TaskPatch {
  processPresent?: boolean;
  status?: TaskStatus;
  message?: string;
  progress?: number;
  error?: string;
  /** 本次变化是否构成「有效信号」（会刷新 lastSignalAt 并参与 stale 判定）。 */
  isSignal?: boolean;
  /** 显式指定 startedAt（process 监控器首次发现进程时对齐）。 */
  startedAt?: number;
  /**
   * 本次上报对应的**完成时刻**（仅 status==='success' 有意义）。
   *
   * store 用它和任务的 `ackedCompletionAt`（用户点掉时的水位）比较：
   * 若 `completionAt <= ackedCompletionAt`，说明这个完成事件**用户已经点过了**，
   * 直接丢弃 —— 绿灯不会再亮。这样"同一个完成"只提醒一次，
   * 而新任务完成（水位变大）会再次点亮。
   */
  completionAt?: number;
}

/** 一次状态变化记录，用于通知/日志。 */
export interface StateChange {
  taskId: string;
  from: TaskStatus;
  to: TaskStatus;
  at: number;
  /** 状态未变但快照有更新（如 message 变化）时为 true。 */
  mutated: boolean;
}

/** 供渲染层消费的完整快照（PRD §4.1）。 */
export interface Snapshot {
  /** 聚合态：failed > waiting > running > success > starting > idle > unknown。 */
  aggregate: TaskStatus;
  /** running 任务数（starting 也计入「在跑」，避免用户以为没开始）。 */
  runningCount: number;
  counts: Record<TaskStatus, number>;
  /** 已按 STATUS_PRIORITY 排好序的任务列表。 */
  tasks: TaskState[];
  /** 全局监控是否被暂停。 */
  paused: boolean;
  notify: { popup: boolean; sound: boolean };
  /** 每次变更自增，渲染层用于去重。 */
  version: number;
  /**
   * 目标摘要（SPEC-025）：悬浮灯据此渲染「目标」行。
   *
   * 为 undefined 表示当前没有进行中的目标（或目标功能未接入），
   * 此时浮窗不显示目标行，行为与本规格之前一致。
   */
  goalsSummary?: GoalsSummary;
  /**
   * 灯带模式（设计决策 D6）：**可显示**行数 ≥ 2 时为 true。
   *
   * 单行时退回经典的单灯形态（干扰最小）；多行时显示
   * 「总灯 + 每行一盏小灯 + 标签」，让"哪个实例出事了"一眼可见。
   * 由 store 判定，渲染层只负责照做 —— 保持渲染层无业务判断。
   *
   * ⚠️ 注意是**可显示**行数（不是配置里的任务数）：
   * 失联/失败的行会被隐藏（见下方 hiddenCount），若还剩不到 2 行，
   * 整窗就缩成一颗单灯。口径见 `shared/visibility.ts`。
   */
  stripMode: boolean;
  /**
   * 因「失联 / 失败」而被隐藏的行数。
   *
   * 产品原则：浮窗里出现的东西默认就该是活着的，所以 unknown/failed 的行
   * **不显示**。但"有几个不在"这个事实不该被完全抹掉 ——
   * 面板与 tooltip 用它说明「另有 N 个失联/失败」。
   */
  hiddenCount: number;
  /**
   * 实际需要在浮窗里渲染的任务（已按上面的规则过滤好）。
   *
   * 【为什么由主进程算好而不是渲染层自己过滤】
   * 渲染层是 **classic script（零 import）** —— 一旦 import 共享模块，
   * TS 会生成 `export {}`，页面变成模块脚本，直接白屏（项目既有约定）。
   * 所以"哪些行该显示"这条规则**只能有一份实现**，放在主进程，
   * 通过快照把结果推给渲染层。渲染层退化成"照着画"，不做业务判断。
   */
  displayTasks: TaskState[];
  /**
   * 悬浮灯当前是否鼠标穿透（设计决策 D10 的「锁定/穿透」）。
   *
   * 放进快照是为了让**托盘菜单**能反映并切换它：
   * 锁上之后浮窗完全不吃鼠标，盖在 IDE 上也不挡事。
   * 只暴露这一个字段，而不是整个 LampSettings —— 托盘用不到尺寸/透明度。
   */
  clickThrough: boolean;
}

/* ============================================================================
 * 浮窗停靠（拖到屏幕边缘 -> 点阵形态）
 * ==========================================================================*/

/**
 * 浮窗当前贴在哪条屏幕边缘。
 *
 * 语义：贴边后切换成**点阵形态** —— 只保留圆点，去掉后面的文字标签
 * （用户要求：「拖到侧边或顶部的时候变成一排信号灯，没有那些后面的信号描述」）。
 *
 * - `left` / `right`：竖排点阵
 * - `top`：横排点阵
 * - `none`：常规灯带（圆点 + 短标签，竖排）
 */
export type LampDock = 'none' | 'top' | 'left' | 'right';

/**
 * M→R：浮窗布局提示。
 *
 * 【为什么单独一条通道，而不是塞进 Snapshot】
 * 停靠方向取决于**窗口在屏幕上的位置**，而 Snapshot 是状态仓库（`TaskStore`）
 * 的产物 —— 它对窗口位置一无所知。更重要的是：渲染层按 `snapshot.version`
 * 去重，把布局塞进快照会让"位置变了但状态没变"的更新被吞掉。
 */
export interface LampLayout {
  dock: LampDock;
}

/* ============================================================================
 * 应用级配置（PRD §6 顶层）
 * ==========================================================================*/

export interface AppSettings {
  startMinimized: boolean;
  autoLaunch: boolean;
  pollIntervalMs: number;
  locale: string;
  /** process 监控模式：resident=长驻 PS 子进程（默认）；onDemand=按需 spawn（省内存但慢）。 */
  processPollMode: 'resident' | 'onDemand';
  /** webhook 接收端口（PRD P1-1 默认 17890）。 */
  hookPort: number;
  /**
   * dsh 配置目录（含 `.credentials.yaml`），默认 `%USERPROFILE%/.dsh`。
   * 支持 `%VAR%` / `${VAR}` / `$VAR` 展开（config.ts 的 expandEnvVars）。
   * 仅 `dsh` 型监控使用：用它取 browser-session 签名密钥。
   */
  dshHome?: string;
}

export interface LampSettings {
  enabled: boolean;
  x: number;
  y: number;
  size: number;
  opacity: number;
  alwaysOnTop: boolean;
  showBadge: boolean;
  clickThrough: boolean;
  resetOnSuccess: boolean;
}

/** 通知动作按钮定义（PRD §6 notify.actions / §7.4 最多 3 个）。 */
export interface NotifyActionConfig {
  id: NotifyActionId;
  label: string;
}

export interface NotifySettings {
  popup: boolean;
  sound: boolean;
  soundOnlyOnFailure: boolean;
  debounceMs: number;
  notifyStates: TaskStatus[];
  doNotDisturbOnFullscreen: boolean;
  actions: NotifyActionConfig[];
  /** 自定义提示音文件（P2-4）；未配置时用 Web Audio 合成。 */
  soundFile?: string;
}

/** 全局超时默认值，可被单任务覆盖（PRD §6 defaults.stateTimeout）。 */
export interface StateTimeoutDefaults {
  startTimeoutMs: number;
  staleTimeoutMs: number;
  waitingTimeoutMs: number;
  dismissAfterMs: number;
}

/** PRD §6 defaults.colors —— 允许用户覆盖状态色，默认值来自 constants.ts 的 STATUS_COLOR。 */
export type ColorOverrides = Partial<Record<TaskStatus, string>>;

export interface DefaultsSection {
  stateTimeout: StateTimeoutDefaults;
  colors: ColorOverrides;
}

/** 校验并合并默认值后的完整应用配置。 */
export interface AppConfig {
  version: number;
  app: AppSettings;
  lamp: LampSettings;
  notify: NotifySettings;
  tasks: TaskConfig[];
  defaults: DefaultsSection;
}

/* ============================================================================
 * IPC 载荷类型（配合 shared/ipc-contract.ts 使用）
 * ==========================================================================*/

/** 面板/通知可触发的任务动作（架构 §4.3 TaskAction）。 */
export type TaskAction =
  | 'focus_terminal'
  | 'open_log'
  | 'open_dir'
  | 'mark_read'
  | 'retry'
  | 'pause_task';

export interface TaskActionRequest {
  taskId: string;
  action: TaskAction;
  payload?: unknown;
}

export interface TaskActionResponse {
  ok: boolean;
  message?: string;
}

/** 通知按钮动作（架构 §4.3 NotifyActionId）。 */
export type NotifyActionId = 'focus_terminal' | 'open_log' | 'open_dir';

/** 音效播放指令（主进程 → 渲染层）。 */
export interface PlaySoundRequest {
  status: TaskStatus;
}

export interface ProbeTerminalResponse {
  wtAvailable: boolean;
}

/** focus 模块返回值（架构 §4.5 FocusResult）。 */
export interface FocusResult {
  ok: boolean;
  /** 实际生效的降级级别：L1/L2/L3/L4/L5-none。 */
  level: string;
  detail: string;
}

/* ============================================================================
 * 目标清单（SPEC-024）
 * ==========================================================================*/

/** 目标状态：进行中 / 已完成。只有两态，不引入暂停等运行态。 */
export type GoalStatus = 'active' | 'done';

/**
 * 时间线条目类型。
 *
 * - `progress` / `issue`：用户手动追加
 * - `done`：标记完成时由主进程自动追加（渲染层不能手动创建）
 */
export type GoalEntryKind = 'progress' | 'issue' | 'done';

/** 目标时间线中的一条记录（追加为主，可删除）。 */
export interface GoalEntry {
  id: string;
  /** epoch ms。 */
  at: number;
  kind: GoalEntryKind;
  /** 1..500 字符，已 trim；渲染层用 textContent 输出。 */
  text: string;
}

/** 一条目标（长期目标 / 备忘录条目）。 */
export interface Goal {
  id: string;
  /** 1..120 字符，已 trim。 */
  title: string;
  /** 0..100 整数，由用户手动调整。 */
  progress: number;
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
  /** 仅在 status === 'done' 时存在。 */
  completedAt?: number;
  /** 时间线，**最新在前**；渲染与导出都依赖这个顺序约定。 */
  entries: GoalEntry[];
}

/** 目标窗口渲染所需的完整视图（主进程唯一数据源）。 */
export interface GoalsView {
  goals: Goal[];
  /** 数据恢复/保存失败时的可关闭提示；无异常时缺省。 */
  warning?: string;
}

/**
 * 悬浮灯上的目标摘要（SPEC-025）。
 *
 * 只暴露渲染一行所需的聚合值，不把目标列表塞进快照：
 * 浮窗只需知道「有几个进行中、平均进度多少」。
 */
export interface GoalsSummary {
  /** 进行中的目标数（0 时浮窗不显示目标行）。 */
  active: number;
  /** 已完成的目标数（目前仅用于无障碍文案/调试）。 */
  done: number;
  /** 进行中目标的平均进度，0–100 整数；无进行中目标时为 0。 */
  progress: number;
}

/** 导出结果：取消与失败必须可区分，避免渲染层把取消当错误。 */
export interface GoalExportResult {
  ok: boolean;
  canceled?: boolean;
  /** 成功写入的绝对路径。 */
  path?: string;
  message?: string;
}

/** 磁盘上的目标数据文件（版本化，便于将来迁移）。 */
export interface GoalsFile {
  version: 1;
  goals: Goal[];
}

/** 配置热重载结果。 */
export interface ConfigReloadOutcome {
  ok: boolean;
  /** 本次新增的任务 id。 */
  added: string[];
  removed: string[];
  /** monitor 配置 hash 变化、需要重启适配器的任务 id。 */
  restarted: string[];
  /** 被丢弃的非法项描述（汇总气泡用）。 */
  warnings: string[];
}
