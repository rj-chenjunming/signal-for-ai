/**
 * 目标清单窗口渲染逻辑（SPEC-024）。
 *
 * ============================================================================
 * 【Classic Script 约束】
 * ============================================================================
 * 本文件被 goals.html 以 `<script src="goals.js">`（**非** module）加载：
 *  - 禁止 import / export（含 `import type` 也会产生 `export {}`，导致白屏）；
 *  - 类型由 globals.d.ts 注入（AiGoal / AiGoalsView 等）。
 *
 * 【无业务状态】
 * 数据来自主进程推送（GoalsView）；本文件只持有渲染态（展开、编辑、确认删除）。
 * 所有用户输入一律用 textContent 写入，禁止 innerHTML 拼接。
 */

(() => {
  const api = window.aiIndicator;

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

  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function formatTime(at: number): string {
    const date = new Date(at);
    const now = new Date();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    if (date.getFullYear() !== now.getFullYear()) {
      return `${date.getFullYear()}-${mm}-${dd}`;
    }
    return `${mm}/${dd} ${hh}:${mi}`;
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
    const active = view.goals.filter((goal) => goal.status === 'active');
    const done = view.goals.filter((goal) => goal.status === 'done');

    listEl.replaceChildren();
    for (const goal of active) {
      listEl.appendChild(renderGoal(goal));
    }
    if (done.length > 0) {
      listEl.appendChild(renderDoneGroup(done));
    }

    const hasAny = view.goals.length > 0;
    emptyEl.hidden = hasAny;
    listEl.hidden = !hasAny;
    countEl.textContent = `${active.length} 个进行中 · ${done.length} 个已完成`;

    renderWarning();

    if (pendingEntryFocus) {
      const goalId = pendingEntryFocus;
      pendingEntryFocus = null;
      const input = listEl.querySelector<HTMLInputElement>(
        `input[data-entry-input="${goalId}"]`,
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

  function renderDoneGroup(done: AiGoal[]): HTMLElement {
    const group = el('section', 'done-group');
    const toggle = el(
      'button',
      'done-toggle',
      `${completedOpen ? '▾' : '▸'} 已完成（${done.length}）`,
    );
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(completedOpen));
    toggle.addEventListener('click', () => {
      completedOpen = !completedOpen;
      render();
    });
    group.appendChild(toggle);
    if (completedOpen) {
      for (const goal of done) {
        group.appendChild(renderGoal(goal));
      }
    }
    return group;
  }

  function renderGoal(goal: AiGoal): HTMLElement {
    const card = el('article', `goal${goal.status === 'done' ? ' is-done' : ''}`);
    card.dataset.goalId = goal.id;

    const head = el('div', 'goal-head');
    const isExpanded = expanded.has(goal.id);

    // SPEC-026：拖拽把手是唯一的拖动起点，避免在输入框/滑杆上误触排序。
    const dragHandle = el('button', 'goal-drag', '⠿');
    dragHandle.type = 'button';
    dragHandle.draggable = true;
    dragHandle.title = '拖拽排序';
    dragHandle.setAttribute('aria-label', '拖拽排序');
    dragHandle.addEventListener('dragstart', (event) => {
      draggingGoalId = goal.id;
      card.classList.add('dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', goal.id);
      }
    });
    dragHandle.addEventListener('dragend', () => {
      draggingGoalId = null;
      card.classList.remove('dragging');
      clearDropMarks();
    });
    head.appendChild(dragHandle);

    const expandBtn = el('button', 'goal-expand', isExpanded ? '▾' : '▸');
    expandBtn.type = 'button';
    expandBtn.setAttribute('aria-expanded', String(isExpanded));
    expandBtn.setAttribute('aria-label', isExpanded ? '收起详情' : '展开详情');
    expandBtn.addEventListener('click', () => {
      if (expanded.has(goal.id)) {
        expanded.delete(goal.id);
      } else {
        expanded.add(goal.id);
      }
      render();
    });
    head.appendChild(expandBtn);

    if (editingGoalId === goal.id) {
      head.appendChild(createTitleEditor(goal));
    } else {
      const titleBtn = el('button', 'goal-title', goal.title);
      titleBtn.type = 'button';
      titleBtn.title = '点击修改标题';
      titleBtn.addEventListener('click', () => {
        editingGoalId = goal.id;
        render();
      });
      head.appendChild(titleBtn);
    }

    head.appendChild(el('span', 'goal-pct', `${goal.progress}%`));

    const deleteBtn = el('button', 'goal-delete', '✕');
    deleteBtn.type = 'button';
    deleteBtn.title = '删除目标';
    wireDelete(deleteBtn, '✕', () => {
      void (async () => {
        if (await run(() => api!.deleteGoal(goal.id))) {
          expanded.delete(goal.id);
          showToast('已删除目标');
        }
      })();
    });
    head.appendChild(deleteBtn);
    card.appendChild(head);

    // 落点判定：同一分组内才允许放置；上半 -> 插到该卡之前，下半 -> 之后。
    card.addEventListener('dragover', (event) => {
      const source = draggingGoalId
        ? view.goals.find((item) => item.id === draggingGoalId)
        : undefined;
      if (!source || source.status !== goal.status || source.id === goal.id) {
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
      const source = draggingGoalId
        ? view.goals.find((item) => item.id === draggingGoalId)
        : undefined;
      if (!source || source.status !== goal.status || source.id === goal.id) {
        return;
      }
      event.preventDefault();
      const rect = card.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      const group = view.goals.filter((item) => item.status === goal.status);
      const index = group.findIndex((item) => item.id === goal.id);
      const beforeId = after
        ? index >= 0 && index + 1 < group.length
          ? group[index + 1]!.id
          : null
        : goal.id;
      const movingId = source.id;
      draggingGoalId = null;
      clearDropMarks();
      void run(() => api!.moveGoal(movingId, beforeId));
    });

    const bar = el('div', 'goal-bar');
    const fill = el('i');
    fill.style.width = `${goal.progress}%`;
    bar.appendChild(fill);
    card.appendChild(bar);

    const meta = el('div', 'goal-meta');
    meta.appendChild(el('span', 'status-dot'));
    meta.appendChild(el('span', undefined, goal.status === 'done' ? '已完成' : '进行中'));
    meta.appendChild(el('span', undefined, `${goal.entries.length} 条记录`));
    meta.appendChild(el('span', undefined, `更新 ${formatTime(goal.updatedAt)}`));
    card.appendChild(meta);

    if (isExpanded) {
      card.appendChild(renderDetail(goal));
    }
    return card;
  }

  function createTitleEditor(goal: AiGoal): HTMLInputElement {
    const input = el('input', 'goal-title-input') as HTMLInputElement;
    input.type = 'text';
    input.maxLength = 120;
    input.value = goal.title;
    input.setAttribute('aria-label', '修改目标标题');
    let finished = false;

    const commit = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      const title = input.value.trim();
      editingGoalId = null;
      if (!title || title === goal.title) {
        render();
        return;
      }
      void (async () => {
        if (!(await run(() => api!.updateGoalTitle(goal.id, title)))) {
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

  function renderDetail(goal: AiGoal): HTMLElement {
    const wrap = el('div', 'goal-detail');

    if (goal.status === 'active') {
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
        void run(() => api!.setGoalProgress(goal.id, Number(range.value)));
      });
      row.appendChild(range);
      row.appendChild(value);
      wrap.appendChild(row);
    }

    const actions = el('div', 'detail-actions');
    if (goal.status === 'active') {
      const completeBtn = el('button', 'complete-btn', '标记完成');
      completeBtn.type = 'button';
      completeBtn.addEventListener('click', () => {
        void (async () => {
          if (await run(() => api!.completeGoal(goal.id))) {
            expanded.add(goal.id);
            showToast('目标已完成');
          }
        })();
      });
      actions.appendChild(completeBtn);
    } else {
      actions.appendChild(el('span', 'done-badge', '已完成'));
    }
    wrap.appendChild(actions);

    wrap.appendChild(renderTimeline(goal));
    wrap.appendChild(renderEntryAdd(goal));
    return wrap;
  }

  function renderTimeline(goal: AiGoal): HTMLElement {
    if (goal.entries.length === 0) {
      return el('p', 'timeline-empty', '还没有记录，下面写第一条。');
    }
    const timeline = el('ul', 'timeline');
    for (const entry of goal.entries) {
      const row = el('li', `entry entry-${entry.kind}`);
      row.appendChild(el('span', 'entry-dot'));
      row.appendChild(el('span', 'entry-time', formatTime(entry.at)));
      const label =
        entry.kind === 'issue' ? '问题' : entry.kind === 'done' ? '完成' : '进展';
      row.appendChild(el('span', 'entry-kind', label));
      row.appendChild(el('span', 'entry-text', entry.text));

      const deleteBtn = el('button', 'entry-delete', '✕');
      deleteBtn.type = 'button';
      deleteBtn.title = '删除这条记录';
      wireDelete(deleteBtn, '✕', () => {
        void run(() => api!.deleteGoalEntry(goal.id, entry.id));
      });
      row.appendChild(deleteBtn);
      timeline.appendChild(row);
    }
    return timeline;
  }

  function renderEntryAdd(goal: AiGoal): HTMLElement {
    const row = el('div', 'entry-add');
    const input = el('input', 'entry-input') as HTMLInputElement;
    input.type = 'text';
    input.maxLength = 500;
    input.placeholder = '追加一条进展或问题，回车记录…';
    input.dataset.entryInput = goal.id;
    input.setAttribute('aria-label', '追加记录');

    let kind: AiGoalEntryKind = entryKinds.get(goal.id) ?? 'progress';
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
      entryKinds.set(goal.id, kind);
      syncKind();
      input.focus();
    });
    issueBtn.addEventListener('click', () => {
      kind = 'issue';
      entryKinds.set(goal.id, kind);
      syncKind();
      input.focus();
    });

    const submit = (): void => {
      const text = input.value.trim();
      if (!text) {
        input.focus();
        return;
      }
      // 先登记焦点目标：主进程的 push 通常会先于 invoke 结果到达，
      // 否则重绘后输入框会失去焦点。
      pendingEntryFocus = goal.id;
      void (async () => {
        const ok = await run(() => api!.addGoalEntry(goal.id, kind, text));
        if (ok) {
          input.value = '';
        } else {
          pendingEntryFocus = null;
        }
      })();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });

    const sendBtn = el('button', 'entry-submit', '记录');
    sendBtn.type = 'button';
    sendBtn.addEventListener('click', submit);

    row.appendChild(input);
    row.appendChild(progressBtn);
    row.appendChild(issueBtn);
    row.appendChild(sendBtn);
    return row;
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
