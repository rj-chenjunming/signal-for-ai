/**
 * 悬浮灯渲染逻辑。
 *
 * ============================================================================
 * 【Classic Script 约束 —— 重要】
 * ============================================================================
 * 本文件被 overlay.html 以 `<script src="overlay.js">`（**非** type="module"）加载。
 * 因此：
 *  - **禁止 import / export 语句**（`export` 会被 tsc 原样保留，classic script 遇之即 SyntaxError）；
 *  - 只允许 `import type`（编译期完全擦除）；
 *  - 跨文件调用走 `window.aiIndicator*` 全局（由 preload 与 audio.js 提供）。
 *
 * 【依赖来源】全部为全局，由 renderer/globals.d.ts 提供类型声明：
 *  - window.aiIndicator          <- preload 的 contextBridge 白名单（架构 §1.2）
 *  - window.aiIndicatorAudio     <- audio.js（音效合成）
 *  - Snapshot / TaskStatus       <- globals.d.ts 的类型别名（源头是 shared/types.ts）
 *  - 状态色/文案/动画类           <- 全部走 CSS 变量，**本文件不含任何色值字面量**
 *
 * 【为什么不用 import】见本文件顶部「Classic Script 约束」——
 * 只要有 import，tsc 就会产出 `export {}`，classic script 会白屏。
 *
 * 【为什么不做增量 diff】（架构 §1.6）
 *  灯只有 28px + 一个徽标，状态更新频率极低，直接重设 textContent/class 即可。
 */

// 类型别名（AiSnapshot / AiTaskStatus）由 globals.d.ts 的 declare global 块
// 注入为全局。这里**不要**再写 `type Snapshot = AiSnapshot;` —— 本文件以
// classic script 加载，顶层 type 声明属于全局作用域，与 panel.ts 中的同名
// 声明会触发 TS2450/TS2300（Duplicate identifier）。直接用 Ai* 别名即可。

(() => {

const api = window.aiIndicator;

const lampDot = document.getElementById('lamp-dot') as HTMLDivElement;
const lampBadge = document.getElementById('lamp-badge') as HTMLDivElement;
const lampCore = document.getElementById('lamp-core') as HTMLDivElement;
// 临时提示条（不是悬停 tooltip）：用于配置通知及点击失败反馈。
// 悬停提示已按用户要求移除 —— 见下方说明。
const lampToast = document.getElementById('lamp-toast') as HTMLDivElement;

/** 灯带模式的容器（设计决策 D6）：总灯 + 每端口一行。 */
const lampStrip = document.getElementById('lamp-strip') as HTMLDivElement;
const stripMasterDot = document.getElementById('strip-master-dot') as HTMLDivElement;
const stripMasterLabel = document.getElementById('strip-master-label') as HTMLSpanElement;
const stripMasterBadge = document.getElementById('strip-master-badge') as HTMLDivElement;
const stripRows = document.getElementById('strip-rows') as HTMLDivElement;

/** 当前快照的版本号，用于去重（架构 §4.1 version 字段）。 */
let lastVersion = -1;

/**
 * 状态视觉元数据。
 *
 * 【重要】这里**不含任何色值字面量** —— `colorVar` 只是 CSS 变量名，
 * 真实色值由 shared/constants.ts 的 STATUS_COLOR 经主进程注入 CSS 变量。
 * 这是「色值单一来源」（架构 §8.1）在渲染层的实现方式。
 */
const STATUS_VISUAL: Record<AiTaskStatus, { colorVar: string; animClass: string; icon: string }> = {
  idle: { colorVar: '--status-idle', animClass: 'anim-steady', icon: '○' },
  starting: { colorVar: '--status-starting', animClass: 'anim-breathe-slow', icon: '◌' },
  running: { colorVar: '--status-running', animClass: 'anim-breathe', icon: '▶' },
  waiting: { colorVar: '--status-waiting', animClass: 'anim-blink-fast', icon: '⏸' },
  success: { colorVar: '--status-success', animClass: 'anim-flash-once', icon: '✓' },
  failed: { colorVar: '--status-failed', animClass: 'anim-alarm', icon: '✕' },
  unknown: { colorVar: '--status-unknown', animClass: 'anim-steady', icon: '?' },
};

/** 全部动画类名，用于清理旧类。 */
const ALL_ANIM_CLASSES: string[] = Object.values(STATUS_VISUAL)
  .map((v) => v.animClass)
  .filter((v, i, arr) => arr.indexOf(v) === i);

/* ============================================================================
 * 渲染
 * ==========================================================================*/

function applyStatusColor(status: AiTaskStatus): void {
  const visual = STATUS_VISUAL[status];
  // 通过 CSS 变量间接设色：CSS 里只引用变量，不出现字面色值
  lampDot.style.setProperty('background-color', `var(${visual.colorVar})`);
}

function applyAnimation(status: AiTaskStatus): void {
  const wanted = STATUS_VISUAL[status].animClass;
  for (const cls of ALL_ANIM_CLASSES) {
    if (cls !== wanted) {
      lampDot.classList.remove(cls);
    }
  }
  // 强制重排，让「绿闪 1 次」这类一次性动画能重复触发
  void lampDot.offsetWidth;
  lampDot.classList.add(wanted);
}

function applyBadge(count: number): void {
  // PRD P0-5：running=0 时不显示徽标
  if (count <= 0) {
    lampBadge.hidden = true;
    lampBadge.textContent = '';
    return;
  }
  lampBadge.hidden = false;
  lampBadge.textContent = count > 99 ? '99+' : String(count);
}

/*
 * `describeTask()` 已删除 —— 它只服务于"一行 port 的悬停文案"。
 *
 * 那份信息（含 `dsh 127.0.0.1:13080：64 会话` 这种关键证据）**没有丢**：
 * 面板里每个任务都会显示 `task.message`（见 panel.ts），
 * 需要排查时打开面板即可。浮窗上不再悬停弹字。
 */

/*
 * 【为什么这里不再有悬停 tooltip】
 *
 * 原先总灯和每一行都会在悬停时弹出一块多行文字（「各端口：· … · …」）。
 * 用户反馈：「鼠标放上去就不需要文字提示了 乱糟糟的」。
 *
 * 删掉是合理的 —— 浮窗是个**常驻不打扰**的小挂件，鼠标扫过就弹一大块
 * 文字正好破坏这一点。而状态信息**已经**由灯本身表达：
 *   - 圆点颜色 = 七态
 *   - 端口标签 = 是哪个实例
 * 需要更细的排查时，托盘菜单里有面板可以打开。
 */

/** 应用一份快照。 */
function render(snapshot: AiSnapshot): void {
  if (snapshot.version === lastVersion) {
    return; // 幂等：同一版本不重复渲染
  }
  lastVersion = snapshot.version;

  applyStatusColor(snapshot.aggregate);
  applyAnimation(snapshot.aggregate);
  applyBadge(snapshot.runningCount);
  renderStripMode(snapshot);
}

/* ============================================================================
 * 灯带模式（设计决策 D6 / D9）
 * ==========================================================================*/

/**
 * 把通用动画类应用到任意灯元素。
 *
 * 与 applyAnimation 的区别：那个绑死在单灯模式的 lampDot 上；
 * 这个接受目标元素，供灯带里的总灯与各端口灯复用。
 */
function applyAnimationTo(el: HTMLElement, status: AiTaskStatus): void {
  const wanted = STATUS_VISUAL[status].animClass;
  for (const cls of ALL_ANIM_CLASSES) {
    if (cls !== wanted) {
      el.classList.remove(cls);
    }
  }
  // 强制重排，让一次性动画（绿闪）能重复触发
  void el.offsetWidth;
  el.classList.add(wanted);
}

/** 给任意灯元素设色（走 CSS 变量，不出现字面色值）。 */
function applyStatusColorTo(el: HTMLElement, status: AiTaskStatus): void {
  el.style.setProperty('background-color', `var(${STATUS_VISUAL[status].colorVar})`);
}

/** 已渲染的端口行，按 taskId 缓存以便原地更新（避免每帧重建 DOM）。 */
const stripRowCache = new Map<
  string,
  { row: HTMLDivElement; dot: HTMLDivElement; port: HTMLSpanElement }
>();

/**
 * 按快照切换单灯 / 灯带形态，并更新灯带内容。
 *
 * 形态由主进程判定（`snapshot.stripMode`）——渲染层不自己判断
 * 「几个任务算多」，那是业务决策，不该散落在 classic script 里。
 */
function renderStripMode(snapshot: AiSnapshot): void {
  const useStrip = snapshot.stripMode === true;

  lampCore.hidden = useStrip;
  lampStrip.hidden = !useStrip;

  // body 上的标记让 CSS 能把 .lamp-drag 从「单灯的 44x44」改成「撑满灯带画布」。
  // 不加这个类，灯带会被塞进 44px 的框里 —— 超出部分被窗口边缘裁掉
  // （表现为"圆圈显示不完整"），且只有中间一小块能拖动。
  document.body.classList.toggle('strip-mode', useStrip);

  if (!useStrip) {
    // 退回单灯时清空缓存，避免下次进灯带时残留旧行
    stripRowCache.clear();
    stripRows.replaceChildren();
    return;
  }

  // 总灯 = 所有端口的聚合态
  applyStatusColorTo(stripMasterDot, snapshot.aggregate);
  applyAnimationTo(stripMasterDot, snapshot.aggregate);
  stripMasterLabel.textContent = statusLabel(snapshot.aggregate);
  if (snapshot.runningCount > 0) {
    stripMasterBadge.hidden = false;
    stripMasterBadge.textContent =
      snapshot.runningCount > 99 ? '99+' : String(snapshot.runningCount);
  } else {
    stripMasterBadge.hidden = true;
    stripMasterBadge.textContent = '';
  }

  // 端口行：原地更新已有节点，缺失的补建，多余的移除
  const seen = new Set<string>();

  // ★ 产品原则：浮窗里出现的东西默认就该是活着的。
  // 失联(unknown)/失败(failed) 的行不显示 —— 这样"看到一行"就等于"它是活着的"。
  //
  // 过滤**已在主进程做完**（snapshot.displayTasks），这里不重复实现规则：
  // 本文件是 classic script（零 import），import 共享模块会生成 `export {}`
  // 让页面变成模块脚本而白屏；而规则若在这里再写一份，两处就会漂移。
  const visibleTasks = snapshot.displayTasks ?? snapshot.tasks;

  if (visibleTasks.length === 0) {
    // 此刻没有任何东西活着 —— 主进程会把 stripMode 置 false 缩成单灯。
    // 这里只需清空，避免留下上一轮的残留行。
    stripRows.replaceChildren();
    stripRowCache.clear();
    return;
  }

  if (snapshot.tasks.length === 0) {
    stripRows.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'strip-empty';
    empty.textContent = '未配置监控端口';
    stripRows.appendChild(empty);
    stripRowCache.clear();
    return;
  }

  for (const task of visibleTasks) {
    seen.add(task.taskId);

    let entry = stripRowCache.get(task.taskId);
    if (!entry) {
      const row = document.createElement('div');
      row.className = 'strip-row';
      // 每个端口一行可单独点击：点击 = 跳到那个任务 + 熄灭它的完成提醒
      row.dataset['taskId'] = task.taskId;

      const dot = document.createElement('div');
      dot.className = 'strip-dot';

      const port = document.createElement('span');
      port.className = 'strip-port';
      port.textContent = task.portLabel ?? task.taskId;

      row.appendChild(dot);
      row.appendChild(port);
      stripRows.appendChild(row);

      // ★ 点击一行 = ①跳到该任务的界面 ②熄灭它的完成提醒（绿灯）
      //
      // ⚠️ 两件事**必须各自独立发起**，不能串起来：
      // 曾经写成「等 focus 成功后再 mark_read」，结果跳转失败时
      // **绿灯永远不熄** —— 实测就是这个现象（未找到匹配窗口 ->
      // mark_read 根本没发出去 -> 灯一直绿）。跳转可能因为很多原因失败
      // （窗口标题变了、任务没配 jump、非终端窗口…），
      // 但"点击"这个动作本身必须总能让提醒消失。
      //
      // 「标记已读」不只是改状态：store 会把当时的完成水位记进
      // ackedCompletionAt，于是监控之后每轮读到的同一个完成事件都会被
      // 丢弃 —— 这正是"点掉之后绿灯不会立刻复亮"的关键。
      //
      // 两条动作各自独立发出（互不阻塞）
      const send = (action: 'focus_terminal' | 'mark_read'): void => {
        void api?.sendTaskAction({ taskId: task.taskId, action }).then((result) => {
          if (!result.ok) showLampToast(result.message ?? '操作未完成，请从面板重试');
        }).catch(() => showLampToast('操作失败，请从面板查看或重试'));
      };

      // ⚠️ 「是否完成态」必须在**点击那一刻**读，不能捕获创建时的 task.status。
      //
      // 【实测踩到的坑】`stripRowCache` 会复用行节点，所以这个闭包只在
      // **首次创建**时求值一次。若写成 `const wasDone = task.status === 'success'`，
      // 那么这一行第一次出现时是 idle，`wasDone` 就永远是 false ——
      // 于是无论怎么点都**不会发 mark_read**，绿灯永远不熄。
      // 我的 verify-ack-click.mjs 正是靠这个断言抓出来的。
      //
      // 改成从 DOM 上读：`renderStripMode` 每轮都会同步
      // `entry.row.dataset['status']`，所以它总是最新值。
      row.addEventListener('click', () => {
        if (!api) return;
        // 先跳转、再熄灭。两条请求各自独立发出（互不阻塞）。
        send('focus_terminal');
        const now = row.dataset['status'] ?? '';
        if (now === 'success' || now === 'failed') send('mark_read');
      });

      entry = { row, dot, port };
      stripRowCache.set(task.taskId, entry);
    }

    applyStatusColorTo(entry.dot, task.status);
    applyAnimationTo(entry.dot, task.status);
    entry.row.dataset['status'] = task.status;
    // ★ 刻意**不设** `row.title`。
    //
    // 原来这里写的是 `describeTask(task)`，鼠标一放上去就弹出
    // 「dsh @ 3080（本机） · 空闲 · dsh 127.0.0.1:3080：17 会话」这种长条。
    // 用户的原话：「鼠标放上去就不需要文字提示了 乱糟糟的」。
    //
    // 删掉是合理的：灯带上**已经**有两个视觉信号在表达同一件事 ——
    // 圆点颜色（七态）+ 端口标签。再叠一层系统 tooltip 属于冗余，
    // 而且它自己会盖住相邻的行。
    //
    // 提示：浏览器不会**继承**旧的 title，所以这里不设就等于没有。
  }

  // 移除已消失的任务行（配置热重载后可能变少）
  for (const [taskId, entry] of [...stripRowCache]) {
    if (!seen.has(taskId)) {
      entry.row.remove();
      stripRowCache.delete(taskId);
    }
  }
}

/* ============================================================================
 * 交互
 * ==========================================================================*/

lampCore.addEventListener('click', () => {
  if (api) {
    void api.togglePanel();
  }
});

// 键盘可达性：灯窗口 focusable=false，但仍支持 Enter/Space 语义
lampCore.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    if (api) {
      void api.togglePanel();
    }
  }
});

/* ============================================================================
 * 边缘停靠（点阵形态）
 * ==========================================================================*/

/** 全部停靠类名；切换形态前先清干净，避免多个类同时挂着。 */
const ALL_DOCK_CLASSES = ['dock-none', 'dock-top', 'dock-left', 'dock-right'];

/**
 * 应用主进程下发的停靠方向。
 *
 * 渲染层在这里**只做一件事**：把 `dock-*` 类挂到 body 上；
 * 具体长什么样（横排还是竖排、藏哪些文字、留白多少）全部由 CSS 决定
 * —— 见 shared.css 的「边缘停靠」段。
 *
 * 这与 `stripMode` 是同一套分工："什么时候算贴边"属于业务判断，留在主进程；
 * 渲染层只负责照着画（本文件是 classic script，也**不能**自己判断屏幕位置）。
 */
function applyLayout(layout: AiLampLayout): void {
  const dock: AiLampDock = layout?.dock ?? 'none';
  for (const cls of ALL_DOCK_CLASSES) {
    document.body.classList.remove(cls);
  }
  document.body.classList.add(`dock-${dock}`);
}

/* ============================================================================
 * 启动
 * ==========================================================================*/

async function start(): Promise<void> {
  // 音效上下文提前激活（架构 §1.5：稳妥起见在挂载时先resume 一次）
  window.aiIndicatorAudio?.primeAudio();

  if (!api) {
    console.error('[overlay] preload 未注入 API，悬浮灯无法工作');
    return;
  }

  try {
    render(await api.getSnapshot());
  } catch (err) {
    console.error('[overlay] 拉取初始快照失败', err);
  }

  // 订阅后续推送（M→R 唯一数据下发通道）
  api.onSnapshot(render);

  // 停靠形态（拖到侧边/顶部 -> 点阵）：与状态无关，走独立通道
  api.onLayout(applyLayout);

  // 主进程要求响某声时（notify:play）
  api.onPlaySound((req) => {
    window.aiIndicatorAudio?.playStatusSound(req.status);
  });

  // 拖动结束后通知主进程立即落盘位置。
  // 实际屏幕坐标由主进程 OverlayWindow 的 `moved` 事件读取真实值，
  // 渲染层只发一个「该落盘了」的信号（架构 §1.3 位置记忆）。
  window.addEventListener('mouseup', () => {
    window.setTimeout(() => {
      void reportPosition();
    }, 120);
  });

  api.onToast((req) => showLampToast(req.message));
}

function showLampToast(message: string): void {
  lampToast.textContent = message;
  lampToast.classList.add('show');
  window.setTimeout(() => lampToast.classList.remove('show'), 4000);
}

async function reportPosition(): Promise<void> {
  try {
    // 渲染层无 Node 能力，拿不到真实屏幕坐标；用 window.screenX/Y 作为尽力而为的提示值，
    // 主进程会以自己读到的真实坐标为准。
    await api?.notifyLampDragged({ x: window.screenX, y: window.screenY });
  } catch (err) {
    console.warn('[overlay] 上报位置失败', err);
  }
}

function statusLabel(status: AiTaskStatus): string {
  switch (status) {
    case 'running':
      return '运行中';
    case 'waiting':
      return '等待授权';
    case 'success':
      return '已完成';
    case 'failed':
      return '失败';
    case 'starting':
      return '启动中';
    case 'unknown':
      return '失联';
    case 'idle':
    default:
      return '空闲';
  }
}

void start();

})();