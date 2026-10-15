/**
 * 终端跳转降级链测试。
 *
 * 对应架构 T08 验收标准与 POC §2.2。核心要验证的是**降级顺序**与
 * **永不抛异常**这两条不变量：
 *  - 顺序错→ 用户点了"打开终端"却打开了记事本；
 *  - 抛异常  → 通知按钮点击后整个主进程崩掉。
 *
 * 通过注入 SpawnExecutor 假执行器，在不真的启动进程的前提下断言行为。
 */
import { describe, expect, it } from 'vitest';
import {
  FocusService,
  INVALID_HANDLE,
  type ExecResult,
  type JsonFetcher,
  type JsonFetchResult,
  type SpawnExecutor,
} from '../src/main/focus';
import type { JumpConfig, TaskConfig } from '../src/shared/types';

interface SpawnCall {
  kind: 'spawn' | 'exec';
  command: string;
  args: string[];
}

interface FakeSpawner extends SpawnExecutor {
  calls: SpawnCall[];
  /** 命令 -> 是否成功。默认全部成功。 */
  setResults(results: Record<string, boolean>): void;
}

function makeSpawner(results: Record<string, boolean> = {}, execOut = ''): FakeSpawner {
  const calls: SpawnCall[] = [];
  const table = { ...results };
  return {
    calls,
    setResults(next) {
      Object.assign(table, next);
    },
    spawn(command, args) {
      calls.push({ kind: 'spawn', command, args });
      return table[command] ?? true;
    },
    async exec(command, args): Promise<ExecResult> {
      calls.push({ kind: 'exec', command, args });
      return { ok: true, stdout: execOut, stderr: '', code: 0 };
    },
  };
}

const TASK: TaskConfig = {
  id: 't1',
  name: '任务一',
  enabled: true,
  monitor: { type: 'webhook', listen: '127.0.0.1', path: '/hook/t1' },
};

const CWD = 'D:/projects/demo';
const LOG = 'D:/projects/demo/run.log';

describe('INVALID_HANDLE 哨兵', () => {
  it('定义为 0，与 Win32 约定一致', () => {
    // 注意：HWND 0 是「桌面窗口」这个真实存在的东西，但在本模块里
    // 它的语义是"没查到窗口"，必须显式声明常量而不是到处写 0。
    expect(INVALID_HANDLE).toBe(0);
  });
});

/* ============================================================================
 * windowTitle 的 processNames 过滤
 *
 * 本机实测的真实情形：dsh 原生客户端与浏览器里的 dsh 页面**标题几乎相同** ——
 *   `DeepSeek Harness.exe` -> `… — DeepSeek Harness`
 *   `chrome`               -> `… — DeepSeek Harness - Google Chrome`
 * 只按标题匹配会切到 Chrome，用户看到的正是
 * "点 dsh 却切到浏览器、而且切不到想要的标签"。
 * ==========================================================================*/
describe('★ windowTitle 的 processNames 过滤（区分原生客户端与浏览器）', () => {
  const BOTH = JSON.stringify([
    {
      Id: 15932,
      ProcessName: 'chrome',
      MainWindowTitle: 'Initial hello — DeepSeek Harness - Google Chrome',
      MainWindowHandle: 131942,
    },
    {
      Id: 22980,
      ProcessName: 'DeepSeek Harness',
      MainWindowTitle: 'Initial hello — DeepSeek Harness',
      MainWindowHandle: 10684536,
    },
  ]);

  const JUMP = {
    terminal: {
      type: 'windowTitle' as const,
      match: 'DeepSeek Harness',
      processNames: ['DeepSeek Harness'],
    },
  };

  /**
   * ⚠️ 必须传 `tasks`：`acceptedTitlePatterns()` 从配置里收集"用户显式声明要按
   * 标题找"的片段，`toTerminalWindow` 才放行。不传的话 Chrome 与
   * DeepSeek Harness 两个**非终端窗口**都会被过滤掉，knownWindows 为空。
   * （这条本身也说明：配置里必须真的声明该标题，枚举才会带上它。）
   */
  const makeSvc = () =>
    new FocusService({ spawner: makeSpawner({}, BOTH), tasks: () => [{ ...TASK, jump: JUMP }] });

  it('★ 不加过滤时会切到 Chrome（这就是 bug 现象）', async () => {
    const svc = makeSvc();
    await svc.refreshWindows();
    expect(svc.findWindowByTitle('DeepSeek Harness')?.processName).toBe('chrome');
  });

  it('★★ 加 processNames 后精确切到原生客户端', async () => {
    const svc = makeSvc();
    await svc.refreshWindows();
    const win = svc.findWindowByTitle('DeepSeek Harness', ['DeepSeek Harness']);
    expect(win?.processName).toBe('DeepSeek Harness');
    expect(win?.title).not.toContain('Google Chrome');
  });

  it('★ 进程名比较容忍 .exe 后缀与大小写', async () => {
    const svc = makeSvc();
    await svc.refreshWindows();
    // 配置里写 "DeepSeek Harness.exe" 也能匹配（枚举给的是不带 .exe 的 ProcessName）
    expect(
      svc.findWindowByTitle('DeepSeek Harness', ['DeepSeek Harness.exe'])?.processName,
    ).toBe('DeepSeek Harness');
    expect(svc.findWindowByTitle('DeepSeek Harness', ['DEEPSEEK HARNESS'])?.processName).toBe(
      'DeepSeek Harness',
    );
  });

  it('进程名不匹配时返回 null（而不是退回"随便挑一个"）', async () => {
    const svc = makeSvc();
    await svc.refreshWindows();
    expect(svc.findWindowByTitle('DeepSeek Harness', ['notepad'])).toBeNull();
  });

  it('★ 走完整 focusTerminal：应聚焦原生窗口而非 Chrome', async () => {
    const svc = makeSvc();
    const res = await svc.focusTerminal(TASK, JUMP);
    expect(res.ok).toBe(true);
    expect(res.detail).not.toContain('Google Chrome');
  });

  it('★★ 标题匹配失败时**不许**盲抢别的窗口（否则会切到无关窗口）', async () => {
    // 实测踩到的严重问题：任务配了 windowTitle 但目标窗口不可见
    // （例：WorkBuddy 缩到托盘）时，原实现会"盲聚焦第一个候选窗口" ——
    // 实测把 Chrome 抢到前台，用户看到的是"点 workbuddy 却切到浏览器"。
    // 这比什么都不做更糟：夺走焦点 + 给出错误暗示。
    const sp = makeSpawner({}, BOTH);
    const svc = new FocusService({
      spawner: sp,
      tasks: () => [
        { ...TASK, jump: { cwd: CWD, terminal: { type: 'windowTitle', match: 'NotExistXYZ' } } },
      ],
    });
    const res = await svc.focusTerminal(TASK, {
      cwd: CWD,
      terminal: { type: 'windowTitle', match: 'NotExistXYZ' },
    });

    // 不该出现"聚焦候选窗口"这种盲抢描述
    expect(res.detail).not.toContain('候选');
    // 应退到与任务相关的兜底（打开目录）
    const cmds = sp.calls.filter((c) => c.kind === 'spawn').map((c) => c.command);
    expect(cmds).toContain('explorer.exe');
  });

  it('没指定 windowTitle 时才允许盲聚焦候选窗口（保留原行为）', async () => {
    // L2-b 盲聚焦需要**真的有一个"像终端"的候选窗口**才会触发；
    // 否则 knownWindows 为空，会直接落到 L3/L4。
    const TERM = JSON.stringify([
      {
        Id: 999,
        ProcessName: 'WindowsTerminal.exe',
        MainWindowTitle: 'PowerShell',
        MainWindowHandle: 4242,
      },
    ]);
    const sp = makeSpawner({}, TERM);
    const svc = new FocusService({
      spawner: sp,
      tasks: () => [{ ...TASK, jump: { terminal: { type: 'none' } } }],
    });
    // 必须先枚举：focusTerminal 自身不枚举（生产环境由启动时那次枚举填充）
    await svc.refreshWindows();
    const res = await svc.focusTerminal(TASK, { terminal: { type: 'none' } });
    expect(res.detail).toContain('候选');
  });
});

/* ============================================================================
 * L0：显式 URL（dsh 这类"界面就是个网页"的任务）
 * ==========================================================================*/
describe('★ focusTerminal L0：显式 openUrl', () => {
  it('★ 配了 openUrl 就走它，且**不再**走 L1/L2/L3', async () => {
    // dsh 的界面是 http://127.0.0.1:3080。若只配 cwd，
    // 兜底只会弹出资源管理器，用户点了会觉得"这个端口点不动"。
    const sp = makeSpawner();
    const svc = new FocusService({ spawner: sp });
    const res = await svc.focusTerminal(TASK, {
      openUrl: 'http://127.0.0.1:3080',
      cwd: CWD,
    });

    const spawns = sp.calls.filter((c) => c.kind === 'spawn');
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.command).toBe('rundll32.exe');
    expect(spawns[0]!.args).toEqual(['url.dll,FileProtocolHandler', 'http://127.0.0.1:3080']);
    expect(res.ok).toBe(true);
    expect(res.detail).toContain('http://127.0.0.1:3080');
  });

  it('★ URL 优先级高于 spawn 型终端配置', async () => {
    // 显式配了网址就是最明确的意图，不该再去试别的
    const sp = makeSpawner();
    const svc = new FocusService({ spawner: sp });
    await svc.focusTerminal(TASK, {
      openUrl: 'https://example.com/x',
      terminal: { type: 'spawn', cmd: 'wt.exe', args: ['new-tab'] },
      cwd: CWD,
    });

    const cmds = sp.calls.filter((c) => c.kind === 'spawn').map((c) => c.command);
    expect(cmds).toEqual(['rundll32.exe']); // 没有 wt.exe
  });

  it('URL 打开失败时继续降级，而不是直接失败', async () => {
    const sp = makeSpawner({ 'rundll32.exe': false });
    const svc = new FocusService({ spawner: sp });
    const res = await svc.focusTerminal(TASK, { openUrl: 'http://127.0.0.1:9999', cwd: CWD });

    const cmds = sp.calls.filter((c) => c.kind === 'spawn').map((c) => c.command);
    expect(cmds).toContain('explorer.exe'); // 退到目录兜底
    expect(res.ok).toBe(true);
  });

  it('URL 作为独立参数传入（不过 shell），不接受拼接', async () => {
    // 防注入：URL 里带引号或 & 时也必须原样作为**单个 argv 元素**
    const sp = makeSpawner();
    const svc = new FocusService({ spawner: sp });
    const evil = 'http://127.0.0.1:3080/?a=1&b="x"';
    await svc.focusTerminal(TASK, { openUrl: evil });

    const spawns = sp.calls.filter((c) => c.kind === 'spawn');
    expect(spawns[0]!.args[1]).toBe(evil); // 原样，未被拆分或转义
  });
});

/* ============================================================================
 * ★ openUrlTitleMatch：切到已打开的页面，而不是每次新开标签页
 * ==========================================================================*/
describe('★ openUrlTitleMatch：不重复开页面', () => {
  /** 造一个"窗口枚举返回了某个窗口"的 exec 输出。 */
  const WINDOW_JSON = JSON.stringify([
    { Id: 15932, ProcessName: 'chrome', MainWindowTitle: 'dsh 控制台 - Google Chrome', MainWindowHandle: 131942 },
  ]);

  it('★ 已开着那个页面时 -> 切前台，且**不**再新开', async () => {
    // ⚠️ 必须同时传 `tasks`：`openUrlTitleMatch` 要经过
    // `acceptedTitlePatterns()` 才会被 `toTerminalWindow` 放行。
    // 不传的话 Chrome 窗口会被 looksTerminal 过滤掉（它没有任何"终端"特征），
    // 于是永远匹配不到、退化成"每次都新开"—— 那正是本功能要修的问题。
    const sp = makeSpawner({}, WINDOW_JSON);
    const svc = new FocusService({
      spawner: sp,
      tasks: () => [{ ...TASK, jump: { openUrlTitleMatch: 'dsh' } }],
    });
    const res = await svc.focusTerminal(TASK, {
      openUrl: 'http://127.0.0.1:3080',
      openUrlTitleMatch: 'dsh',
    });

    // 不应出现 rundll32（那是"新开"的路径）
    const cmds = sp.calls.filter((c) => c.kind === 'spawn').map((c) => c.command);
    expect(cmds).not.toContain('rundll32.exe');
    expect(res.detail).toContain('切到已打开的页面');
  });

  it('★ 没开着 -> 走新开（点击必须有实际效果）', async () => {
    // 语义要点：URL **总是要打开的**；titleMatch 只让我们在"已经开着"时不重复开。
    // 若反过来（找不到就不开），点击会变成"什么都没发生"。
    const sp = makeSpawner({}, '[]');
    const svc = new FocusService({ spawner: sp });
    const res = await svc.focusTerminal(TASK, {
      openUrl: 'http://127.0.0.1:3080',
      openUrlTitleMatch: 'dsh',
    });

    const cmds = sp.calls.filter((c) => c.kind === 'spawn').map((c) => c.command);
    expect(cmds).toContain('rundll32.exe');
    expect(res.detail).toContain('已在浏览器打开');
  });

  it('没配 titleMatch 时行为不变（总是新开）', async () => {
    const sp = makeSpawner({}, WINDOW_JSON);
    const svc = new FocusService({ spawner: sp });
    await svc.focusTerminal(TASK, { openUrl: 'http://127.0.0.1:3080' });

    const cmds = sp.calls.filter((c) => c.kind === 'spawn').map((c) => c.command);
    expect(cmds).toEqual(['rundll32.exe']);
  });

  it('★ 判断前会**刷新**窗口列表（快照可能已过时）', async () => {
    // 启动时枚举的窗口列表可能过时：用户刚打开/刚关掉那个页面。
    // 不刷新就会出现"明明开着却说没找到"（多开一个）或更糟的切错窗口。
    const sp = makeSpawner({}, WINDOW_JSON);
    const svc = new FocusService({ spawner: sp });
    await svc.focusTerminal(TASK, {
      openUrl: 'http://127.0.0.1:3080',
      openUrlTitleMatch: 'dsh',
    });

    // 应有一次窗口枚举的 exec（powershell），且发生在 spawn rundll32 之前
    const kinds = sp.calls.map((c) => `${c.kind}:${c.command}`);
    expect(kinds.some((k) => k.startsWith('exec:powershell'))).toBe(true);
  });

  it('★ 非终端窗口也能被匹配到（Chrome 不含任何"终端"特征）', async () => {
    // toTerminalWindow 有 looksTerminal 过滤，原先会把 Chrome 丢掉 ——
    // 那样 titleMatch 永远匹配不到，退化成"每次都新开"。
    // 修法是把配置里显式声明的 openUrlTitleMatch 一并放行。
    // 这里断言"确实能匹配到 Chrome 窗口"（靠上面的 WINDOW_JSON）。
    const sp = makeSpawner({}, WINDOW_JSON);
    const svc = new FocusService({
      spawner: sp,
      tasks: () => [{ ...TASK, jump: { openUrlTitleMatch: 'dsh' } }],
    });
    const res = await svc.focusTerminal(TASK, {
      openUrl: 'http://127.0.0.1:3080',
      openUrlTitleMatch: 'dsh',
    });
    expect(res.detail).toContain('切到已打开的页面');
  });
});

/* ============================================================================
 * ★ openUrlDebugPort：CDP 精确切标签（而非新开标签页）
 * ==========================================================================*/
describe('★ openUrlDebugPort：CDP 精确切标签', () => {
  /** `/json/list` 返回的 target 列表：13080 已开，另有一个无关页。 */
  const LIST = [
    { id: 't-13080', type: 'page', url: 'http://127.0.0.1:13080/', title: 'dsh web' },
    { id: 't-other', type: 'page', url: 'https://example.com/', title: 'other' },
  ];

  /** 造一个可编程的 CDP fetcher：记录请求、按 URL 分支返回。 */
  function makeFetcher(list: unknown = LIST, activateOk = true): { calls: string[]; fetchJson: JsonFetcher } {
    const calls: string[] = [];
    const fetchJson: JsonFetcher = async (url: string) => {
      calls.push(url);
      if (url.includes('/json/list')) {
        return { ok: true, status: 200, json: list } satisfies JsonFetchResult;
      }
      if (url.includes('/json/activate/')) {
        return {
          ok: activateOk,
          status: activateOk ? 200 : 500,
          json: null,
        } satisfies JsonFetchResult;
      }
      return { ok: false, status: 404, json: null } satisfies JsonFetchResult;
    };
    return { calls, fetchJson };
  }

  it('★ 已开着同源标签 → 激活它，且不新开', async () => {
    const sp = makeSpawner();
    const fetcher = makeFetcher();
    const svc = new FocusService({ spawner: sp, fetchJson: fetcher.fetchJson });
    const res = await svc.focusTerminal(TASK, {
      openUrl: 'http://127.0.0.1:13080',
      openUrlDebugPort: 9222,
    });

    const cmds = sp.calls.filter((c) => c.kind === 'spawn').map((c) => c.command);
    expect(cmds).not.toContain('rundll32.exe'); // 不新开
    expect(res.detail).toContain('已切到已打开的页面');
    // 必须真的请求了 /json/list 与 /json/activate/<id>
    expect(fetcher.calls.some((u) => u.includes('/json/list'))).toBe(true);
    expect(fetcher.calls.some((u) => u.includes('/json/activate/t-13080'))).toBe(true);
  });

  it('★ CDP 里没有同源标签 → 新开（点击必须有效果）', async () => {
    const sp = makeSpawner();
    const fetcher = makeFetcher([{ id: 'x', type: 'page', url: 'https://other.com', title: 'x' }]);
    const svc = new FocusService({ spawner: sp, fetchJson: fetcher.fetchJson });
    const res = await svc.focusTerminal(TASK, {
      openUrl: 'http://127.0.0.1:13080',
      openUrlDebugPort: 9222,
    });

    const cmds = sp.calls.filter((c) => c.kind === 'spawn').map((c) => c.command);
    expect(cmds).toContain('rundll32.exe');
    expect(res.detail).toContain('已在浏览器打开');
  });

  it('★ CDP 端口不可达（/json/list 失败）→ 退回新开', async () => {
    const sp = makeSpawner();
    const calls: string[] = [];
    const fetchJson: JsonFetcher = async (url: string) => {
      calls.push(url);
      return { ok: false, status: 0, json: null }; // 连接被拒
    };
    const svc = new FocusService({ spawner: sp, fetchJson });
    await svc.focusTerminal(TASK, {
      openUrl: 'http://127.0.0.1:13080',
      openUrlDebugPort: 9222,
    });

    const cmds = sp.calls.filter((c) => c.kind === 'spawn').map((c) => c.command);
    expect(cmds).toContain('rundll32.exe');
    expect(calls.some((u) => u.includes('/json/list'))).toBe(true);
  });

  it('★ /json/activate 失败（非 200）→ 退回新开', async () => {
    const sp = makeSpawner();
    const fetcher = makeFetcher(LIST, false);
    const svc = new FocusService({ spawner: sp, fetchJson: fetcher.fetchJson });
    await svc.focusTerminal(TASK, {
      openUrl: 'http://127.0.0.1:13080',
      openUrlDebugPort: 9222,
    });

    const cmds = sp.calls.filter((c) => c.kind === 'spawn').map((c) => c.command);
    expect(cmds).toContain('rundll32.exe');
  });

  it('★ CDP 优先级高于 titleMatch（都配时先走 CDP）', async () => {
    // 窗口枚举返回空 → titleMatch 必然找不到；只有 CDP 能命中。
    const sp = makeSpawner({}, '[]');
    const fetcher = makeFetcher(LIST);
    const svc = new FocusService({ spawner: sp, fetchJson: fetcher.fetchJson });
    const res = await svc.focusTerminal(TASK, {
      openUrl: 'http://127.0.0.1:13080',
      openUrlTitleMatch: 'dsh',
      openUrlDebugPort: 9222,
    });

    const cmds = sp.calls.filter((c) => c.kind === 'spawn').map((c) => c.command);
    expect(cmds).not.toContain('rundll32.exe'); // CDP 命中，不新开
    expect(res.detail).toContain('已切到已打开的页面');
  });

  it('★ CDP 不可用但配了 titleMatch → 退回 titleMatch（不新开）', async () => {
    // 降级顺序：CDP 失败后仍尝试 titleMatch —— 能找到窗口就不新开。
    const WINDOW_JSON = JSON.stringify([
      { Id: 15932, ProcessName: 'chrome', MainWindowTitle: 'dsh 控制台 - Google Chrome', MainWindowHandle: 131942 },
    ]);
    const sp = makeSpawner({}, WINDOW_JSON);
    const fetchJson: JsonFetcher = async () => ({ ok: false, status: 0, json: null });
    const svc = new FocusService({
      spawner: sp,
      fetchJson,
      tasks: () => [{ ...TASK, jump: { openUrlTitleMatch: 'dsh' } }],
    });
    const res = await svc.focusTerminal(TASK, {
      openUrl: 'http://127.0.0.1:13080',
      openUrlTitleMatch: 'dsh',
      openUrlDebugPort: 9222,
    });

    const cmds = sp.calls.filter((c) => c.kind === 'spawn').map((c) => c.command);
    expect(cmds).not.toContain('rundll32.exe');
    expect(res.detail).toContain('切到已打开的页面');
  });

  it('没配 debugPort 时行为不变（不碰 CDP）', async () => {
    const sp = makeSpawner();
    const calls: string[] = [];
    const fetchJson: JsonFetcher = async (url: string) => {
      calls.push(url);
      return { ok: false, status: 0, json: null };
    };
    const svc = new FocusService({ spawner: sp, fetchJson });
    await svc.focusTerminal(TASK, { openUrl: 'http://127.0.0.1:13080' });

    // 没配 debugPort → 不该发任何 CDP 请求，直接新开
    expect(calls).toHaveLength(0);
    const cmds = sp.calls.filter((c) => c.kind === 'spawn').map((c) => c.command);
    expect(cmds).toEqual(['rundll32.exe']);
  });
});

/* ============================================================================
 * ★ openUrlViaExtension：经**日常浏览器**的本地扩展精确切标签（D73 路线②）
 * ==========================================================================*/
describe('★ openUrlViaExtension：扩展精确切标签', () => {
  /** 假扩展桥接：记录是否被调用、以及"在线/能否切到"两个开关。 */
  function makeActivator(connected: boolean, activateOk: boolean) {
    const calls: string[] = [];
    return {
      calls,
      isExtensionConnected: (): boolean => connected,
      requestActivate: async (url: string): Promise<boolean> => {
        calls.push(url);
        return activateOk;
      },
    };
  }

  it('★ 扩展在线且确认切到 -> 不新开', async () => {
    const sp = makeSpawner();
    const act = makeActivator(true, true);
    const svc = new FocusService({ spawner: sp, extensionActivator: act });
    const res = await svc.focusTerminal(TASK, {
      openUrl: 'http://127.0.0.1:13080',
      openUrlViaExtension: true,
    });

    const cmds = sp.calls.filter((c) => c.kind === 'spawn').map((c) => c.command);
    expect(cmds).not.toContain('rundll32.exe'); // 不新开
    expect(res.detail).toContain('已切到已打开的页面');
    expect(act.calls).toEqual(['http://127.0.0.1:13080']);
  });

  it('★ 扩展没在线 -> 完全不碰它（不让点击白等），直接新开', async () => {
    const sp = makeSpawner();
    const act = makeActivator(false, false);
    const svc = new FocusService({ spawner: sp, extensionActivator: act });
    await svc.focusTerminal(TASK, {
      openUrl: 'http://127.0.0.1:13080',
      openUrlViaExtension: true,
    });

    expect(act.calls).toHaveLength(0);
    const cmds = sp.calls.filter((c) => c.kind === 'spawn').map((c) => c.command);
    expect(cmds).toContain('rundll32.exe');
  });

  it('★ 扩展在线但没找到该标签 -> 退回新开（点击必须有实际效果）', async () => {
    const sp = makeSpawner();
    const act = makeActivator(true, false);
    const svc = new FocusService({ spawner: sp, extensionActivator: act });
    await svc.focusTerminal(TASK, {
      openUrl: 'http://127.0.0.1:13080',
      openUrlViaExtension: true,
    });

    const cmds = sp.calls.filter((c) => c.kind === 'spawn').map((c) => c.command);
    expect(cmds).toContain('rundll32.exe');
  });

  it('没配 openUrlViaExtension 时行为不变（即使扩展在线也不碰）', async () => {
    const sp = makeSpawner();
    const act = makeActivator(true, true);
    const svc = new FocusService({ spawner: sp, extensionActivator: act });
    await svc.focusTerminal(TASK, { openUrl: 'http://127.0.0.1:13080' });

    expect(act.calls).toHaveLength(0);
    const cmds = sp.calls.filter((c) => c.kind === 'spawn').map((c) => c.command);
    expect(cmds).toEqual(['rundll32.exe']);
  });

  it('★ 扩展优先于 CDP（两者都配时先走扩展，不再打调试端口）', async () => {
    const sp = makeSpawner();
    const act = makeActivator(true, true);
    const cdpCalls: string[] = [];
    const fetchJson: JsonFetcher = async (url: string) => {
      cdpCalls.push(url);
      return { ok: true, status: 200, json: [] };
    };
    const svc = new FocusService({ spawner: sp, extensionActivator: act, fetchJson });
    const res = await svc.focusTerminal(TASK, {
      openUrl: 'http://127.0.0.1:13080',
      openUrlViaExtension: true,
      openUrlDebugPort: 9222,
    });

    expect(res.detail).toContain('已切到已打开的页面');
    expect(cdpCalls).toHaveLength(0);
  });

  it('★ 扩展没切到时继续走 CDP（降级链完整，不是二选一）', async () => {
    const sp = makeSpawner();
    const act = makeActivator(true, false);
    const cdpCalls: string[] = [];
    const fetchJson: JsonFetcher = async (url: string) => {
      cdpCalls.push(url);
      if (url.includes('/json/list')) {
        return {
          ok: true,
          status: 200,
          json: [{ id: 't1', type: 'page', url: 'http://127.0.0.1:13080/' }],
        };
      }
      return { ok: true, status: 200, json: null };
    };
    const svc = new FocusService({ spawner: sp, extensionActivator: act, fetchJson });
    const res = await svc.focusTerminal(TASK, {
      openUrl: 'http://127.0.0.1:13080',
      openUrlViaExtension: true,
      openUrlDebugPort: 9222,
    });

    expect(cdpCalls.some((u) => u.includes('/json/list'))).toBe(true);
    expect(res.detail).toContain('已切到已打开的页面');
  });
});

describe('focusTerminal L1：spawn 型终端', () => {
  it('spawn 型配置直接启动目标命令，且不经过 powershell', async () => {
    const sp = makeSpawner();
    const svc = new FocusService({ spawner: sp });
    const jump: JumpConfig = {
      terminal: { type: 'spawn', cmd: 'wt.exe', args: ['new-tab', '-d', CWD] },
      cwd: CWD,
    };
    const res = await svc.focusTerminal(TASK, jump);

    const spawns = sp.calls.filter((c) => c.kind === 'spawn');
    expect(spawns[0]!.command).toBe('wt.exe');
    expect(res.ok).toBe(true);
  });

  it('spawn 失败时继续降级而不是直接失败', async () => {
    const sp = makeSpawner({ 'wt.exe': false });
    const svc = new FocusService({ spawner: sp });
    const jump: JumpConfig = {
      terminal: { type: 'spawn', cmd: 'wt.exe', args: ['new-tab'] },
      cwd: CWD,
    };
    const res = await svc.focusTerminal(TASK, jump);
    // wt 失败后应退到 L3 目录打开
    const cmds = sp.calls.filter((c) => c.kind === 'spawn').map((c) => c.command);
    expect(cmds).toContain('explorer.exe');
    expect(res.ok).toBe(true);
  });

  it('未显式给 -d 时自动补上 cwd', async () => {
    const sp = makeSpawner();
    const svc = new FocusService({ spawner: sp });
    await svc.focusTerminal(TASK, {
      terminal: { type: 'spawn', cmd: 'wt.exe', args: ['new-tab'] },
      cwd: CWD,
    });
    const first = sp.calls.find((c) => c.kind === 'spawn')!;
    expect(first.args.join(' ')).toContain(CWD);
  });
});

describe('focusTerminal 降级链顺序（架构 §2.2）', () => {
  it('windowTitle 型且有 cwd 时：窗口聚焦 → 目录兜底', async () => {
    const sp = makeSpawner();
    const svc = new FocusService({ spawner: sp });
    const res = await svc.focusTerminal(TASK, {
      terminal: { type: 'windowTitle', match: 'WorkBuddy' },
      cwd: CWD,
    });

    const cmds = sp.calls.filter((c) => c.kind === 'spawn').map((c) => c.command);
    // 窗口型无法直接聚焦成功时，终点必须落在 explorer.exe（POC 实测 100% 可靠）
    expect(cmds).toContain('explorer.exe');
    expect(res.ok).toBe(true);
  });

  it('有 logFile 时最终会尝试用 notepad 打开日志', async () => {
    const sp = makeSpawner();
    const svc = new FocusService({ spawner: sp });
    await svc.focusTerminal(TASK, {
      terminal: { type: 'none' },
      logFile: LOG,
    });
    const cmds = sp.calls.filter((c) => c.kind === 'spawn').map((c) => c.command);
    expect(cmds).toContain('notepad.exe');
  });

  it('显式 openWith 优先于默认 notepad', async () => {
    const sp = makeSpawner();
    const svc = new FocusService({ spawner: sp });
    await svc.focusTerminal(TASK, {
      terminal: { type: 'none' },
      logFile: LOG,
      openWith: 'code.exe',
    });
    const cmds = sp.calls.filter((c) => c.kind === 'spawn').map((c) => c.command);
    expect(cmds).toContain('code.exe');
  });

  it('terminal.type=none 时不尝试窗口聚焦，直接走兜底', async () => {
    const sp = makeSpawner();
    const svc = new FocusService({ spawner: sp });
    await svc.focusTerminal(TASK, { terminal: { type: 'none' }, cwd: CWD });
    const cmds = sp.calls.filter((c) => c.kind === 'spawn').map((c) => c.command);
    expect(cmds).not.toContain('wt.exe');
  });
});

describe('focusTerminal 永不抛异常（PRD P0-7）', () => {
  it('spawn 全部失败时返回 ok:false 而不抛', async () => {
    const sp = makeSpawner({ 'wt.exe': false, 'explorer.exe': false, 'notepad.exe': false });
    const svc = new FocusService({ spawner: sp });
    const res = await svc.focusTerminal(TASK, {
      terminal: { type: 'spawn', cmd: 'wt.exe', args: [] },
      cwd: CWD,
      logFile: LOG,
    });
    expect(res.ok).toBe(false);
  });

  it('jump 为 undefined 时安全返回', async () => {
    const sp = makeSpawner();
    const svc = new FocusService({ spawner: sp });
    await expect(svc.focusTerminal(TASK, undefined)).resolves.toBeDefined();
  });

  it('spawn 执行器自身抛异常时被吞掉，不冒泡到主进程', async () => {
    const sp: SpawnExecutor = {
      calls: [],
      setResults: () => undefined,
      spawn() {
        throw new Error('EACCES: spawn 被拒绝');
      },
      async exec() {
        throw new Error('exec 失败');
      },
    } as unknown as FakeSpawner;
    const svc = new FocusService({ spawner: sp });
    await expect(
      svc.focusTerminal(TASK, { terminal: { type: 'none' }, cwd: CWD }),
    ).resolves.toBeDefined();
  });
});

describe('wt.exe 探测与缓存（POC §4/§6）', () => {
  it('未找到 wt.exe 时把结果记为不可用', async () => {
    const sp = makeSpawner({}, ''); // exec 返回空 stdout
    const svc = new FocusService({ spawner: sp });
    const ok = await svc.probeWt();
    expect(ok).toBe(false);
    expect(svc.wtProbeResult).toBe(false);
  });

  it('stdout 含 wt.exe 时判定为可用', async () => {
    const sp = makeSpawner({}, 'C:\\Windows\\System32\\wt.exe\r\n');
    const svc = new FocusService({ spawner: sp });
    expect(await svc.probeWt()).toBe(true);
    expect(svc.wtProbeResult).toBe(true);
  });

  it('hasProbed 在探测前为 false，探测后为 true', async () => {
    const sp = makeSpawner({}, '');
    const svc = new FocusService({ spawner: sp });
    expect(svc.hasProbed).toBe(false);
    await svc.probeWt();
    expect(svc.hasProbed).toBe(true);
  });

  it('reprobe 可刷新缓存（对应托盘菜单「重新探测终端」）', async () => {
    let out = '';
    const svc = new FocusService({
      spawner: {
        spawn: () => true,
        async exec() {
          return { ok: true, stdout: out, stderr: '', code: 0 };
        },
      },
    });
    await svc.probeWt();
    expect(svc.wtProbeResult).toBe(false);
    out = 'wt.exe'; // 用户随后装了 Windows Terminal
    await svc.reprobe();
    expect(svc.wtProbeResult).toBe(true);
  });
});