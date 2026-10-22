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
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const { GoalsStore } = require('../dist/main/goals-store.js');
const { GoalsWindow } = require('../dist/main/goals-window.js');
const { createGoalsHandlers } = require('../dist/main/goals-ipc.js');
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
    assert.equal(view.goals.length, 1);
    assert.equal(view.goals[0].id, goalId);
    assert.equal(view.goals[0].progress, 100);
    assert.equal(view.goals[0].status, 'done');
    // 完成时自动追加一条 done 记录，所以这里应是 issue + done 两条。
    assert.equal(view.goals[0].entries.length, 2);
    assert.deepEqual(
      view.goals[0].entries.map((entry) => entry.kind).sort(),
      ['done', 'issue'],
    );

    console.log('PASS: goals window real Electron/IPC integration (add → progress → entry → complete → export → hide → reopen → reload)');
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
    app.quit();
  }
});
