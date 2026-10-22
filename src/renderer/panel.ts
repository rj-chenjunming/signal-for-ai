/**
 * 任务列表面板渲染逻辑。
 *
 * ============================================================================
 * 【Classic Script 约束 —— 重要】
 * ============================================================================
 * 本文件被 panel.html 以 `<script src="panel.js">`（**非** type="module"）加载。
 * 因此：
 *  - **禁止 import / export 语句**；
 *  - 只允许 `import type`（编译期完全擦除）；
 *  - 依赖 window.aiIndicator（preload 注入）与本文件内的纯函数。
 *
 * 【无业务状态】（架构 D8：渲染层只读）
 *  所有数据来自 IPC 推送；本文件只持有「渲染用的最新快照引用」。
 *
 * 【渲染策略】（架构 §1.6）
 *  任务数 ≤ 20，整体重绘成本可忽略，因此**不做虚拟滚动、不做增量 diff**；
 *  但对已存在的行做「复用节点、只改 textContent/class」的轻量 patch，避免闪烁。
 */

// 类型别名（由 globals.d.ts 声明为全局）
// 类型别名（AiSnapshot / AiTaskState / AiTaskStatus / AiTaskAction）由
// globals.d.ts 的 declare global 块注入为全局。此处不重复声明，原因同
// overlay.ts：classic script 的顶层 type 是全局作用域，重名会冲突。

(() => {

const api = window.aiIndicator;

const listEl = document.getElementById('panel-list') as HTMLDivElement;
const emptyEl = document.getElementById('panel-empty') as HTMLDivElement;
const summaryCounts = {
  running: document.getElementById('count-running') as HTMLSpanElement,
  waiting: document.getElementById('count-waiting') as HTMLSpanElement,
  success: document.getElementById('count-success') as HTMLSpanElement,
  failed: document.getElementById('count-failed') as HTMLSpanElement,
};
const btnPause = document.getElementById('btn-pause') as HTMLButtonElement;
const btnClose = document.getElementById('btn-close') as HTMLButtonElement;
const btnGoals = document.getElementById('btn-goals') as HTMLButtonElement;
// SPEC-025：目标入口使用与悬浮灯一致的目标图标（本地固定 SVG）。
btnGoals.innerHTML = window.aiIndicatorUi?.icon('goals') ?? '◎';

/** 状态视觉元数据 —— 色值一律走 CSS 变量，真实色由 shared/constants.ts 定义（架构 §8.1）。 */
const STATUS_VISUAL: Record<AiTaskStatus, { colorVar: string; icon: string; label: string }> = {
  idle: { colorVar: '--status-idle', icon: '○', label: '空闲' },
  starting: { colorVar: '--status-starting', icon: '◌', label: '启动中' },
  running: { colorVar: '--status-running', icon: '▶', label: '运行中' },
  waiting: { colorVar: '--status-waiting', icon: '⏸', label: '等待授权' },
  success: { colorVar: '--status-success', icon: '✓', label: '已完成' },
  failed: { colorVar: '--status-failed', icon: '✕', label: '失败' },
  unknown: { colorVar: '--status-unknown', icon: '?', label: '失联' },
};

/** 主动作常显，次要动作收进 details；可点区域 >= 32 DIP。 */
const ROW_ACTIONS: { id: AiTaskAction; label: string; primary?: boolean }[] = [
  { id: 'focus_terminal', label: '切回工具', primary: true },
  { id: 'open_log', label: '日志' },
  { id: 'open_dir', label: '目录' },
  { id: 'retry', label: '重新监控' },
  { id: 'mark_read', label: '标记已读' },
];

let lastVersion = -1;
let currentSnapshot: AiSnapshot | null = null;

/* ============================================================================
 * 纯工具函数
 * ==========================================================================*/

/** 毫秒 -> 「12:31」/「1:02:03」（与主进程 notify.ts 同一口径）。 */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '--:--';
  }
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/* ============================================================================
 * 渲染主入口
 * ==========================================================================*/

function render(snapshot: AiSnapshot): void {
  if (snapshot.version === lastVersion) {
    return;
  }
  lastVersion = snapshot.version;
  currentSnapshot = snapshot;

  renderSummary(snapshot);
  renderList(snapshot);
  renderPausedHint(snapshot);

  const hasTasks = snapshot.tasks.length > 0;
  emptyEl.hidden = hasTasks;
  listEl.style.display = hasTasks ? 'block' : 'none';
}

/** 顶部摘要条。 */
function renderSummary(snapshot: AiSnapshot): void {
  summaryCounts.running.textContent = String(snapshot.counts.running);
  summaryCounts.waiting.textContent = String(snapshot.counts.waiting);
  summaryCounts.success.textContent = String(snapshot.counts.success);
  summaryCounts.failed.textContent = String(snapshot.counts.failed);
}

/** 任务列表（复用节点，避免闪烁）。 */
function renderList(snapshot: AiSnapshot): void {
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(listEl.children)) {
    const id = (child as HTMLElement).dataset.taskId;
    if (id) {
      existing.set(id, child as HTMLElement);
    }
  }

  const seen = new Set<string>();
  let cursor: ChildNode | null = listEl.firstChild;

  // snapshot.tasks 已由主进程按 STATUS_PRIORITY 排好序（PRD §7.3 异常优先置顶）
  for (const task of snapshot.tasks) {
    seen.add(task.taskId);
    let row = existing.get(task.taskId);
    if (!row) {
      row = createRow(task);
      existing.set(task.taskId, row);
    }
    updateRow(row, task);

    if (cursor === row) {
      cursor = row.nextSibling;
    } else {
      listEl.insertBefore(row, cursor);
    }
  }

  for (const [id, node] of existing) {
    if (!seen.has(id)) {
      node.remove();
    }
  }
}

/** 创建一行骨架。 */
function createRow(task: AiTaskState): HTMLElement {
  const row = document.createElement('div');
  row.className = 'task-row';
  row.dataset.taskId = task.taskId;
  row.setAttribute('role', 'listitem');

  row.innerHTML = `
    <div class="task-stripe"></div>
    <div class="task-icon"></div>
    <div class="task-main">
      <div class="task-line1">
        <span class="task-name"></span>
        <i class="task-unread-dot" hidden></i>
      </div>
      <div class="task-meta">
        <span class="task-status-label"></span>
        <span class="task-elapsed"></span>
      </div>
      <div class="task-sub task-sub-cwd" hidden></div>
      <div class="task-sub task-sub-msg" hidden></div>
    </div>
    <div class="task-progress" hidden><div class="task-progress-bar"></div></div>
    <div class="task-actions"><details class="task-more"><summary>更多</summary><div class="task-menu"></div></details></div>
  `;

  const actionsEl = row.querySelector('.task-actions') as HTMLDivElement;
  const more = row.querySelector('.task-more') as HTMLDetailsElement;
  more.addEventListener('click', event => event.stopPropagation());
  for (const action of ROW_ACTIONS) {
    const btn = document.createElement('button');
    btn.className = `task-action-btn${action.primary ? ' primary' : ''}`;
    btn.textContent = action.label;
    btn.dataset.action = action.id;
    btn.title = `${action.label}：${task.name}`;
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      more.open = false;
      void handleAction(task.taskId, action.id);
    });
    if (action.primary) actionsEl.insertBefore(btn, more);
    else (row.querySelector('.task-menu') as HTMLElement).appendChild(btn);
  }

  // 点击整行 = 跳转到任务现场（等价于点「切回工具」）
  row.addEventListener('click', () => {
    void handleAction(task.taskId, 'focus_terminal');
  });

  return row;
}

/** 更新一行内容（只改 textContent / class / style，不重建 DOM）。 */
function updateRow(row: HTMLElement, task: AiTaskState): void {
  const visual = STATUS_VISUAL[task.status];

  (row.querySelector('.task-stripe') as HTMLDivElement).style.backgroundColor =
    `var(${visual.colorVar})`;

  const icon = row.querySelector('.task-icon') as HTMLDivElement;
  icon.innerHTML = window.aiIndicatorUi?.icon(task.toolKind ?? 'generic') ?? visual.icon;
  row.dataset.status = task.status;

  (row.querySelector('.task-name') as HTMLSpanElement).textContent = task.name;

  // 未读小圆点（PRD P0-4）
  row.classList.toggle('unread', task.unread);
  (row.querySelector('.task-unread-dot') as HTMLElement).hidden = !task.unread;

  // 状态文案 + 耗时
  const statusLabel = row.querySelector('.task-status-label') as HTMLSpanElement;
  const elapsed = row.querySelector('.task-elapsed') as HTMLSpanElement;
  statusLabel.style.color = `var(${visual.colorVar})`;
  if (task.status === 'success' || task.status === 'failed') {
    statusLabel.textContent = `${visual.label} · `;
    elapsed.textContent = task.durationMs ? formatDuration(task.durationMs) : '';
  } else if (task.status === 'running' && task.startedAt) {
    statusLabel.textContent = `${visual.label} · `;
    elapsed.textContent = formatDuration(Date.now() - task.startedAt);
  } else {
    statusLabel.textContent = visual.label;
    elapsed.textContent = '';
  }

  const cwd = row.querySelector('.task-sub-cwd') as HTMLDivElement;
  cwd.textContent = task.cwd ?? '';
  cwd.hidden = !task.cwd;

  const msg = row.querySelector('.task-sub-msg') as HTMLDivElement;
  msg.textContent = task.error ?? task.message ?? '';
  msg.hidden = !(task.error ?? task.message);

  // 进度条（仅 webhook 给 progress 时显示）
  const progressWrap = row.querySelector('.task-progress') as HTMLDivElement;
  const progressBar = row.querySelector('.task-progress-bar') as HTMLDivElement;
  if (typeof task.progress === 'number' && task.progress > 0 && task.progress < 1) {
    progressWrap.hidden = false;
    progressBar.style.width = `${Math.round(task.progress * 100)}%`;
  } else {
    progressWrap.hidden = true;
  }

  const paused = task.paused || currentSnapshot?.paused === true;
  if (!task.enabled || paused || task.processPresent === false) {
    statusLabel.textContent = !task.enabled ? '已停用' : paused ? '监控已暂停' : '未运行';
    statusLabel.style.color = 'var(--panel-muted)';
    elapsed.textContent = '';
  }
  const available = task.availableActions ?? ['focus_terminal', 'retry', 'mark_read'];
  for (const action of ROW_ACTIONS) {
    const button = row.querySelector(`[data-action="${action.id}"]`) as HTMLButtonElement;
    button.hidden = !available.includes(action.id) || (action.id === 'mark_read' && !task.unread);
    button.disabled = (action.id === 'retry' && (!task.enabled || paused)) ||
      (task.processPresent === false && (action.id === 'retry' || action.id === 'focus_terminal'));
    button.title = `${action.label}：${task.name}`;
  }
}

/** 暂停状态提示。 */
function renderPausedHint(snapshot: AiSnapshot): void {
  btnPause.textContent = snapshot.paused ? '恢复监控' : '暂停 30 分钟';
  btnPause.title = btnPause.textContent;
  btnPause.setAttribute('aria-label', btnPause.textContent);
  btnPause.setAttribute('aria-pressed', String(snapshot.paused));
  const hint = document.getElementById('monitoring-hint');
  if (hint) hint.textContent = snapshot.paused ? '已暂停 · 30 分钟后自动恢复' : '实时关注你的 AI 任务';
}

/* ============================================================================
 * 交互
 * ==========================================================================*/

async function handleAction(taskId: string, action: AiTaskAction): Promise<void> {
  if (action === 'focus_terminal' && currentSnapshot?.tasks.find(task => task.taskId === taskId)?.processPresent === false) return;
  try {
    const res = await api?.sendTaskAction({ taskId, action });
    if (res && !res.ok && res.message) {
      showToast(res.message);
    }
  } catch (err) {
    console.error('[panel] 执行动作失败', err);
    showToast('操作失败，详见日志');
  }
}

let toastTimer: number | null = null;

function showToast(message: string): void {
  let toast = document.querySelector('.panel-toast') as HTMLDivElement | null;
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'panel-toast';
    toast.setAttribute('role', 'status');
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  if (toastTimer !== null) {
    window.clearTimeout(toastTimer);
  }
  toastTimer = window.setTimeout(() => {
    toast?.classList.remove('show');
  }, Math.min(10000, Math.max(5000, message.length * 90)));
}

btnClose.addEventListener('click', () => {
  // 收起面板：toggle 会走主进程 hide()，不销毁窗口（避免下次重建的开销）
  void api?.togglePanel();
});

btnGoals.addEventListener('click', () => {
  // SPEC-024：目标窗口是独立窗口；已打开时由主进程负责聚焦而不是重复创建。
  void api?.openGoals();
});

btnPause.addEventListener('click', async () => {
  if (!api || !currentSnapshot || btnPause.disabled) return;
  btnPause.disabled = true;
  try {
    const result = await api.setMonitoringPaused(!currentSnapshot.paused);
    if (!result.ok) showToast(result.message ?? '切换监控状态失败，请重试');
  } catch {
    showToast('切换监控状态失败，请重试');
  } finally {
    btnPause.disabled = false;
  }
});

document.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    const menus = document.querySelectorAll<HTMLDetailsElement>('details[open]');
    if (menus.length > 0) {
      menus.forEach(menu => { menu.open = false; });
      event.preventDefault();
      return;
    }
    void api?.togglePanel();
  }
});

/* ============================================================================
 * 启动
 * ==========================================================================*/

async function start(): Promise<void> {
  if (!api) {
    console.error('[panel] preload 未注入 API，面板无法工作');
    return;
  }
  // Subscribe before the ready handshake; first-open feedback cannot be lost.
  api.onToast((req) => showToast(req.message));
  try {
    const pending = await api.takePanelMessage?.();
    if (pending?.message) showToast(pending.message);
  } catch (err) {
    console.warn('[panel] 获取待显示提示失败', err);
  }
  try {
    render(await api.getSnapshot());
  } catch (err) {
    console.error('[panel] 拉取初始快照失败', err);
  }

  api.onSnapshot(render);

  // 运行中任务每 5s 刷新一次耗时（轻量定时器，避免每秒全量重绘）
  window.setInterval(() => {
    if (currentSnapshot && currentSnapshot.counts.running > 0) {
      // 版本号不变时 render 会早退，这里临时重置以强制刷新耗时
      lastVersion = -1;
      render(currentSnapshot);
    }
  }, 5000);
}

void start();

})();
