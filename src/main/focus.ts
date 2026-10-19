/**
 * focus 跳转模块 —— POC §2.2 多级降级链的**严格落地**。
 *
 * 依赖: Node 内置 `child_process`。**不依赖 Electron**，因此可在 vitest 中
 *       通过注入 spawner 完整验证降级链顺序（架构 T08 验收：`focus.test.ts` 断言 L1→L2→L3→L4）。
 *
 * ============================================================================
 * 【POC 实测结论 —— 不要想当然改写】
 * ============================================================================
 * 1. **本机未安装 Windows Terminal**（POC §4：`wt.exe` 未找到、Appx 未安装、进程数 0）
 *    → `wt.exe` 存在性**必须探测并缓存**，绝不能假设它一定在。
 * 2. **窗口标题有重复歧义**（POC §3：16 个窗口里2 组重名，如「计算器」×2）
 *    → 标题只能作**最后兜底**，主判定依据是窗口类名/进程名。
 * 3. **进程创建有固定开销**（POC §6：沙箱实测 >2s；powershell 比 cmd 慢 ~1482ms）
 *    → 优先直接 spawn 目标程序（explorer/notepad/wt），powershell 只作最后手段，
 *      且异步执行不阻塞 UI；SPEC-002 要求等待激活确认再返回结果。
 * 4. **SetForegroundWindow 受 foreground lock 限制**（POC §5）
 *    → 降级链：ShowWindow(SW_RESTORE) → AppActivate → 打开目录/日志。
 *      SPEC-002 通过前台 HWND 确认结果，不能确认时报告失败或明确降级。
 * 5. **不存在 0 像素 / -1 的 PID 或 HWND 哨兵**
 *    → 本模块定义 `INVALID_HANDLE = 0` 并**显式校验**；
 *      注意 0 号 HWND 是有效的桌面窗口，不是哨兵，所以本模块不用它做「无效」判定，
 *      只用于「spawn 出来的子进程 pid」校验。
 *
 * ============================================================================
 * 降级链（架构 §2.2）
 * ============================================================================
 *   L0 启动时探测一次 wt.exe（where.exe），结果缓存；托盘菜单可「重新探测终端」
 *   L1 spawn 型（首选，零中间层开销）
 *        wt.exe -w <windowName> new-tab -d <cwd>   复用已有 WT 窗口
 *        wt.exe -d <cwd>                          无窗口则新建
 *        [若 wt.exe 不存在则跳过 L1]
 *   L2 显式窗口级聚焦（异步等待确认，每次系统调用有超时）
 *        盲操作：ShowWindow(SW_RESTORE) → BringWindowToTop → SetForegroundWindow
 *        备选：按 PID AppActivate，再检查前台 HWND
 *   L3 目录兜底：spawn explorer.exe <cwd>   ← 实测 100% 可靠，终点保证
 *   L4 日志兜底：spawn notepad.exe <logFile>（显式指定，不用系统关联）
 *   ↓ 全失败
 *   记日志 + 托盘气泡「无法定位终端」，**绝不抛异常**
 */

import { spawn } from 'node:child_process';

import {
  FOCUS_LEVELS,
  INVALID_HANDLE,
  SPAWN_TIMEOUT_MS,
  TERMINAL_PROCESS_NAMES,
  WT_WINDOW_CLASS,
} from '../shared/constants';
import type { FocusResult, JumpConfig, TaskConfig } from '../shared/types';

/* ============================================================================
 * 可注入的进程执行器（测试用）
 * ==========================================================================*/

/** spawn 抽象 —— 让 focus.test.ts 能在不真的启动进程的前提下断言降级链顺序。 */
export interface SpawnExecutor {
  /**
   * 启动一个进程。
   * @returns 是否「成功启动」（false 表示 ENOENT 等立即失败）
   */
  spawn(command: string, args: string[], timeoutMs: number): boolean;
  /** 执行一条命令并等待退出，返回 { ok, stdout, stderr }。 */
  exec(command: string, args: string[], timeoutMs: number): Promise<ExecResult>;
}

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

/** 真实执行器（生产用）。 */
export const realSpawnExecutor: SpawnExecutor = {
  spawn(command: string, args: string[], timeoutMs: number): boolean {
    try {
      const child = spawn(command, args, {
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
      });
      // POC §6：所有 spawn 设 5s 超时，超时只记日志不抛（POC 明确要求）。
      setTimeout(() => {
        try {
          if (!child.killed) {
            child.kill();
          }
        } catch {
          /* ignore */
        }
      }, timeoutMs).unref?.();
      child.on('error', () => {
        /* 忽略：命令不存在时已由 probe 判定 */
      });
      return true;
    } catch {
      return false;
    }
  },

  exec(command: string, args: string[], timeoutMs: number): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (result: ExecResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        finish({
          ok: false,
          stdout: '',
          stderr: err instanceof Error ? err.message : String(err),
          code: null,
        });
        return;
      }

      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        finish({ ok: false, stdout, stderr: `${stderr}\n(timeout ${timeoutMs}ms)`, code: null });
      }, timeoutMs);
      timer.unref?.();

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (c: string) => {
        stdout += c;
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (c: string) => {
        stderr += c;
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        finish({ ok: false, stdout, stderr: err.message, code: null });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        finish({ ok: code === 0, stdout, stderr, code });
      });
    });
  },
};

/* ============================================================================
 * CDP（Chrome DevTools Protocol）HTTP 端点的最小封装
 *
 * 【为什么不用 WebSocket】精确切标签只需要两个 HTTP 端点，无需建立 WS 会话：
 *   GET /json/list             → 列出所有 target（含每个标签页的 id/url/type）
 *   GET /json/activate/<id>    → 激活指定 target（把该标签切到前台）
 * 这比引入 ws 依赖 + CDP 帧协议轻量得多，且完全可注入测试。
 * ==========================================================================*/

/** 一次 JSON fetch 的结果（不管成不成都返回结构化结果，**不抛异常**）。 */
export interface JsonFetchResult {
  ok: boolean;
  status: number;
  json: unknown;
}

/** 可注入的 HTTP JSON 读取器（测试替身 + 生产用全局 fetch）。 */
export type JsonFetcher = (url: string, timeoutMs: number) => Promise<JsonFetchResult>;

/** 生产用 fetcher：全局 fetch + AbortController 超时。 */
export const realJsonFetcher: JsonFetcher = async (url, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text.length > 0 ? (JSON.parse(text) as unknown) : null;
    } catch {
      /* /json/activate 可能返回纯文本，不是 JSON */
    }
    return { ok: res.ok, status: res.status, json };
  } catch {
    // 连接被拒 / 超时 / 中断，统一视为"CDP 不可用"
    return { ok: false, status: 0, json: null };
  } finally {
    clearTimeout(timer);
  }
};

/** `/json/list` 返回的单个 target（只取我们关心的字段）。 */
interface CdpTarget {
  id?: string;
  type?: string;
  url?: string;
  title?: string;
}

/** 两个 URL 是否同源（protocol + host + port 一致，忽略路径/查询/哈希）。 */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/* ============================================================================
 * FocusService
 * ==========================================================================*/

/** 最小日志接口（避免依赖 logger/electron）。 */
export interface FocusLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * 浏览器扩展桥接的最小接口（由 `main/extension-bridge.ts` 实现）。
 *
 * 这里只用**结构化类型**声明需求，不 import 那个模块 —— 于是 focus 层
 * 保持"零 Electron、零额外服务器依赖"，测试里塞一个假实现即可。
 */
export interface ExtensionActivator {
  /** 最近是否有扩展在轮询（没有就别把点击押在它身上）。 */
  isExtensionConnected(): boolean;
  /** 请求扩展把该 URL 的标签切到前台；true = 扩展确认切到了。 */
  requestActivate(url: string): Promise<boolean>;
}

export interface FocusServiceOptions {
  spawner?: SpawnExecutor;
  logger?: FocusLogger;
  /** 探测 wt.exe 的超时。 */
  probeTimeoutMs?: number;
  /** 聚焦已有窗口的超时（POC §6：5s）。 */
  focusTimeoutMs?: number;
  /** CDP HTTP 读取器（测试可注入；默认全局 fetch）。 */
  fetchJson?: JsonFetcher;
  /** 浏览器扩展桥接（可选；没装扩展时没有任何影响）。 */
  extensionActivator?: ExtensionActivator;
  /**
   * 需要让用户**看得见**的一次性提示（浮窗 toast）。
   *
   * 为什么需要：点一下 URL 型任务却"多出一个标签页"时，用户不知道是
   * 扩展没连上还是自己点错了；只写日志等于没有反馈。
   * 缺省不传 = 只记日志，既有调用方行为不变。
   */
  notify?: (message: string) => void;
  /**
   * 取当前任务配置 —— 用于收集「配置里显式指定的 windowTitle」。
   *
   * 这些标题是用户明确要求按标题匹配的目标，窗口枚举时必须放行；
   * 否则非终端窗口（WorkBuddy / 浏览器 / 编辑器）永远匹配不到。
   * 做成回调而不是快照，是为了让热重载后的新配置立刻生效。
   */
  tasks?: () => readonly TaskConfig[];
}

export class FocusService {
  private readonly spawner: SpawnExecutor;
  private readonly logger: FocusLogger;
  private readonly probeTimeoutMs: number;
  private readonly focusTimeoutMs: number;
  private readonly fetchJson: JsonFetcher;
  private readonly extensionActivator: ExtensionActivator | undefined;
  /** 可见提示回调（缺省 undefined = 只记日志）。 */
  private readonly notify: ((message: string) => void) | undefined;
  private readonly options: FocusServiceOptions;

  /**
   * L0 缓存：`wt.exe` 是否可用。
   * **启动时探测一次**，之后每次点击直接读缓存（POC §6：不能每次都 where）。
   */
  private wtAvailable: boolean | null = null;

  /** 已知的终端窗口信息（由 enumerateTerminalWindows 填充），供 L2 显式匹配。 */
  private knownWindows: TerminalWindow[] = [];

  constructor(options: FocusServiceOptions = {}) {
    this.spawner = options.spawner ?? realSpawnExecutor;
    this.logger = options.logger ?? {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
    this.probeTimeoutMs = options.probeTimeoutMs ?? SPAWN_TIMEOUT_MS;
    this.focusTimeoutMs = options.focusTimeoutMs ?? SPAWN_TIMEOUT_MS;
    this.fetchJson = options.fetchJson ?? realJsonFetcher;
    this.extensionActivator = options.extensionActivator;
    this.notify = options.notify;
    this.options = options;
  }

  /* ============================================================================
   * L0：wt.exe 探测（结果缓存）
   * ==========================================================================*/

  /** 探测 wt.exe 是否存在。结果会被缓存，托盘菜单可调用 reprobe 刷新。 */
  async probeWt(): Promise<boolean> {
    // POC §4：本机未安装 WT —— 必须探测，不能假设。
    const result = await this.spawner.exec('where.exe', ['wt.exe'], this.probeTimeoutMs);
    const available = result.ok && /wt\.exe/i.test(result.stdout);
    this.wtAvailable = available;
    this.logger.info(
      available
        ? 'wt.exe 已找到，终端跳转将优先复用 Windows Terminal 窗口'
        : '未找到 wt.exe，终端跳转会跳过 L1 直接走窗口聚焦/目录兜底',
    );
    return available;
  }

  /** 读缓存的探测结果；未探测过返回 false（不触发探测，避免阻塞）。 */
  get wtProbeResult(): boolean {
    return this.wtAvailable === true;
  }

  get hasProbed(): boolean {
    return this.wtAvailable !== null;
  }

  /** 托盘菜单「重新探测终端」。 */
  async reprobe(): Promise<{ wtAvailable: boolean }> {
    const wtAvailable = await this.probeWt();
    // 顺便刷新窗口列表
    await this.refreshWindows();
    return { wtAvailable };
  }

  /* ============================================================================
   * 终端窗口枚举（供 L2 使用）
   * ==========================================================================*/

  /**
   * 枚举可作为终端宿主的顶层窗口。
   *
   * POC §2/§3/§4 的判定优先级：
   *   1. 窗口类名 === CASCADIA_HOSTING_WINDOW_CLASS（WT）—— **最可靠**
   *   2. 进程名 ∈ TERMINAL_PROCESS_NAMES —— 覆盖 conhost/OpenConsole/MobaXterm/SecureCRT
   *   3. 标题子串 —— **仅兜底**（POC §3 实测有重名歧义）
   */
  async refreshWindows(): Promise<TerminalWindow[]> {
    // 用 PowerShell 一次性枚举（Add-Type 在沙箱被禁，但 Get-Process 可用）。
    // 只取 MainWindowHandle/Title/ProcessName，不做任何前台查询（POC §5 规避设计）。
    const script = [
      'Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } |',
      'Select-Object Id, ProcessName, MainWindowTitle, MainWindowHandle |',
      'ConvertTo-Json -Compress',
    ].join(' ');
    const result = await this.spawner.exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      this.probeTimeoutMs,
    );
    if (!result.ok || !result.stdout.trim()) {
      this.logger.warn('枚举终端窗口失败（将直接走 L3 目录兜底）');
      this.knownWindows = [];
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(result.stdout.trim());
      const list = Array.isArray(parsed) ? parsed : [parsed];
      // ★ 这里必须把「配置里显式指定的 windowTitle」一并放行。
      //
      // 原来只保留"像终端"的窗口（WindowsTerminal / conhost / MobaXterm …），
      // 于是**任何非终端窗口都永远匹配不到** —— 例如把 WorkBuddy 配成
      // `terminal.match: WorkBuddy` 时，窗口明明被枚举到了（实测
      // `Id=15860 Title='WorkBuddy' Handle=722520`），却被这个过滤器丢掉，
      // 最终报"未找到标题匹配「WorkBuddy」的窗口"。
      //
      // 用户既然在配置里显式写了标题，就是明确要求按标题找 —— 
      // 这条白名单不该拦它。枚举全部窗口不会有害，因为匹配仍由
      // `findWindowByTitle` 按标题做。
      const accepted = this.acceptedTitlePatterns();
      const processes = (this.options.tasks?.() ?? []).flatMap((task) => {
        const terminal = task.jump?.terminal;
        return terminal?.type === 'windowProcess' ? terminal.processNames : [];
      });
      this.knownWindows = list
        .map((item) => toTerminalWindow(item, accepted, processes))
        .filter((w): w is TerminalWindow => w !== null);
      this.logger.info(`已枚举 ${this.knownWindows.length} 个候选窗口`);
      return this.knownWindows;
    } catch (err) {
      this.logger.warn(`解析窗口枚举结果失败：${(err as Error).message}`);
      this.knownWindows = [];
      return [];
    }
  }

  /**
   * 收集"用户显式声明要按标题找"的窗口片段。
   *
   * 两个来源，都必须放行，否则非终端窗口会被 `toTerminalWindow` 过滤掉：
   *   1. `jump.terminal.type === 'windowTitle'` 的 `match`
   *      （例：WorkBuddy 桌面程序的窗口）
   *   2. `jump.openUrlTitleMatch`（例：已打开的 dsh 页面所在的浏览器窗口）
   *      —— 这条是本轮新增：Chrome 的窗口标题是
   *      `<页面标题> - Google Chrome`，不含任何"终端"特征，
   *      不放行就永远匹配不到，会退化成"每次都新开标签页"。
   */
  private acceptedTitlePatterns(): string[] {
    const patterns: string[] = [];
    for (const task of this.options.tasks?.() ?? []) {
      const terminal = task.jump?.terminal;
      if (terminal?.type === 'windowTitle' && terminal.match.length > 0) {
        patterns.push(terminal.match);
      }
      const urlMatch = task.jump?.openUrlTitleMatch;
      if (typeof urlMatch === 'string' && urlMatch.length > 0) {
        patterns.push(urlMatch);
      }
    }
    return patterns;
  }

  /**
   * 按标题子串查找窗口（**兜底用途**，POC §3 已证明其不可靠）。
   *
   * @param titleMatch   标题片段（大小写不敏感）
   * @param processNames 可选：只匹配这些进程（用于区分"原生客户端窗口"
   *                     与"浏览器里的同名页面" —— 实测两者的标题都含同一个品牌名）
   */
  findWindowByTitle(titleMatch: string, processNames?: readonly string[]): TerminalWindow | null {
    const lower = titleMatch.toLowerCase();
    // 进程名比较要容忍 ".exe" 有无与大小写（枚举给的是不带 .exe 的 ProcessName）
    const wantProcs = (processNames ?? [])
      .map((p) => p.toLowerCase().replace(/\.exe$/u, ''))
      .filter((p) => p.length > 0);

    const matches = (w: TerminalWindow): boolean => {
      if (!w.title.toLowerCase().includes(lower)) return false;
      if (wantProcs.length === 0) return true;
      const proc = w.processName.toLowerCase().replace(/\.exe$/u, '');
      return wantProcs.includes(proc);
    };

    return this.knownWindows.find(matches) ?? null;
  }

  /**
   * 用 CDP 精确激活 `url` 所在的浏览器标签页（无论它是不是激活标签）。
   *
   * 【为什么能跨过 D73 的边界】`openUrlTitleMatch` 依赖 Chrome 窗口标题，
   * 而窗口标题只反映激活标签 —— 所以它最多把**窗口**切到前台。
   * CDP 的 `/json/list` 会列出**所有**标签页，`/json/activate/<id>` 能直接
   * 把指定的那个标签切到前台，从而真正"切到原页面"。
   *
   * 前提：浏览器用 `--remote-debugging-port=<debugPort>` 启动。端口不可达、
   * 目标标签不存在、激活失败，一律返回 false（**不抛异常**），由上层降级。
   */
  private async activateOpenUrlTab(url: string, debugPort: number): Promise<boolean> {
    const base = `http://127.0.0.1:${debugPort}`;
    try {
      const list = await this.fetchJson(`${base}/json/list`, this.focusTimeoutMs);
      if (!list.ok || !Array.isArray(list.json)) {
        this.logger.warn(
          `CDP /json/list 不可用（端口 ${debugPort}，status=${list.status}），退回标题匹配/新开`,
        );
        return false;
      }
      const target = (list.json as CdpTarget[]).find(
        (t) => t.type === 'page' && typeof t.id === 'string' && t.id.length > 0 &&
          sameOrigin(url, t.url ?? ''),
      );
      if (!target) {
        this.logger.info(`CDP 未找到 ${url} 的已开标签（端口 ${debugPort}）`);
        return false;
      }
      const activated = await this.fetchJson(
        `${base}/json/activate/${encodeURIComponent(target.id!)}`,
        this.focusTimeoutMs,
      );
      if (!activated.ok) {
        this.logger.warn(`CDP /json/activate 失败（status=${activated.status}）`);
        return false;
      }
      this.logger.info(`CDP 已激活标签 ${target.id}（${target.title ?? url}）`);
      return true;
    } catch (err) {
      // CDP 层任何异常都不冒泡，由上层按"不可用"降级
      this.logger.warn(`CDP 激活异常（已隔离）：${(err as Error).message}`);
      return false;
    }
  }

  /* ============================================================================
   * 主入口：focusTerminal 降级链
   * ==========================================================================*/

  /**
   * 跳转到任务现场。
   *
   * 降级顺序（架构 §2.2）：
   *   L1 spawn wt（wt 可用且 jump.terminal 为 spawn 型）→ L2 窗口级聚焦
   *   → L3 explorer 打开目录 → L4 notepad 打开日志 → L5 失败
   *
   * **任一级失败都不抛异常**，只记日志并继续降级（PRD P0-7）。
   */
  async focusTerminal(task: TaskConfig, jump: JumpConfig | undefined): Promise<FocusResult> {
    try {
      return await this.runFocusChain(task, jump);
    } catch (err) {
      // 兜底闸门：降级链内部任何一处抛异常（含 spawn 层的 EACCES/ENOENT）
      // 都不允许冒泡到 IPC 调用方 —— 那会让主进程因用户点了一下通知按钮而崩。
      // PRD P0-7「非法项不崩溃」在这里落地为最后一道防线。
      this.logger.error(
        `[focus] 跳转链路异常（已吞掉）: ${(err as Error)?.message ?? String(err)}`,
      );
      return {
        ok: false,
        level: FOCUS_LEVELS.NONE,
        detail: `跳转失败：${(err as Error)?.message ?? String(err)}`,
      };
    }
  }

  /** 降级链主体。异常由 focusTerminal 的闸门统一收敛。 */
  private async runFocusChain(task: TaskConfig, jump: JumpConfig | undefined): Promise<FocusResult> {
    const cwd = jump?.cwd;
    const logFile = jump?.logFile;
    const terminal = jump?.terminal;

    /* ---------------- L0：显式 URL（最高优先级） ----------------
     *
     * 【为什么排在最前】配了 `openUrl` 就是**最明确的意图** ——
     * 用户直接说了"我要去这个网址"，没有任何理由再去试窗口聚焦或开目录。
     *
     * 【为什么需要它】`dsh` 这类任务的"界面"就是个网页
     * （`http://127.0.0.1:3080`）。在只有 `cwd` 兜底时，点击只会弹出
     * 资源管理器 —— 用户点了会觉得"这个端口点不动"。
     */
    if (jump?.openUrl !== undefined) {
      // ① 浏览器扩展精确切标签（用户的**日常浏览器**）—— 最优先。
      //    扩展能操作主浏览器的真实标签，不受 Chrome 136+ 对调试端口的限制。
      //    只有"扩展在轮询"且"它确认切到了"才算成功；否则老实降级。
      if (
        jump.openUrlViaExtension === true &&
        this.extensionActivator?.isExtensionConnected() === true
      ) {
        const ok = await this.extensionActivator.requestActivate(jump.openUrl);
        if (ok) {
          this.logger.info(
            `已通过浏览器扩展切到已打开的标签页 ${jump.openUrl}（任务 ${task.id}，未新开标签页）`,
          );
          return {
            ok: true,
            level: FOCUS_LEVELS.WINDOW_FOCUS,
            detail: `已切到已打开的页面 ${jump.openUrl}`,
          };
        }
        this.logger.info('浏览器扩展未确认切换（可能没找到该标签），退回 CDP/标题匹配/新开');
        // SPEC-003/AC-03：扩展在线但没找到标签时，"新开一个"同样会让人困惑，
        // 必须给一次可见提示；只写日志用户看不见。
        this.notify?.(`浏览器扩展没找到 ${jump.openUrl} 已打开的标签，已新开页面`);
      } else if (jump.openUrlViaExtension === true) {
        // SPEC-003/AC-01：期望走扩展但扩展没在轮询（没装/没启用/SW 被回收）。
        // 行为仍坚持"URL 总是要打开"，但不能再静默 —— 用户现场就是被这条
        // 静默降级坑到："我点一下它就多一个标签页，看不出为什么"。
        this.logger.warn(
          `任务 ${task.id}: 浏览器扩展未连接（未安装/未启用/SW 被回收），` +
            `URL 型跳转退回"新开页面"：${jump.openUrl}`,
        );
        this.notify?.(
          '浏览器扩展未连接，已新开页面；在 chrome://extensions 重载「AI 任务指示灯 · 标签切换桥」可切回已有标签',
        );
      }

      // ② CDP 精确切标签（若配置了 debug 端口）。
      //    它能切到"指定 URL 所在的标签"，无论它是不是激活标签；
      //    这比下面的 titleMatch（只能切窗口）更精确。
      if (typeof jump.openUrlDebugPort === 'number' && jump.openUrlDebugPort > 0) {
        const activated = await this.activateOpenUrlTab(jump.openUrl, jump.openUrlDebugPort);
        if (activated) {
          this.logger.info(
            `已通过 CDP 切到已打开的标签页 ${jump.openUrl}（任务 ${task.id}，未新开标签页）`,
          );
          return {
            ok: true,
            level: FOCUS_LEVELS.WINDOW_FOCUS,
            detail: `已切到已打开的页面 ${jump.openUrl}`,
          };
        }
        this.logger.info(
          `CDP 未命中或不可用（端口 ${jump.openUrlDebugPort}），退回标题匹配/新开`,
        );
      }

      // ★ 语义：**URL 总是要打开的**；`openUrlTitleMatch` 只是让我们在
      //    "它已经开着"时**不重复开**，改为把那个窗口切到前台。
      //
      // 用户反馈：「虽然点击有效 但是不是跳转页面 而是新增页面」——
      // 每点一次就多一个标签页，很快就堆一堆。
      //
      // 为什么"总是要打开"是正确语义：若目标页没开，我们**必须**开它，
      // 否则点击等于没有效果。只有确认它已经开着了，才改为切前台。
      if (jump.openUrlTitleMatch !== undefined && jump.openUrlTitleMatch.length > 0) {
        // ① 先用**已有快照**匹配 —— 命中就立即切前台，零额外开销。
        //
        // 【为什么先查快照再刷新】刷新要 spawn 一次 PowerShell（编译 C# 那段
        // 实测 1~3 秒）。若每次点击都先刷新，重复点击同一个页面会明显卡顿。
        // 快照命中是常态（页面一直开着），所以快路径必须便宜。
        let existing = this.findWindowByTitle(jump.openUrlTitleMatch);

        // ② 快照里没有才刷新一次 —— 快照可能过时（用户刚打开那个页面），
        //    不刷新会出现"明明开着却说没找到"，于是多开一个标签页。
        if (existing === null) {
          await this.refreshWindows();
          existing = this.findWindowByTitle(jump.openUrlTitleMatch);
        }

        if (existing !== null && await this.focusExistingWindow(existing)) {
          this.logger.info(
            `页面已开着，切到前台「${existing.title || existing.processName}」（任务 ${task.id}，未新开标签页）`,
          );
          return {
            ok: true,
            level: FOCUS_LEVELS.WINDOW_FOCUS,
            detail: `已切到已打开的页面「${existing.title || existing.processName}」`,
          };
        }
        this.logger.info(
          `没有标题含「${jump.openUrlTitleMatch}」的窗口，新开 ${jump.openUrl}`,
        );
      }

      // 用 `rundll32 url.dll,FileProtocolHandler <url>` 而不是 `explorer.exe <url>`：
      // 前者是 Windows 上打开 URL 的稳定做法，且 URL 作为**独立参数**传入
      // （不过 shell），所以不存在引号/命令注入问题。
      const ok = this.spawner.spawn(
        'rundll32.exe',
        ['url.dll,FileProtocolHandler', jump.openUrl],
        SPAWN_TIMEOUT_MS,
      );
      if (ok) {
        this.logger.info(`已打开 ${jump.openUrl}（任务 ${task.id}）`);
        return {
          ok: true,
          level: FOCUS_LEVELS.EXPLORER,
          detail: `已在浏览器打开 ${jump.openUrl}`,
        };
      }
      this.logger.warn(`打开 URL 失败（${jump.openUrl}），继续走后续降级链`);
    }

    /* ---------------- L1：spawn 型（首选，零中间层开销） ---------------- */
    // L1-a：用户显式配置了 spawn 型终端（如 wt.exe -w dsh new-tab -d cwd）
    if (terminal?.type === 'spawn') {
      const args = [...terminal.args];
      if (cwd && !args.some((a) => a === cwd)) {
        // 若用户没指定 -d，补充 cwd
        if (!args.includes('-d')) {
          args.push('-d', cwd);
        }
      }
      const ok = this.spawner.spawn(terminal.cmd, args, SPAWN_TIMEOUT_MS);
      if (ok) {
        return {
          ok: true,
          level: FOCUS_LEVELS.SPAWN,
          detail: `已执行 ${terminal.cmd} ${args.join(' ')}`,
        };
      }
      this.logger.warn(`L1 spawn 型失败（${terminal.cmd} 不可执行），降级 L2`);
    }

    // L1-b：Windows Terminal 窗口级复用（仅当探测到 wt.exe 存在）
    if (this.wtAvailable && cwd && terminal?.type !== 'windowTitle' && terminal?.type !== 'windowProcess' && terminal?.type !== 'none') {
      const ok = this.spawner.spawn('wt.exe', ['-d', cwd], SPAWN_TIMEOUT_MS);
      if (ok) {
        return {
          ok: true,
          level: FOCUS_LEVELS.SPAWN,
          detail: `已在 Windows Terminal 新建标签页并切到 ${cwd}`,
        };
      }
      this.logger.warn('L1 wt.exe 启动失败，降级 L2');
    } else if (this.wtAvailable === false) {
      this.logger.info('L1 跳过：wt.exe 不存在（POC 实测本机未安装 WT）');
    }

    /* ---------------- L2：显式桌面目标，等待激活确认 ---------------- */
    if (terminal?.type === 'windowTitle' || terminal?.type === 'windowProcess') {
      const title = terminal.type === 'windowTitle' ? terminal.match : terminal.titleContains ?? '';
      let win = this.findWindowByTitle(title, terminal.processNames);
      if (win === null) {
        await this.refreshWindows();
        win = this.findWindowByTitle(title, terminal.processNames);
      }
      let activated = win !== null && await this.focusExistingWindow(win);
      if (win !== null && !activated) {
        const oldHwnd = win.hwnd;
        await this.refreshWindows();
        win = this.findWindowByTitle(title, terminal.processNames);
        if (win !== null && win.hwnd !== oldHwnd) activated = await this.focusExistingWindow(win);
      }
      if (activated && win !== null) {
        return { ok: true, level: FOCUS_LEVELS.WINDOW_FOCUS, detail: `已切到窗口「${win.title || win.processName}」` };
      }
      this.logger.warn(`桌面目标未找到或激活未确认：${title || terminal.processNames?.join(', ')}`);
    }
    // 没有明确目标时不盲抢第一个终端；只允许用户配置的目录/日志降级。

    /* ---------------- L3：目录兜底（实测 100% 可靠） ---------------- */
    if (cwd) {
      const ok = this.spawner.spawn('explorer.exe', [cwd], SPAWN_TIMEOUT_MS);
      if (ok) {
        return {
          ok: true,
          level: FOCUS_LEVELS.EXPLORER,
          detail: `已打开项目目录 ${cwd}（${FOCUS_LEVELS.EXPLORER} 兜底）`,
        };
      }
      this.logger.warn('L3 explorer.exe 启动失败，降级 L4');
    }

    /* ---------------- L4：日志兜底 ---------------- */
    if (logFile) {
      const openWith = jump?.openWith ?? 'notepad.exe';
      const ok = this.spawner.spawn(openWith, [logFile], SPAWN_TIMEOUT_MS);
      if (ok) {
        return {
          ok: true,
          level: FOCUS_LEVELS.NOTEPAD,
          detail: `已用 ${openWith} 打开日志 ${logFile}`,
        };
      }
      this.logger.warn('L4 日志打开失败');
    }

    /* ---------------- L5：全失败 ---------------- */
    this.logger.error(
      `无法定位任务现场：${task.id}（cwd=${cwd ?? '未配置'} logFile=${logFile ?? '未配置'}）`,
    );
    return {
      ok: false,
      level: FOCUS_LEVELS.NONE,
      detail: '无法定位终端：未配置可用的 cwd / logFile，且窗口聚焦失败',
    };
  }

  /** 激活明确匹配的现有窗口，并通过前台 HWND 验证结果。 */
  async focusExistingWindow(win: TerminalWindow): Promise<boolean> {
    // 显式校验 HWND 有效性。INVALID_HANDLE=0 对 pid 无效；
    // 对 hwnd 而言 0 号窗口是有效的桌面窗口，故这里只排除**缺失**情况。
    if (win.hwnd === null || win.pid === null || win.pid === INVALID_HANDLE) {
      this.logger.warn('focusExistingWindow:窗口句柄信息不完整，跳过');
      return false;
    }

    // ★ 主方案：Win32 ShowWindow + AttachThreadInput + SetForegroundWindow
    //
    // 【为什么不再首选 AppActivate —— 实测结论】
    // 原实现用 `WScript.Shell.AppActivate`，但实测它对**最小化的窗口无效**：
    //   WorkBuddy 窗口 hwnd=722520，IsIconic=True（最小化）
    //   AppActivate('WorkBuddy') 返回 False
    //   AppActivate(15860)       返回 False
    // 而 Win32 这条路（ShowWindow(SW_RESTORE) 先恢复，再切前台）返回 True
    // 且前台窗口真的变成了 WorkBuddy。
    //
    // 另外 Windows 有**前台锁**：后台进程直接 SetForegroundWindow 会失败
    // （实测返回 False，前台仍停在别的窗口）。AttachThreadInput 把本线程挂到
    // 当前前台线程上，这次切换就被视作"前台线程自己发起的"，从而被允许。
    const viaWin32 = await this.activateViaWin32(win.hwnd, win.title);
    if (viaWin32.ok) {
      this.logger.info(`已通过 Win32 激活窗口「${win.title || win.processName}」`);
      return true;
    }

    // 兜底：AppActivate（纯 COM，不需要 Add-Type）。
    // 某些环境里 Add-Type 内联编译可能被安全策略拦（POC §1 记过这一条），
    // 那时仍可退到这条路。
    const byPid = await this.appActivate(String(win.pid));
    if (byPid.ok && await this.verifyForeground(win.hwnd)) {
      this.logger.info(`已确认 AppActivate(pid=${win.pid}) 的目标窗口在前台`);
      return true;
    }

    this.logger.warn(
      `聚焦窗口「${win.title || win.pid}」失败（Win32=${viaWin32.detail}；AppActivate 也未生效）`,
    );
    return false;
  }

  /**
   * 用 Win32 把已存在的窗口**强制**切到前台。
   *
   * ============================================================================
   * ★★ 实测结论：必须走「先最小化 → 再恢复」这一步，否则前台抢不过来
   * ============================================================================
   * 在真实环境下做了逐方法对照（前台被一个第三方客户端占着）：
   *
   *   A 直接 SetForegroundWindow                 返回 False  前台没变  ❌
   *   B AttachThreadInput + SetForegroundWindow  返回 False  前台没变  ❌
   *   C AppActivate(pid)                         返回 **True**  前台没变  ❌
   *   D AppActivate(标题)                         返回 **True**  前台没变  ❌
   *   E 先最小化 → 恢复 → SetForegroundWindow      返回 True   前台**变了** ✅
   *
   * 两个必须记住的点：
   *
   * 1. **`AppActivate` 的返回值不可信** —— 它返回 True 却什么都没做。
   *    所以本方法的成功判据是 `GetForegroundWindow()` 的**真实结果**，
   *    不是任何 API 的返回值。（早先日志一直说"激活成功"而用户看不到变化，
   *    根源就在这里。）
   *
   * 2. **窗口不是最小化时也要先最小化一次**。
   *    原实现只在 `IsIconic()` 为真时才 `ShowWindow(SW_RESTORE)`，
   *    所以"窗口正常显示但不在前台"这个**最常见**的情况下，
   *    restore 那一步从未被触发，前台自然抢不过来。
   *    `SW_MINIMIZE` → `SW_RESTORE` 这个往返会让 Windows 把该窗口当作
   *    "刚被恢复的窗口"并授予前台权限，这是绕开前台锁的关键。
   */
  private async activateViaWin32(
    hwnd: number,
    titleForMatch: string,
  ): Promise<{ ok: boolean; detail: string }> {
    // 窗口句柄来自枚举结果（数字），只接受正整数，避免拼进脚本造成注入
    if (!Number.isInteger(hwnd) || hwnd <= 0) {
      return { ok: false, detail: 'hwnd 非法' };
    }
    const script = [
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -TypeDefinition @"',
      'using System;',
      'using System.Runtime.InteropServices;',
      'public class LampFocus {',
      '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
      '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);',
      '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
      '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
      '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);',
      '}',
      '"@',
      `$h = [IntPtr]${hwnd}`,
      // ★ 关键：无论当前是否最小化，都先最小化再恢复。
      //   这个往返让 Windows 授予前台权限（实测唯一有效的路径）。
      '[void][LampFocus]::ShowWindow($h, 6)', // SW_MINIMIZE
      'Start-Sleep -Milliseconds 120',
      '[void][LampFocus]::ShowWindow($h, 9)', // SW_RESTORE
      '[void][LampFocus]::BringWindowToTop($h)',
      '[void][LampFocus]::SetForegroundWindow($h)',
      'Start-Sleep -Milliseconds 250',
      // 判据用真实结果，不用返回码
      '$fgH = [LampFocus]::GetForegroundWindow()',
      '$sb = New-Object System.Text.StringBuilder 300',
      '[void][LampFocus]::GetWindowText($fgH, $sb, 300)',
      "Write-Output ('LAMPFOCUS ok=' + ($fgH -eq $h) + ' title=' + $sb.ToString())",
    ].join('\n');

    try {
      const result = await this.spawner.exec(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        this.focusTimeoutMs,
      );
      if (!result.ok) {
        return { ok: false, detail: result.stderr.trim().slice(0, 160) || 'exec 失败' };
      }
      const ok = /LAMPFOCUS ok=True/u.test(result.stdout);
      return {
        ok,
        detail: ok ? 'ok' : result.stdout.trim().slice(0, 160) || '未切到前台',
      };
    } catch (err) {
      // Add-Type 被安全策略拦时会走这里 —— 不抛，交给 AppActivate 兜底
      this.logger.warn(`Win32 激活异常（已隔离，将退到 AppActivate）：${(err as Error).message}`);
      return { ok: false, detail: 'exception' };
    }
    // titleForMatch 目前只用于日志可读性，保留参数以便将来做校验
    void titleForMatch;
  }

  private async verifyForeground(hwnd: number): Promise<boolean> {
    const script = [
      `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class LampVerify { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }'`,
      `Write-Output ('LAMPVERIFY ok=' + ([LampVerify]::GetForegroundWindow() -eq [IntPtr]${hwnd}))`,
    ].join('\n');
    const result = await this.spawner.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], this.focusTimeoutMs);
    return result.ok && /LAMPVERIFY ok=True/u.test(result.stdout);
  }

  /** 执行 `WScript.Shell.AppActivate`。失败返回 ok=false，**不抛异常**。 */
  private async appActivate(target: string): Promise<{ ok: boolean; detail: string }> {
    // 目标用单引号包裹并转义内部单引号，避免命令注入。
    const escaped = target.replace(/'/g, "''");
    const script = `$s = New-Object -ComObject WScript.Shell; $s.AppActivate('${escaped}')`;
    try {
      const result = await this.spawner.exec(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        this.focusTimeoutMs,
      );
      // AppActivate 返回 True/False 字符串；退出码 0 且输出含 True 视为成功。
      const ok = result.ok && /true/i.test(result.stdout);
      return { ok, detail: result.stdout.trim() || result.stderr.trim() };
    } catch (err) {
      // POC §1：沙箱里 COM 被禁 -> 必然失败，但**不抛**，由上层降级
      this.logger.warn(`AppActivate 调用异常（已隔离）：${(err as Error).message}`);
      return { ok: false, detail: 'exception' };
    }
  }

  /* ============================================================================
   * 简单跳转（open_dir / open_log）
   * ==========================================================================*/

  /** 打开项目目录（POC §7 实测 100% 可靠）。 */
  openDir(cwd: string): FocusResult {
    const ok = this.spawner.spawn('explorer.exe', [cwd], SPAWN_TIMEOUT_MS);
    if (ok) {
      return { ok: true, level: FOCUS_LEVELS.EXPLORER, detail: `已打开目录 ${cwd}` };
    }
    this.logger.warn(`打开目录失败：${cwd}`);
    return { ok: false, level: FOCUS_LEVELS.NONE, detail: `打开目录失败：${cwd}` };
  }

  /**
   * 打开日志文件。
   * 架构 A12：显式 notepad.exe，**不依赖系统文件关联**
   * （POC §7 实测 `start` 打开 .log 被 Notepad3 接管，不可控）。
   */
  openLog(file: string, openWith = 'notepad.exe'): FocusResult {
    const ok = this.spawner.spawn(openWith, [file], SPAWN_TIMEOUT_MS);
    if (ok) {
      return { ok: true, level: FOCUS_LEVELS.NOTEPAD, detail: `已打开日志 ${file}` };
    }
    this.logger.warn(`打开日志失败：${file}（${openWith}）`);
    return { ok: false, level: FOCUS_LEVELS.NONE, detail: `打开日志失败：${file}` };
  }
}

/* ============================================================================
 * 辅助类型与函数
 * ==========================================================================*/

/** 一个候选终端窗口。 */
export interface TerminalWindow {
  /** 进程 ID；0 视为无效（POC：无 0 像素/-1 哨兵，pid=0 是 System Idle Process）。 */
  pid: number | null;
  processName: string;
  title: string;
  /** 真实 HWND（MainWindowHandle），无窗口为 null。 */
  hwnd: number | null;
  /** 是否为 Windows Terminal（按窗口类名/进程名判定）。 */
  isWindowsTerminal: boolean;
}

/** 把 PowerShell 枚举结果转成 TerminalWindow，做严格校验。 */
function toTerminalWindow(
  raw: unknown,
  acceptedTitlePatterns: readonly string[] = [],
  acceptedProcessNames: readonly string[] = [],
): TerminalWindow | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const pidRaw = obj.Id ?? obj.ProcessId;
  const pid = typeof pidRaw === 'number' ? pidRaw : Number(pidRaw);
  if (!Number.isFinite(pid) || pid === INVALID_HANDLE) {
    return null; // pid 0 = System Idle Process，不是候选终端
  }
  const processName = typeof obj.ProcessName === 'string' ? obj.ProcessName : '';
  const title = typeof obj.MainWindowTitle === 'string' ? obj.MainWindowTitle : '';
  const hwndRaw = obj.MainWindowHandle;
  const hwnd = typeof hwndRaw === 'number' && hwndRaw > 0 ? hwndRaw : null;

  const lower = processName.toLowerCase();
  const isWindowsTerminal =
    lower === 'windowsterminal.exe' ||
    lower === 'wt.exe' ||
    // POC §2.1：WT 窗口类名为 CASCADIA_HOSTING_WINDOW_CLASS；
    // 由于MainWindowTitle 常含该信息，用它做辅助判定。
    title.includes(WT_WINDOW_CLASS);

  // 保留「像终端」的窗口，**以及配置里显式指定标题的窗口**。
  //
  // 后者不可少：否则任何非终端窗口（WorkBuddy / 浏览器 / 编辑器）
  // 都永远匹配不到，`jump.terminal.type: windowTitle` 对它们形同虚设 ——
  // 实测就是这样丢掉 WorkBuddy 窗口的。
  const titleLower = title.toLowerCase();
  const matchesConfiguredTitle = acceptedTitlePatterns.some(
    (p) => p.length > 0 && titleLower.includes(p.toLowerCase()),
  );
  const looksTerminal =
    isWindowsTerminal ||
    TERMINAL_PROCESS_NAMES.some((name) => lower === name) ||
    (hwnd !== null && TERMINAL_PROCESS_NAMES.some((name) => titleLower.includes(name))) ||
    matchesConfiguredTitle ||
    acceptedProcessNames.some((name) => normalizeProcessName(name) === normalizeProcessName(processName));

  if (!looksTerminal) {
    return null;
  }

  return { pid, processName, title, hwnd, isWindowsTerminal };
}

/** 导出 INVALID_HANDLE 以便测试与其它模块共用（POC 约束 7）。 */
export { INVALID_HANDLE };

function normalizeProcessName(name: string): string {
  return name.toLowerCase().replace(/\.exe$/u, '');
}
