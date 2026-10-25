/**
 * 目标窗口真实集成检查（SPEC-024）。
 *
 * 与 check:ui 的区别：
 *  - check:ui 用假 preload 只验证渲染；
 *  - 本脚本使用**真实 GoalsWindow + 真 preload + 真 IPC 通道 + 真 GoalsStore**，
 *    在隐藏窗口里通过 DOM 事件走一遍新增 → 进度 → 记录 → 完成 → 导出 → 隐藏 → 重开。
 *
 * 不弹系统保存对话框：exportMarkdown 注入为直接写临时目录；
 * 托盘菜单与系统级焦点仍需 Windows 真机人工验收。
 */
const { app } = require('electron');
const { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const { GoalsStore } = require('../dist/main/goals-store.js');
const { GoalsWindow } = require('../dist/main/goals-window.js');
const { createGoalsHandlers } = require('../dist/main/goals-ipc.js');
const { drainGoalInbox } = require('../dist/main/goals-inbox.js');
const { registerIpcHandlers } = require('../dist/main/ipc.js');

const logger = {
  debug: () => undefined,
  info: (...args) => console.log('[goals-check]', ...args),
  warn: (...args) => console.warn('[goals-check]', ...args),
  error: (...args) => console.error('[goals-check]', ...args),
  logError: (message, err) => console.error('[goals-check]', message, err),
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function execute(win, code) {
  return win.webContents.executeJavaScript(code, true);
}

async function waitFor(label, fn, timeout = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`等待超时：${label}`);
}

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aiti-goals-window-'));
  const filePath = path.join(dir, 'goals.json');
  let exported = null;

  const store = new GoalsStore({ filePath, debounceMs: 0, logger });
  const goalsWindow = new GoalsWindow({ logger });
  const handlers = createGoalsHandlers(store, {
    openGoals: () => goalsWindow.show(),
    hideGoals: () => goalsWindow.hide(),
    exportMarkdown: async (markdown, suggestedName) => {
      const target = path.join(dir, suggestedName);
      writeFileSync(target, markdown, 'utf8');
      exported = { markdown, suggestedName, target };
      return { ok: true, path: target };
    },
    now: () => Date.now(),
  });

  registerIpcHandlers(
    {
      getSnapshot: () => ({
        aggregate: 'idle',
        runningCount: 0,
        counts: { idle: 0, starting: 0, running: 0, waiting: 0, success: 0, failed: 0, unknown: 0 },
        tasks: [],
        paused: false,
        notify: { popup: false, sound: false },
        version: 0,
        stripMode: false,
        hiddenCount: 0,
        displayTasks: [],
        clickThrough: false,
      }),
      handleTaskAction: async () => ({ ok: true }),
      handleNotifyAction: async () => ({ ok: false, level: 'L5-none', detail: 'fixture' }),
      togglePanel: () => true,
      lampDragged: () => ({ ok: true }),
      quit: () => undefined,
      reprobeTerminal: async () => ({ wtAvailable: false }),
      goalsGet: handlers.get,
      goalsAdd: handlers.add,
      goalsRemove: handlers.remove,
      goalsUpdateTitle: handlers.updateTitle,
      goalsSetProgress: handlers.setProgress,
      goalsComplete: handlers.complete,
      goalsAddEntry: handlers.addEntry,
      goalsDeleteEntry: handlers.deleteEntry,
      goalsMove: handlers.move,
      goalsExport: handlers.export,
      goalsHide: handlers.hide,
      openGoals: handlers.open,
    },
    logger,
  );
  store.onChange((view) => goalsWindow.setView(view));

  goalsWindow.show();
  const win = goalsWindow.getBrowserWindow();
  assert.ok(win, '目标窗口没有创建');
  // 隐藏窗口本体，避免测试时弹到用户桌面；DOM 仍在正常渲染。
  win.setOpacity(0);
  win.hide();

  try {
    await waitFor('goals 渲染器就绪', () =>
      execute(win, `!!document.querySelector('#goal-input')`),
    );

    // AC-16：空列表展示空态。
    assert.equal(
      await execute(win, `document.querySelector('#goals-empty').hidden`),
      false,
      '空列表应显示空态',
    );

    // AC-03：通过真实输入框 + Enter 新增。
    await execute(
      win,
      `(() => {
        const input = document.querySelector('#goal-input');
        input.value = '把 AI 任务指示灯做出来';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      })()`,
    );
    await waitFor('新增目标落库', () => store.getView().goals.length === 1);
    await waitFor('新增目标渲染', () => execute(win, `document.querySelectorAll('.goal').length === 1`));
    assert.ok(readFileSync(filePath, 'utf8').includes('把 AI 任务指示灯做出来'));
    const goalId = store.getView().goals[0].id;

    // SPEC-026：新增第二条目标并通过真实拖拽调整顺序。
    await execute(
      win,
      `(() => {
        const input = document.querySelector('#goal-input');
        input.value = '第二个目标';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      })()`,
    );
    await waitFor('第二条目标落库', () => store.getView().goals.length === 2);
    await waitFor('第二条目标渲染', () => execute(win, `document.querySelectorAll('.goal').length === 2`));
    await execute(
      win,
      `(() => {
        const cards = [...document.querySelectorAll('.goal')];
        const a = cards[0], b = cards[1];
        const handle = a.querySelector('.goal-drag');
        const dataTransfer = new DataTransfer();
        handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
        const rect = b.getBoundingClientRect();
        b.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, clientY: rect.top + rect.height - 2 }));
        b.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientY: rect.top + rect.height - 2 }));
        handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
      })()`,
    );
    await waitFor('拖拽排序落库', () => store.getView().goals[0]?.id === goalId);
    assert.deepEqual(
      store.getView().goals.map((goal) => goal.title),
      ['把 AI 任务指示灯做出来', '第二个目标'],
    );
    const afterDrag = JSON.parse(readFileSync(filePath, 'utf8'));
    assert.deepEqual(
      afterDrag.goals.map((goal) => goal.title),
      ['把 AI 任务指示灯做出来', '第二个目标'],
    );

    // 展开 → 进度 → 记录 → 完成。
    await execute(win, `document.querySelector('.goal-expand').click()`);
    await waitFor('详情展开', () => execute(win, `!!document.querySelector('.goal-detail')`));

    await execute(
      win,
      `(() => {
        const range = document.querySelector('.progress-row input[type="range"]');
        range.value = '40';
        range.dispatchEvent(new Event('input', { bubbles: true }));
        range.dispatchEvent(new Event('change', { bubbles: true }));
      })()`,
    );
    await waitFor('进度写入', () => store.getView().goals[0].progress === 40);

    await execute(win, `document.querySelectorAll('.kind-btn')[1].click()`);
    await execute(
      win,
      `(() => {
        const input = document.querySelector('.entry-input');
        input.value = 'Windows 真机验收还欠一次';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      })()`,
    );
    await waitFor('记录写入', () => store.getView().goals[0].entries.length === 1);
    assert.equal(store.getView().goals[0].entries[0].kind, 'issue');
    await waitFor('记录渲染', () =>
      execute(win, `document.querySelector('.entry-text')?.textContent === 'Windows 真机验收还欠一次'`),
    );

    await execute(win, `document.querySelector('.complete-btn').click()`);
    await waitFor('标记完成', () => store.getView().goals[0].status === 'done');
    assert.equal(store.getView().goals[0].progress, 100);
    await execute(win, `document.querySelector('.done-toggle').click()`);
    await waitFor('已完成分组可见', () => execute(win, `!!document.querySelector('.goal.is-done')`));

    // AC-15：导出（真实 IPC，写入注入目录而不是系统对话框）。
    await execute(win, `document.querySelector('#btn-export').click()`);
    await waitFor('导出完成', () => exported !== null);
    assert.ok(exported.markdown.includes('# 目标清单'));
    assert.ok(exported.markdown.includes('把 AI 任务指示灯做出来'));
    assert.ok(exported.markdown.includes('Windows 真机验收还欠一次'));
    assert.match(exported.suggestedName, /^goals-\d{4}-\d{2}-\d{2}\.md$/);

    // AC-02 / AC-19：Esc 隐藏；再经 OPEN_GOALS 通道重新打开，内容仍在。
    await execute(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitFor('Esc 隐藏窗口', () => !goalsWindow.isVisible);
    await execute(win, `window.aiIndicator.openGoals()`);
    await waitFor('经 IPC 重新打开窗口', () => goalsWindow.isVisible);
    win.setOpacity(0);
    await waitFor('重开后目标仍在', () => execute(win, `document.querySelectorAll('.goal').length >= 1`));

    // AC-10：flush 后重新加载文件，数据完整。
    store.flush();
    const reloaded = new GoalsStore({ filePath, debounceMs: 0, logger });
    const view = reloaded.getView();
    assert.equal(view.goals.length, 2);
    const reloadedFirst = view.goals.find((goal) => goal.id === goalId);
    assert.ok(reloadedFirst, 'first goal missing after reload');
    assert.equal(reloadedFirst.progress, 100);
    assert.equal(reloadedFirst.status, 'done');
    // 完成时自动追加一条 done 记录，所以这里应是 issue + done 两条。
    assert.equal(reloadedFirst.entries.length, 2);
    assert.deepEqual(
      reloadedFirst.entries.map((entry) => entry.kind).sort(),
      ['done', 'issue'],
    );
    // 拖拽后的顺序在文件中保留：第一条仍是先创建的目标。
    assert.equal(view.goals[0].id, goalId);

    // SPEC-027：收件箱导入一条进展，时间线立即出现并清空收件箱。
    const inboxPath = path.join(dir, 'goal-inbox.jsonl');
    writeFileSync(
      inboxPath,
      `${JSON.stringify({ goal: '把 AI 任务指示灯做出来', kind: 'progress', text: 'CLI 同步进来的一条进展' })}\n`,
      'utf8',
    );
    const drained = drainGoalInbox({ inboxPath, store });
    assert.equal(drained.applied, 1);
    assert.equal(drained.failed, 0);
    assert.equal(existsSync(inboxPath), false);
    const synced = store.getView().goals.find((goal) => goal.id === goalId);
    assert.equal(synced.entries[0].text, 'CLI 同步进来的一条进展');
    assert.equal(synced.entries[0].kind, 'progress');

    // SPEC-031：真实 IPC 下，主进程侧推送不得破坏窗口内的输入态。
    // 补足目标数量让列表可滚动（addGoal 从主进程侧直接写入，经 onChange 推送）。
    for (let i = 0; i < 8; i += 1) {
      store.addGoal(`批量目标 ${i + 1}`);
    }
    await waitFor('批量目标渲染', () =>
      execute(win, `document.querySelectorAll('.goal').length === 10`),
    );

    // 展开「第二个目标」，滚动到底部，记录滚动基准。
    const scrolled = await execute(win, `(() => {
      const card = [...document.querySelectorAll('.goal')].find(
        (c) => c.querySelector('.goal-title')?.textContent === '第二个目标',
      );
      if (!card) return null;
      card.querySelector('.goal-expand').click();
      const list = document.querySelector('#goals-list');
      list.scrollTop = list.scrollHeight;
      return list.scrollTop;
    })()`);
    assert.ok(scrolled !== null && scrolled > 0, 'SPEC-031 前置：列表未能滚动');

    // AC-01：时间线草稿 + 焦点 + 光标；主进程侧推送一条新记录。
    await execute(win, `(() => {
      const card = [...document.querySelectorAll('.goal')].find(
        (c) => c.querySelector('.goal-title')?.textContent === '第二个目标',
      );
      const input = card.querySelector('.entry-input');
      input.value = '真机前的草稿';
      input.focus();
      input.setSelectionRange(3, 3);
    })()`);
    const secondId = store.getView().goals.find((goal) => goal.title === '第二个目标').id;
    store.addEntry(secondId, 'progress', '主进程推送的新记录');
    await waitFor('推送的新记录渲染', () =>
      execute(win, `[...document.querySelectorAll('.entry-text')].some(n => n.textContent === '主进程推送的新记录')`),
    );
    const preserved = await execute(win, `(() => {
      const card = [...document.querySelectorAll('.goal')].find(
        (c) => c.querySelector('.goal-title')?.textContent === '第二个目标',
      );
      const input = card.querySelector('.entry-input');
      return {
        value: input?.value ?? null,
        focused: document.activeElement === input,
        caret: input === document.activeElement ? input.selectionStart : null,
        scrollTop: document.querySelector('#goals-list').scrollTop,
      };
    })()`);
    assert.equal(preserved.value, '真机前的草稿', 'SPEC-031/AC-01 草稿被推送清空');
    assert.equal(preserved.focused, true, 'SPEC-031/AC-01 焦点丢失');
    assert.equal(preserved.caret, 3, 'SPEC-031/AC-01 光标位置丢失');
    assert.equal(preserved.scrollTop, scrolled, 'SPEC-031/AC-03 滚动位置被重置');

    // AC-05：提交成功且推送先于 invoke 结果——最终输入框必须为空且焦点恢复，
    // 不允许快照/恢复逻辑把已提交文字"复活"回输入框（对新实现的回归锚）。
    await execute(win, `(() => {
      const card = [...document.querySelectorAll('.goal')].find(
        (c) => c.querySelector('.goal-title')?.textContent === '第二个目标',
      );
      const input = card.querySelector('.entry-input');
      input.value = '待提交的一条';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);
    await waitFor('提交的记录渲染', () =>
      execute(win, `[...document.querySelectorAll('.entry-text')].some(n => n.textContent === '待提交的一条')`),
    );
    await waitFor('提交后输入框清空且焦点恢复', () =>
      execute(win, `(() => {
        const card = [...document.querySelectorAll('.goal')].find(
          (c) => c.querySelector('.goal-title')?.textContent === '第二个目标',
        );
        const input = card.querySelector('.entry-input');
        return !!input && input.value === '' && document.activeElement === input;
      })()`),
    );

    // SPEC-033：输入框内 Esc 只失焦、不隐藏窗口、不清草稿。
    const escSleep = () => new Promise((resolve) => setTimeout(resolve, 200));

    // AC-01：时间线输入框。
    await execute(win, `(() => {
      const card = [...document.querySelectorAll('.goal')].find(
        (c) => c.querySelector('.goal-title')?.textContent === '第二个目标',
      );
      const input = card.querySelector('.entry-input');
      input.focus();
      input.value = 'Esc 层级的草稿';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    })()`);
    await escSleep();
    const escEntry = await execute(win, `(() => {
      const card = [...document.querySelectorAll('.goal')].find(
        (c) => c.querySelector('.goal-title')?.textContent === '第二个目标',
      );
      const input = card.querySelector('.entry-input');
      return { focused: document.activeElement === input, value: input?.value ?? null };
    })()`);
    assert.equal(goalsWindow.isVisible, true, 'SPEC-033/AC-01 输入框内 Esc 隐藏了窗口');
    assert.equal(escEntry.focused, false, 'SPEC-033/AC-01 Esc 后输入框未失焦');
    assert.equal(escEntry.value, 'Esc 层级的草稿', 'SPEC-033/AC-01 草稿被清空');

    // AC-02：新增目标输入框。
    await execute(win, `(() => {
      const input = document.querySelector('#goal-input');
      input.focus();
      input.value = '新增框的草稿';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    })()`);
    await escSleep();
    const escGoalInput = await execute(win, `(() => {
      const input = document.querySelector('#goal-input');
      return { focused: document.activeElement === input, value: input?.value ?? null };
    })()`);
    assert.equal(goalsWindow.isVisible, true, 'SPEC-033/AC-02 新增输入框内 Esc 隐藏了窗口');
    assert.equal(escGoalInput.focused, false, 'SPEC-033/AC-02 Esc 后新增输入框未失焦');
    assert.equal(escGoalInput.value, '新增框的草稿', 'SPEC-033/AC-02 新增输入框草稿被清空');

    // AC-05：标题编辑中的 Esc 仍退出编辑（还原标题）且不隐藏窗口。
    await execute(win, `(() => {
      const card = [...document.querySelectorAll('.goal')].find(
        (c) => c.querySelector('.goal-title')?.textContent === '第二个目标',
      );
      card.querySelector('.goal-title').click();
    })()`);
    await waitFor('标题编辑器出现', () => execute(win, `!!document.querySelector('.goal-title-input')`));
    await execute(win, `(() => {
      const editor = document.querySelector('.goal-title-input');
      editor.value = '改一半的标题';
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    })()`);
    await escSleep();
    const escTitle = await execute(win, `!document.querySelector('.goal-title-input')`);
    assert.equal(goalsWindow.isVisible, true, 'SPEC-033/AC-05 标题编辑中 Esc 隐藏了窗口');
    assert.equal(escTitle, true, 'SPEC-033/AC-05 Esc 未退出标题编辑');

    // AC-04：焦点不在输入框时 Esc 仍隐藏窗口（SPEC-024/AC-19 语义保持）。
    await execute(
      win,
      `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
    );
    await waitFor('SPEC-033/AC-04 Esc 隐藏窗口', () => !goalsWindow.isVisible);

    console.log('PASS: goals window real Electron/IPC integration (add → progress → entry → complete → export → hide → reopen → reload → inbox sync → SPEC-031 input preservation → SPEC-033 escape hierarchy)');
    process.exitCode = 0;
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    goalsWindow.destroy();
    store.dispose();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    // app.quit() 会以 0 退出并吞掉 process.exitCode；断言失败必须以非零码结束。
    app.exit(process.exitCode ?? 0);
  }
});
