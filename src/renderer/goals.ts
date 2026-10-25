/**
 * 目标清单窗口渲染逻辑（SPEC-024；SPEC-038 起 keyed 增量渲染）。
 *
 * ============================================================================
 * 【Classic Script 约束】
 * ============================================================================
 * 本文件被 goals.html 以 `<script src="goals.js">`（**非** module）加载：
 *  - 禁止 import / export（含 `import type` 也会产生 `export {}`，导致白屏）；
 *  - 类型由 globals.d.ts 注入（AiGoal / AiGoalsView 等）。
 *
 * 【渲染模型（SPEC-038）】
 * 数据来自主进程推送（GoalsView）；推送只做 keyed diff：卡片 DOM 按 goal.id
 * 缓存复用——元素不销毁，IME 组合、时间线内选区、armed 删除确认、输入草稿
 * 等浏览器内部态天然存活（SPEC-031 的快照/恢复机制随之退役，唯一保留的是
 * 滚动位置）。卡片内字段原地写；时间线输入框是卡片内持久节点，与条目列表
 * 分离，永不重建。已在正确位置的节点一律不碰：无变化的推送 = 零 DOM 变更。
 * 所有用户输入一律用 textContent 写入，禁止 innerHTML 拼接。
 */

(() => {
  const api = window.aiIndicator;

  // SPEC-035：共享助手由 shared-ui.js 提供（本页 HTML 已先于本脚本加载）；
  // 缺失说明接线断了，加载即失败比静默降级更容易被夹具与真机发现。
  const { el, formatTime } = window.aiUi!;

  const listEl = document.getElementById('goals-list') as HTMLElement;
  const emptyEl = document.getElementById('goals-empty') as HTMLElement;
  const warningEl = document.getElementById('goals-warning') as HTMLElement;
  const warningTextEl = document.getElementById('goals-warning-text') as HTMLElement;
  const dismissWarningBtn = document.getElementById('btn-dismiss-warning') as HTMLButtonElement;
  const goalInput = document.getElementById('goal-input') as HTMLInputElement;
  const addBtn = document.getElementById('btn-add-goal') as HTMLButtonElement;
  const exportBtn = document.getElementById('btn-export') as HTMLButtonElement;
  const closeBtn = document.getElementById('btn-close') as HTMLButtonElement;
  const countEl = document.getElementById('goals-count') as HTMLElement;
  const toastEl = document.getElementById('goals-toast') as HTMLElement;

  let view: AiGoalsView = { goals: [] };
  const expanded = new Set<string>();
  let completedOpen = false;
  let editingGoalId: string | null = null;
  let exporting = false;
  let dismissedWarning: string | null = null;
  const entryKinds = new Map<string, AiGoalEntryKind>();
  let toastTimer: number | null = null;
  let pendingEntryFocus: string | null = null;
  let draggingGoalId: string | null = null;

  /* ------------------------------------------------------------ keyed 缓存 */

  /** 时间线单条记录的可更新节点（row 内字段原地写，row 本身按 entry.id 复用）。 */
  interface EntryRowRefs {
    row: HTMLLIElement;
    time: HTMLElement;
    kind: HTMLElement;
    text: HTMLElement;
  }

  /** 展开详情（时间线 + 输入框）的可更新节点。detail 是卡片内持久节点。 */
  interface GoalDetailRefs {
    wrap: HTMLElement;
    /** 进度滑杆（仅 active 卡有；done 卡为 null）。 */
    progressRange: HTMLInputElement | null;
    progressValue: HTMLElement | null;
    /** 条目列表与空态提示二选一挂载，节点均持久。 */
    timeline: HTMLUListElement | null;
    timelineEmpty: HTMLElement | null;
    entryRows: Map<string, EntryRowRefs>;
    entryAddRow: HTMLElement;
    entryInput: HTMLInputElement;
  }

  /**
   * 一张卡片的缓存条目。事件监听只在 buildCard/ensureDetail 时绑定一次，
   * 复用绝不重复绑定（SPEC-038 风险项）；闭包只捕获 goalId 等不变量，
   * 标题/进度等可变数据一律在事件触发时经 currentGoal 读最新视图。
   */
  interface GoalCard {
    goalId: string;
    /** 分组语义：active↔done 互转时销毁重建（SPEC-038 §3 边界）。 */
    status: AiGoalStatus;
    card: HTMLElement;
    head: HTMLElement;
    expandBtn: HTMLButtonElement;
    titleBtn: HTMLButtonElement;
    /** 编辑中的标题输入框；退出编辑即销毁（每次编辑新建，见 syncTitleEditor）。 */
    titleEditor: HTMLInputElement | null;
    pct: HTMLElement;
    fill: HTMLElement;
    metaCount: HTMLElement;
    metaTime: HTMLElement;
    detail: GoalDetailRefs | null;
  }

  /** 卡片 DOM 缓存：keyed 复用的核心。 */
  const cardCache = new Map<string, GoalCard>();
  /** 「已完成」分组容器与开关（低频重建无关紧要，但持久可免开关抖动）。 */
  let doneGroupEl: HTMLElement | null = null;
  let doneToggleBtn: HTMLButtonElement | null = null;

  function cssEscape(value: string): string {
    return CSS.escape(value);
  }

  /** 事件触发时读当前视图（卡片缓存跨推送存活，不能捕获旧 goal 对象）。 */
  function currentGoal(goalId: string): AiGoal | undefined {
    return view.goals.find((item) => item.id === goalId);
  }

  function showToast(message: string): void {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    if (toastTimer !== null) {
      window.clearTimeout(toastTimer);
    }
    toastTimer = window.setTimeout(() => {
      toastEl.classList.remove('show');
    }, Math.min(10000, Math.max(3000, message.length * 90)));
  }

  async function run(action: () => Promise<AiTaskActionResponse>): Promise<boolean> {
    if (!api) {
      return false;
    }
    try {
      const result = await action();
      if (!result.ok) {
        showToast(result.message ?? '操作失败');
        return false;
      }
      return true;
    } catch (err) {
      console.error('[goals] 操作失败', err);
      showToast('操作失败，详见日志');
      return false;
    }
  }

  /* ---------------------------------------------------------------- 渲染 */

  function render(): void {
    // SPEC-038：keyed 复用后唯一需要抢救的只剩滚动位置。SPEC-031 的草稿/
    // 焦点/标题快照随整树重建一起退役——节点不销毁，这些态天然存活。
    const scrollTop = listEl.scrollTop;
    const active = view.goals.filter((goal) => goal.status === 'active');
    const done = view.goals.filter((goal) => goal.status === 'done');

    // 视图里已消失的目标（删除）：连同缓存卡片一起销毁。
    const visibleIds = new Set(view.goals.map((goal) => goal.id));
    for (const [goalId, card] of [...cardCache]) {
      if (!visibleIds.has(goalId)) {
        destroyCard(card);
      }
    }

    for (let i = 0; i < active.length; i += 1) {
      const goal = active[i]!;
      const card = ensureCard(goal);
      // 按视图顺序落位：已在正确位置就绝不动节点；需要重排时 insertBefore
      // 移动既有节点（appendChild 语义），不重建。
      const expected = listEl.children[i];
      if (expected !== card.card) {
        listEl.insertBefore(card.card, expected ?? null);
      }
      updateCard(card, goal);
    }

    syncDoneGroup(done);

    const hasAny = view.goals.length > 0;
    emptyEl.hidden = hasAny;
    listEl.hidden = !hasAny;
    countEl.textContent = `${active.length} 个进行中 · ${done.length} 个已完成`;

    renderWarning();
    listEl.scrollTop = scrollTop;

    if (pendingEntryFocus) {
      const goalId = pendingEntryFocus;
      pendingEntryFocus = null;
      const input = listEl.querySelector<HTMLInputElement>(
        `input[data-entry-input="${cssEscape(goalId)}"]`,
      );
      input?.focus();
    }
  }

  function renderWarning(): void {
    const warning = view.warning;
    const show =
      typeof warning === 'string' && warning.length > 0 && warning !== dismissedWarning;
    warningEl.hidden = !show;
    if (show && warning) {
      warningTextEl.textContent = warning;
    }
  }

  /** 「已完成」分组固定在 active 卡之后；收起时卡片摘出 DOM 但缓存保留。 */
  function syncDoneGroup(done: AiGoal[]): void {
    if (done.length === 0) {
      doneGroupEl?.remove();
      doneGroupEl = null;
      doneToggleBtn = null;
      return;
    }
    if (!doneGroupEl || !doneToggleBtn) {
      doneGroupEl = el('section', 'done-group');
      doneToggleBtn = el('button', 'done-toggle');
      doneToggleBtn.type = 'button';
      doneToggleBtn.addEventListener('click', () => {
        completedOpen = !completedOpen;
        render();
      });
      doneGroupEl.appendChild(doneToggleBtn);
    }
    doneToggleBtn.textContent = `${completedOpen ? '▾' : '▸'} 已完成（${done.length}）`;
    doneToggleBtn.setAttribute('aria-expanded', String(completedOpen));
    if (completedOpen) {
      for (let i = 0; i < done.length; i += 1) {
        const goal = done[i]!;
        const card = ensureCard(goal);
        // children[0] 是分组开关，done 卡从 1 号位开始。
        const expected = doneGroupEl.children[i + 1];
        if (expected !== card.card) {
          doneGroupEl.insertBefore(card.card, expected ?? null);
        }
        updateCard(card, goal);
      }
    } else {
      // Array.from 而非展开：本文件要同时过主/test 两份 tsconfig 的
      // lib 口径（无 DOM.Iterable），HTMLCollection 不可展开。
      for (const node of Array.from(doneGroupEl.children)) {
        if (node !== doneToggleBtn) {
          node.remove();
        }
      }
    }
    listEl.appendChild(doneGroupEl);
  }

  /** 取缓存卡片；status 变化（active↔done）时销毁重建，否则复用。 */
  function ensureCard(goal: AiGoal): GoalCard {
    const cached = cardCache.get(goal.id);
    if (cached) {
      if (cached.status === goal.status) {
        return cached;
      }
      // 换组属低频操作，允许销毁重建；随组迁移丢失的输入态（草稿/armed）
      // 是 SPEC-038 §3 记录过的可接受语义。
      destroyCard(cached);
    }
    const card = buildCard(goal);
    cardCache.set(goal.id, card);
    return card;
  }

  function destroyCard(card: GoalCard): void {
    card.titleEditor?.remove();
    card.detail?.wrap.remove();
    card.card.remove();
    cardCache.delete(card.goalId);
  }

  /** 构建卡片骨架并一次性绑定全部监听；可变字段留给 updateCard 原地写。 */
  function buildCard(goal: AiGoal): GoalCard {
    const goalId = goal.id;
    const card = el('article', `goal${goal.status === 'done' ? ' is-done' : ''}`);
    card.dataset.goalId = goalId;

    const head = el('div', 'goal-head');
    card.appendChild(head);

    // SPEC-026：拖拽把手是唯一的拖动起点，避免在输入框/滑杆上误触排序。
    const dragHandle = el('button', 'goal-drag', '⠿');
    dragHandle.type = 'button';
    dragHandle.draggable = true;
    dragHandle.title = '拖拽排序';
    dragHandle.setAttribute('aria-label', '拖拽排序');
    dragHandle.addEventListener('dragstart', (event) => {
      draggingGoalId = goalId;
      card.classList.add('dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', goalId);
      }
    });
    dragHandle.addEventListener('dragend', () => {
      draggingGoalId = null;
      card.classList.remove('dragging');
      clearDropMarks();
    });
    head.appendChild(dragHandle);

    const expandBtn = el('button', 'goal-expand');
    expandBtn.type = 'button';
    expandBtn.addEventListener('click', () => {
      if (expanded.has(goalId)) {
        expanded.delete(goalId);
      } else {
        expanded.add(goalId);
      }
      render();
    });
    head.appendChild(expandBtn);

    const titleBtn = el('button', 'goal-title');
    titleBtn.type = 'button';
    titleBtn.title = '点击修改标题';
    titleBtn.addEventListener('click', () => {
      editingGoalId = goalId;
      render();
    });
    head.appendChild(titleBtn);

    const pct = el('span', 'goal-pct');
    head.appendChild(pct);

    const deleteBtn = el('button', 'goal-delete', '✕');
    deleteBtn.type = 'button';
    deleteBtn.title = '删除目标';
    wireDelete(deleteBtn, '✕', () => {
      void (async () => {
        if (await run(() => api!.deleteGoal(goalId))) {
          expanded.delete(goalId);
          showToast('已删除目标');
        }
      })();
    });
    head.appendChild(deleteBtn);

    // 落点判定读 view.goals（不依赖 DOM 顺序，SPEC-038 风险项已确认）：
    // 同一分组内才允许放置；上半 -> 插到该卡之前，下半 -> 之后。
    card.addEventListener('dragover', (event) => {
      const source = draggingGoalId ? currentGoal(draggingGoalId) : undefined;
      const self = currentGoal(goalId);
      if (!source || !self || source.status !== self.status || source.id === goalId) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
      }
      const rect = card.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      clearDropMarks();
      card.classList.add(after ? 'drop-after' : 'drop-before');
    });
    card.addEventListener('dragleave', (event) => {
      const related = event.relatedTarget;
      if (related instanceof Node && card.contains(related)) {
        return;
      }
      card.classList.remove('drop-before', 'drop-after');
    });
    card.addEventListener('drop', (event) => {
      const source = draggingGoalId ? currentGoal(draggingGoalId) : undefined;
      const self = currentGoal(goalId);
      if (!source || !self || source.status !== self.status || source.id === goalId) {
        return;
      }
      event.preventDefault();
      const rect = card.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      const group = view.goals.filter((item) => item.status === self.status);
      const index = group.findIndex((item) => item.id === goalId);
      const beforeId = after
        ? index >= 0 && index + 1 < group.length
          ? group[index + 1]!.id
          : null
        : goalId;
      const movingId = source.id;
      draggingGoalId = null;
      clearDropMarks();
      void run(() => api!.moveGoal(movingId, beforeId));
    });

    const bar = el('div', 'goal-bar');
    const fill = el('i');
    bar.appendChild(fill);
    card.appendChild(bar);

    // meta 里的状态文案与卡片 is-done 类一样随组固定（status 变更即销毁重建）。
    const meta = el('div', 'goal-meta');
    meta.appendChild(el('span', 'status-dot'));
    meta.appendChild(el('span', undefined, goal.status === 'done' ? '已完成' : '进行中'));
    const metaCount = el('span');
    const metaTime = el('span');
    meta.appendChild(metaCount);
    meta.appendChild(metaTime);
    card.appendChild(meta);

    return {
      goalId,
      status: goal.status,
      card,
      head,
      expandBtn,
      titleBtn,
      titleEditor: null,
      pct,
      fill,
      metaCount,
      metaTime,
      detail: null,
    };
  }

  /** 卡片内字段原地更新；只在展开/收起或节点缺位时触碰结构。 */
  function updateCard(card: GoalCard, goal: AiGoal): void {
    card.titleBtn.textContent = goal.title;
    card.pct.textContent = `${goal.progress}%`;
    card.fill.style.width = `${goal.progress}%`;
    card.metaCount.textContent = `${goal.entries.length} 条记录`;
    card.metaTime.textContent = `更新 ${formatTime(goal.updatedAt)}`;

    const isExpanded = expanded.has(card.goalId);
    card.expandBtn.textContent = isExpanded ? '▾' : '▸';
    card.expandBtn.setAttribute('aria-expanded', String(isExpanded));
    card.expandBtn.setAttribute('aria-label', isExpanded ? '收起详情' : '展开详情');

    syncTitleEditor(card);

    if (isExpanded) {
      const detail = ensureDetail(card);
      // detail 恒为卡片末子节点；已挂载就不再 appendChild（避免同位移动）。
      if (detail.wrap.parentElement !== card.card) {
        card.card.appendChild(detail.wrap);
      }
      syncTimeline(card, goal);
      if (detail.progressRange && detail.progressValue) {
        // 滑杆聚焦（拖动中）不回写，避免推送把用户按住的滑杆拽回旧值；
        // 松手后的 change 会写库并推回同值。
        if (document.activeElement !== detail.progressRange) {
          detail.progressRange.value = String(goal.progress);
          detail.progressValue.textContent = `${goal.progress}%`;
        }
      }
    } else {
      card.detail?.wrap.remove();
    }
  }

  /** 编辑态：换入标题输入框；推送重渲时编辑框已就位，什么都不动（草稿/焦点存活）。 */
  function syncTitleEditor(card: GoalCard): void {
    if (editingGoalId === card.goalId) {
      if (!card.titleEditor) {
        card.titleEditor = createTitleEditor(card);
      }
      card.titleBtn.remove();
      if (!card.titleEditor.isConnected) {
        card.head.insertBefore(card.titleEditor, card.pct);
      }
      return;
    }
    if (card.titleEditor) {
      card.titleEditor.remove();
      card.titleEditor = null;
    }
    if (!card.titleBtn.isConnected) {
      card.head.insertBefore(card.titleBtn, card.pct);
    }
  }

  function createTitleEditor(card: GoalCard): HTMLInputElement {
    const input = el('input', 'goal-title-input') as HTMLInputElement;
    input.type = 'text';
    input.maxLength = 120;
    // 编辑开始那一刻的当前标题；此后推送不再重建此节点，草稿由节点存续保证。
    input.value = currentGoal(card.goalId)?.title ?? '';
    input.dataset.titleEditor = card.goalId;
    input.setAttribute('aria-label', '修改目标标题');
    let finished = false;

    const commit = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      const title = input.value.trim();
      editingGoalId = null;
      if (!title || title === (currentGoal(card.goalId)?.title ?? '')) {
        render();
        return;
      }
      void (async () => {
        if (!(await run(() => api!.updateGoalTitle(card.goalId, title)))) {
          render();
        }
      })();
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finished = true;
        editingGoalId = null;
        render();
      }
    });
    input.addEventListener('blur', commit);
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
    return input;
  }

  /** 展开详情惰性创建一次；输入框与条目列表分离——输入框永不重建（SPEC-038 关键设计）。 */
  function ensureDetail(card: GoalCard): GoalDetailRefs {
    if (card.detail) {
      return card.detail;
    }
    const goal = currentGoal(card.goalId);
    const wrap = el('div', 'goal-detail');

    let progressRange: HTMLInputElement | null = null;
    let progressValue: HTMLElement | null = null;
    if (goal?.status === 'active') {
      const row = el('div', 'progress-row');
      row.appendChild(el('span', 'progress-label', '进度'));
      const range = el('input') as HTMLInputElement;
      range.type = 'range';
      range.min = '0';
      range.max = '100';
      range.step = '5';
      range.value = String(goal.progress);
      range.setAttribute('aria-label', '目标进度');
      const value = el('span', 'progress-value', `${goal.progress}%`);
      range.addEventListener('input', () => {
        value.textContent = `${range.value}%`;
      });
      range.addEventListener('change', () => {
        void run(() => api!.setGoalProgress(card.goalId, Number(range.value)));
      });
      row.appendChild(range);
      row.appendChild(value);
      wrap.appendChild(row);
      progressRange = range;
      progressValue = value;
    }

    const actions = el('div', 'detail-actions');
    if (goal?.status === 'active') {
      const completeBtn = el('button', 'complete-btn', '标记完成');
      completeBtn.type = 'button';
      completeBtn.addEventListener('click', () => {
        void (async () => {
          if (await run(() => api!.completeGoal(card.goalId))) {
            expanded.add(card.goalId);
            showToast('目标已完成');
          }
        })();
      });
      actions.appendChild(completeBtn);
    } else {
      actions.appendChild(el('span', 'done-badge', '已完成'));
    }
    wrap.appendChild(actions);

    const entryInput = el('input', 'entry-input') as HTMLInputElement;
    entryInput.type = 'text';
    entryInput.maxLength = 500;
    entryInput.placeholder = '追加一条进展或问题，回车记录…';
    entryInput.dataset.entryInput = card.goalId;
    entryInput.setAttribute('aria-label', '追加记录');

    let kind: AiGoalEntryKind = entryKinds.get(card.goalId) ?? 'progress';
    const progressBtn = el('button', 'kind-btn', '进展');
    const issueBtn = el('button', 'kind-btn', '问题');
    progressBtn.type = 'button';
    issueBtn.type = 'button';
    const syncKind = (): void => {
      progressBtn.classList.toggle('on', kind === 'progress');
      issueBtn.classList.toggle('on', kind === 'issue');
    };
    syncKind();
    progressBtn.addEventListener('click', () => {
      kind = 'progress';
      entryKinds.set(card.goalId, kind);
      syncKind();
      entryInput.focus();
    });
    issueBtn.addEventListener('click', () => {
      kind = 'issue';
      entryKinds.set(card.goalId, kind);
      syncKind();
      entryInput.focus();
    });

    const submit = (): void => {
      const text = entryInput.value.trim();
      if (!text) {
        entryInput.focus();
        return;
      }
      // 先登记焦点目标：主进程的 push 通常会先于 invoke 结果到达。
      // SPEC-038 下输入框节点持久存在，推送重绘不再牵动它；登记仍保留，
      // 覆盖「卡片在结果返回前被销毁重建」（删除/换组）的极端时序。
      pendingEntryFocus = card.goalId;
      void (async () => {
        const ok = await run(() => api!.addGoalEntry(card.goalId, kind, text));
        if (ok) {
          // 清空「当前 DOM 中该目标的输入框」；查不到（卡片已被销毁）时
          // 兜底清闭包持有的持久节点，防止已提交文字复活。
          const live =
            listEl.querySelector<HTMLInputElement>(
              `input[data-entry-input="${cssEscape(card.goalId)}"]`,
            ) ?? entryInput;
          live.value = '';
        } else {
          pendingEntryFocus = null;
        }
      })();
    };
    entryInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });

    const sendBtn = el('button', 'entry-submit', '记录');
    sendBtn.type = 'button';
    sendBtn.addEventListener('click', submit);

    const entryAddRow = el('div', 'entry-add');
    entryAddRow.appendChild(entryInput);
    entryAddRow.appendChild(progressBtn);
    entryAddRow.appendChild(issueBtn);
    entryAddRow.appendChild(sendBtn);
    wrap.appendChild(entryAddRow);

    card.detail = {
      wrap,
      progressRange,
      progressValue,
      timeline: null,
      timelineEmpty: null,
      entryRows: new Map(),
      entryAddRow,
      entryInput,
    };
    return card.detail;
  }

  /** 条目列表按 entry.id 二级 diff：缺失补建、多余销毁、顺序移动。 */
  function syncTimeline(card: GoalCard, goal: AiGoal): void {
    const detail = card.detail;
    if (!detail) {
      return;
    }
    if (goal.entries.length === 0) {
      if (!detail.timelineEmpty) {
        detail.timelineEmpty = el('p', 'timeline-empty', '还没有记录，下面写第一条。');
      }
      placeBefore(detail.entryAddRow, detail.timelineEmpty, detail.timeline);
      return;
    }
    if (!detail.timeline) {
      detail.timeline = el('ul', 'timeline');
    }
    placeBefore(detail.entryAddRow, detail.timeline, detail.timelineEmpty);

    const seen = new Set<string>();
    for (let i = 0; i < goal.entries.length; i += 1) {
      const entry = goal.entries[i]!;
      seen.add(entry.id);
      let row = detail.entryRows.get(entry.id);
      if (!row) {
        row = buildEntryRow(card.goalId, entry);
        detail.entryRows.set(entry.id, row);
      }
      row.time.textContent = formatTime(entry.at);
      row.kind.textContent =
        entry.kind === 'issue' ? '问题' : entry.kind === 'done' ? '完成' : '进展';
      row.row.className = `entry entry-${entry.kind}`;
      row.text.textContent = entry.text;
      const expected = detail.timeline.children[i];
      if (expected !== row.row) {
        detail.timeline.insertBefore(row.row, expected ?? null);
      }
    }
    for (const [entryId, row] of [...detail.entryRows]) {
      if (!seen.has(entryId)) {
        row.row.remove();
        detail.entryRows.delete(entryId);
      }
    }
  }

  /** 把 wanted 挂到 anchor 之前，并把互斥的 other 摘出 DOM；已就位则不动。 */
  function placeBefore(
    anchor: HTMLElement,
    wanted: HTMLElement,
    other: HTMLElement | null,
  ): void {
    if (wanted.parentElement !== anchor.parentElement || wanted.nextElementSibling !== anchor) {
      anchor.before(wanted);
    }
    other?.remove();
  }

  function buildEntryRow(goalId: string, entry: AiGoalEntry): EntryRowRefs {
    const row = el('li', `entry entry-${entry.kind}`);
    row.appendChild(el('span', 'entry-dot'));
    const time = el('span', 'entry-time');
    row.appendChild(time);
    const kind = el('span', 'entry-kind');
    row.appendChild(kind);
    const text = el('span', 'entry-text');
    row.appendChild(text);

    const deleteBtn = el('button', 'entry-delete', '✕');
    deleteBtn.type = 'button';
    deleteBtn.title = '删除这条记录';
    wireDelete(deleteBtn, '✕', () => {
      void run(() => api!.deleteGoalEntry(goalId, entry.id));
    });
    row.appendChild(deleteBtn);
    return { row, time, kind, text };
  }

  /** 清理所有卡片的落点提示（拖拽结束 / 重绘前）。 */
  function clearDropMarks(): void {
    for (const node of Array.from(document.querySelectorAll('.goal.drop-before, .goal.drop-after'))) {
      node.classList.remove('drop-before', 'drop-after');
    }
  }

  /** 两段式删除：第一次点变成「确认」，3 秒内再点才执行。 */
  function wireDelete(
    button: HTMLButtonElement,
    label: string,
    action: () => void,
  ): void {
    button.addEventListener('click', () => {
      if (button.dataset.armed === '1') {
        button.dataset.armed = '0';
        button.classList.remove('danger');
        action();
        return;
      }
      button.dataset.armed = '1';
      button.textContent = '确认';
      button.classList.add('danger');
      window.setTimeout(() => {
        if (button.isConnected && button.dataset.armed === '1') {
          button.dataset.armed = '0';
          button.textContent = label;
          button.classList.remove('danger');
        }
      }, 3000);
    });
  }

  /* ---------------------------------------------------------------- 交互 */

  async function submitGoal(): Promise<void> {
    if (!api) {
      return;
    }
    const title = goalInput.value.trim();
    if (!title) {
      goalInput.focus();
      return;
    }
    if (await run(() => api.addGoal(title))) {
      goalInput.value = '';
      goalInput.focus();
    }
  }

  async function exportAll(): Promise<void> {
    if (!api || exporting) {
      return;
    }
    exporting = true;
    exportBtn.disabled = true;
    exportBtn.textContent = '导出中…';
    try {
      const result = await api.exportGoals();
      if (!result.ok) {
        showToast(result.message ?? '导出失败');
      } else if (!result.canceled) {
        showToast(`已导出到 ${result.path ?? '所选位置'}`);
      }
    } catch (err) {
      console.error('[goals] 导出失败', err);
      showToast('导出失败，详见日志');
    } finally {
      exporting = false;
      exportBtn.disabled = false;
      exportBtn.textContent = '导出';
    }
  }

  function bindStatic(): void {
    const titleIcon = document.getElementById('goals-title-icon');
    if (titleIcon) {
      titleIcon.innerHTML = window.aiIndicatorUi?.icon('goals') ?? '';
    }
    goalInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void submitGoal();
      }
    });
    addBtn.addEventListener('click', () => void submitGoal());
    exportBtn.addEventListener('click', () => void exportAll());
    closeBtn.addEventListener('click', () => {
      void api?.hideGoals();
    });
    dismissWarningBtn.addEventListener('click', () => {
      dismissedWarning = view.warning ?? null;
      render();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') {
        return;
      }
      if (editingGoalId) {
        editingGoalId = null;
        render();
        event.preventDefault();
        return;
      }
      // SPEC-033 键盘层级由内向外：标题编辑（上方分支）→ 其它文本输入框
      // 只失焦、不隐藏、不清草稿（草稿是用户劳动）→ 焦点不在输入框才隐藏窗口。
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        target.blur();
        event.preventDefault();
        return;
      }
      void api?.hideGoals();
    });
  }

  async function start(): Promise<void> {
    bindStatic();
    if (!api) {
      console.error('[goals] preload 未注入 API，目标窗口无法工作');
      return;
    }
    try {
      view = await api.getGoals();
    } catch (err) {
      console.error('[goals] 拉取目标数据失败', err);
      showToast('读取目标数据失败，详见日志');
    }
    render();
    api.onGoals((next) => {
      view = next;
      render();
    });
  }

  void start();
})();
