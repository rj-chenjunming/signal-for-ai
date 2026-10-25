/** Run with Electron after build. Hidden fixture windows; never loads local config,
 * starts monitors, reads tool data, or modifies the running indicator instance. */
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { TaskStore } = require('../dist/main/store.js');
const { resolveCanvasSize } = require('../dist/main/overlay-layout.js');
app.disableHardwareAcceleration();
// Keep the runner alive between isolated fixture windows.
app.on('window-all-closed', () => {});
const out = path.resolve(__dirname, '../logs/spec012-ui');
mkdirSync(out, { recursive: true });
const states = ['running', 'waiting', 'success', 'failed', 'starting', 'idle', 'unknown'];
let fixture;
let goalsOpened = 0;
const goalMoves = [];
const taskActionEvents = [];
ipcMain.on('ui-fixture', event => { event.returnValue = fixture; });
ipcMain.on('ui-goal-open', () => { goalsOpened += 1; });
ipcMain.on('ui-goal-move', (_event, payload) => { goalMoves.push(payload); });
// SPEC-032：记录夹具渲染器发出的任务行动作（内容仅用于调试，不参与断言）。
ipcMain.on('ui-task-action', (_event, payload) => { taskActionEvents.push(payload); });
// SPEC-031 AC-04：收到提交尝试 → 先推送新视图（复现"推送先于 invoke 结果"），再放行失败结果。
ipcMain.on('ui-entry-attempt', event => {
  const pushed = JSON.parse(JSON.stringify(goalsFixture()));
  pushed.goals.find(goal => goal.id === 'g2').entries.push({ id: 'e9', at: Date.now(), kind: 'progress', text: '推送带来的新记录' });
  event.sender.send('ui-goals-push', pushed);
  setTimeout(() => event.sender.send('ui-entry-resolve'), 50);
});
const results = [];
function snapshot(count, paused = false, goalsSummary = null) {
  const store = new TaskStore(Array.from({ length: count }, (_, i) => ({ id: `fixture-${i}`, name: ['Codex', 'dsh', 'WorkBuddy'][i % 3], enabled: true, monitor: { type: 'webhook', listen: '127.0.0.1', path: `/fixture/${i}` } })));
  const s = store.getSnapshot();
  s.version = 1; s.paused = paused; s.aggregate = 'running'; s.runningCount = 1;
  s.tasks = s.tasks.map((t, i) => ({ ...t, toolKind: ['codex', 'dsh', 'dsh-web', 'workbuddy', 'zcode'][i % 5], status: states[i % 7], paused, unread: i % 7 === 2, portLabel: '很长的工具标签与端口名称', name: i === 0 ? 'Codex · 很长的任务名称 <b>纯文本</b>' : t.name, message: '示例任务状态 · 长文本自动换行，其他操作收进更多菜单。', startedAt: Date.now() - 127000, durationMs: 127000 }));
  s.displayTasks = s.tasks;
  // SPEC-040：与 shared/visibility.ts 的 shouldShowStrip 同口径——可显示 ≥1 行就灯带。
  s.stripMode = count >= 1 || (goalsSummary !== null && goalsSummary.active > 0);
  if (goalsSummary !== null) s.goalsSummary = goalsSummary;
  s.counts = Object.fromEntries(states.map(state => [state, s.tasks.filter(t => t.status === state).length]));
  return s;
}
function goalsFixture() {
  const now = Date.now();
  const goal = (id, title, progress, status, entries) => ({
    id, title, progress, status,
    createdAt: now - 86400000 * 3,
    updatedAt: now - 3600000,
    ...(status === 'done' ? { completedAt: now - 1800000 } : {}),
    entries,
  });
  const entry = (id, at, kind, text) => ({ id, at, kind, text });
  return {
    warning: '主文件损坏，已从备份恢复数据',
    goals: [
      goal('g1', '把 AI 任务指示灯 <b>做出来</b>', 40, 'active', [
        entry('e3', now - 60000, 'issue', 'Windows 真机验收还欠一次'),
        entry('e2', now - 3600000, 'progress', 'IPC 与窗口接通'),
        entry('e1', now - 86400000, 'done', '规格与 Red 测试完成'),
        // SPEC-034：跨年时间线记录——固定时间戳（2025-10-19 14:03 本地时区），
        // 渲染层必须显示 YYYY-MM-DD HH:mm，与主进程 formatGoalTime 同构。
        entry('e5', new Date(2025, 9, 19, 14, 3).getTime(), 'progress', '跨年的一条进展记录'),
      ]),
      goal('g2', '把周报整理成模板', 65, 'active', []),
      goal('g3', '读完《设计数据密集型应用》', 20, 'active', []),
      goal('g4', '每周跑步 3 次', 66, 'active', []),
      goal('g5', '清理积压的 issue', 10, 'active', []),
      goal('g6', '早期目标示例', 100, 'done', [entry('e4', now - 7200000, 'done', '标记完成')]),
    ],
  };
}
async function page(role, size, data) {
  fixture = data;
  const win = new BrowserWindow({ ...size, show: false, frame: false, transparent: role === 'overlay', webPreferences: { preload: path.join(__dirname, 'ui-render-preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(path.resolve(__dirname, `../dist/renderer/${role}.html`));
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  return win;
}
async function checkOverlay(count, dock, goalsSummary = null) {
  const goalRow = goalsSummary !== null && goalsSummary.active > 0 ? 1 : 0;
  const rows = count + goalRow;
  // SPEC-040：stripMode 已含目标行语义（≥1 行即灯带），画布直接按行数走新签名（无 forceStrip 参）。
  const forceStrip = count >= 1 || goalRow > 0;
  const size = resolveCanvasSize(28, rows, 300, dock, 400);
  // SPEC-040：count=1 不注入 overlayMessage —— 94px 高的单行画布会被常驻 toast 盖住
  // 唯一的图标行（count=3 画布高、行在 toast 之上不受影响），留下干净的形态证据图。
  const overlayMessage = goalsSummary || count === 1 ? undefined : '无法定位终端：未配置可用的 cwd / logFile，且窗口聚焦失败';
  const win = await page('overlay', size, { dock, snapshot: snapshot(count, false, goalsSummary), overlayMessage });
  try {
    const value = await win.webContents.executeJavaScript(`(() => {
      const rows = document.querySelector('#strip-rows');
      const rect = el => { const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; };
      const strip = document.querySelector('#lamp-strip'); const core = document.querySelector('#lamp-core');
      const points = [...document.querySelectorAll('.strip-row')].map(row => {
        const dot = row.querySelector('.strip-dot');
        return {row:rect(row), dot: dot ? rect(dot) : null, svg:!!row.querySelector('svg'), hasDot: !!dot};
      });
      // SPEC-035 特征锚：状态文案经共享/本地 statusLabel 输出保持一致（首行 running → 「运行中」）。
      const firstAria = document.querySelector('.strip-row')?.getAttribute('aria-label') ?? null;
      if (rows) { rows.scrollTop=rows.scrollHeight; rows.scrollLeft=rows.scrollWidth; }
      const last=document.querySelector('.strip-row:last-child');
      const toast=document.querySelector('.lamp-toast');
      const goal = (() => {
        const row = document.querySelector('.strip-goal-row');
        if (!row) return null;
        const ring = row.querySelector('.strip-goal-ring');
        const separator = getComputedStyle(row, '::before');
        return {
          label: row.querySelector('.strip-port')?.textContent ?? null,
          icon: !!row.querySelector('svg'),
          progress: ring ? getComputedStyle(ring).getPropertyValue('--goal-progress').trim() : null,
          ringVisible: ring ? getComputedStyle(ring).display !== 'none' : false,
          height: row.offsetHeight,
          borderTopWidth: getComputedStyle(row).borderTopWidth,
          separator: { content: separator.content, width: separator.width, height: separator.height, background: separator.backgroundColor },
        };
      })();
      const rowsScroll = {
        scrollHeight: rows.scrollHeight, clientHeight: rows.clientHeight,
        scrollWidth: rows.scrollWidth, clientWidth: rows.clientWidth,
        // 滚动条会吃掉 clientWidth/clientHeight；为 0 才说明没有常驻滚动条。
        gutterX: rows.offsetWidth - rows.clientWidth,
        gutterY: rows.offsetHeight - rows.clientHeight,
      };
      return {stripHidden:strip.hidden,coreHidden:core.hidden,bodyWidth:document.body.scrollWidth,bodyHeight:document.body.scrollHeight,points,firstAria,goal,rowsScroll,last:last&&rect(last),viewport:rect(rows),width:innerWidth,height:innerHeight,toastHeight:toast.offsetHeight,toastWrap:getComputedStyle(toast).whiteSpace,aiUiWired:typeof window.aiUi?.statusLabel==='function'&&typeof window.aiUi?.formatTime==='function'&&typeof window.aiUi?.el==='function'};
    })()`);
    assert.equal(value.stripHidden, !forceStrip); assert.equal(value.coreHidden, forceStrip);
    // SPEC-035：shared-ui.js 必须先于窗口脚本加载并挂好 window.aiUi。
    assert.equal(value.aiUiWired, true, 'overlay 页共享助手未接线');
    assert.equal(value.toastWrap, 'nowrap'); assert.ok(value.toastHeight <= 36, 'narrow toast became vertical text');
    assert.ok(value.bodyWidth <= size.width && value.bodyHeight <= size.height, 'body exceeds canvas');
    // SPEC-035 特征锚：首行 running 的状态文案必须是「运行中」（statusLabel 输出口径）。
    // SPEC-040：count=1 也是灯带（单工具显示图标行），同样断言；count=0 无行可断言。
    if (count >= 1) {
      assert.ok(/运行中$/.test(value.firstAria ?? ''), `overlay 行状态文案漂移：${value.firstAria}`);
    }
    for (const { row, dot, svg } of value.points.filter(point => point.hasDot)) {
      assert.ok(svg, 'missing local SVG'); assert.ok(row.width >= 32 && row.height >= 32, 'target too small');
      assert.ok(dot.x >= row.x && dot.right <= row.right && dot.y >= row.y && dot.bottom <= row.bottom, 'status dot clipped by target');
    }
    if (goalRow > 0) {
      assert.ok(value.goal, 'goal row missing');
      assert.ok(value.goal.icon, 'goal icon missing');
      assert.equal(value.goal.label, `目标 ${goalsSummary.active}`);
      assert.equal(value.goal.progress, String(goalsSummary.progress));
      assert.equal(value.goal.ringVisible, dock === 'none', 'progress ring should hide in docked dot mode');
      // SPEC-028：目标行必须落在 32px 行节奏内，不能把滚动容器撑出溢出/常驻滚动条。
      assert.equal(value.rowsScroll.gutterX, 0, 'stray scrollbar beside the goal row (x gutter)');
      assert.equal(value.rowsScroll.gutterY, 0, 'stray scrollbar beside the goal row (y gutter)');
      assert.ok(value.rowsScroll.scrollHeight <= value.rowsScroll.clientHeight, 'goal row overflows the rows container vertically');
      assert.ok(value.rowsScroll.scrollWidth <= value.rowsScroll.clientWidth, 'goal row overflows the rows container horizontally');
      assert.equal(value.goal.height, 32, 'goal row must keep the 32px row rhythm');
      // SPEC-028：分隔线是直线且不占布局高度（border-top 会在 8px 圆角上画出弯钩）。
      // SPEC-028：分隔线是直线且不占布局高度（border-top 会在 8px 圆角上画出弯钩）。
      // 顶部横排点阵的行是横向排列的，分隔线必须竖着画；其余形态是横线。
      if (dock === 'top') {
        assert.equal(value.goal.separator.width, '1px', 'docked-top goal row needs a vertical divider');
        assert.ok(parseFloat(value.goal.separator.height) >= 16, 'docked-top divider must span most of the row height');
      } else {
        assert.equal(value.goal.separator.height, '1px', 'goal row separator must be a 1px line');
        assert.ok(parseFloat(value.goal.separator.width) >= 16, 'goal row divider must span most of the row width');
      }
      assert.equal(value.goal.borderTopWidth, '0px', 'goal row must not paint a rounded border-top hook');
      assert.equal(value.goal.separator.content, '""', 'goal row separator missing');
      assert.notEqual(value.goal.separator.background, 'rgba(0, 0, 0, 0)', 'goal row separator must be visible');
      const before = goalsOpened;
      await win.webContents.executeJavaScript(`document.querySelector('.strip-goal-row').click()`);
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(goalsOpened, before + 1, 'clicking goal row must open goals window');
    } else {
      assert.equal(value.goal, null, 'goal row must not render without active goals');
    }
    if (value.last) {
      assert.ok(value.last.right <= value.viewport.right + 1 && value.last.bottom <= value.viewport.bottom + 1, 'last target unreachable after scroll');
      assert.ok(value.last.right <= size.width && value.last.bottom <= size.height, 'last target outside window');
    }
    if (count === 3 && !goalsSummary) writeFileSync(path.join(out, `overlay-${dock}.png`), (await win.webContents.capturePage()).toPNG());
    // SPEC-040：单工具形态（总灯 + 1 行图标）留目视证据。
    if (count === 1 && !goalsSummary) writeFileSync(path.join(out, `overlay-single-${dock}.png`), (await win.webContents.capturePage()).toPNG());
    if (goalsSummary && dock === 'none') writeFileSync(path.join(out, `overlay-goals-${count}.png`), (await win.webContents.capturePage()).toPNG());
    // SPEC-028：贴边点阵的目标行必须留一张截图，作为「框线/滚动条」回归的目视证据。
    if (goalsSummary && dock !== 'none') writeFileSync(path.join(out, `overlay-goals-${dock}-${count}.png`), (await win.webContents.capturePage()).toPNG());
    results.push({ role: 'overlay', count, dock, goals: goalsSummary !== null, ok: true });
  } finally { win.destroy(); }
}
async function checkPanel(theme, count, paused = false, message) {
  nativeTheme.themeSource = theme;
  const win = await page('panel', { width: 420, height: 520 }, { dock: 'none', snapshot: snapshot(count, paused), message });
  try {
    const value = await win.webContents.executeJavaScript(`(() => {
      const list=document.querySelector('#panel-list'); const first=document.querySelector('.task-row');
      return {empty:!document.querySelector('#panel-empty').hidden,width:document.body.scrollWidth,height:document.body.scrollHeight,scroll:list.scrollHeight>list.clientHeight,
        name:first?.querySelector('.task-name').textContent, injected:!!first?.querySelector('.task-name b'),primary:first?.querySelector('.primary').textContent,
        statusText:first?.querySelector('.task-status-label')?.textContent ?? null,
        aiUiWired:typeof window.aiUi?.statusLabel==='function'&&typeof window.aiUi?.formatTime==='function'&&typeof window.aiUi?.el==='function',
        missingLogHidden:first?.querySelector('[data-action="open_log"]').hidden,btn:document.querySelector('#btn-pause').textContent,
        feedback:(()=>{const t=document.querySelector('.panel-toast');if(!t)return null;const r=t.getBoundingClientRect();return {text:t.textContent,width:r.width,bottom:r.bottom,top:r.top,children:t.children.length};})()};
    })()`);
    assert.equal(value.empty, count === 0); assert.ok(value.width <= 420 && value.height <= 520, 'panel body overflow');
    // SPEC-035：shared-ui.js 必须先于窗口脚本加载并挂好 window.aiUi。
    assert.equal(value.aiUiWired, true, 'panel 页共享助手未接线');
    if (count) { assert.equal(value.primary, '切回工具'); assert.ok(value.missingLogHidden); assert.equal(value.injected, false);
      // SPEC-035 特征锚：首行 running 的状态文案以「运行中」开头（panel 侧 label 口径）。
      // 暂停夹具下标签显示「监控已暂停」，不在此锚的范围内。
      if (!paused) assert.ok((value.statusText ?? '').startsWith('运行中'), `panel 状态文案漂移：${value.statusText}`); }
    if (count >= 7) assert.ok(value.scroll, 'long panel list must scroll');
    assert.equal(value.btn, paused ? '恢复监控' : '暂停 30 分钟');
    if (message) { assert.equal(value.feedback?.text, message); assert.equal(value.feedback.children, 0); assert.ok(value.feedback.width >= 300 && value.feedback.top >= 0 && value.feedback.bottom <= 520, 'feedback clipped'); }
    writeFileSync(path.join(out, `panel-${theme}-${count}${paused ? '-paused' : ''}${message ? '-feedback' : ''}.png`), (await win.webContents.capturePage()).toPNG());
    results.push({ role: 'panel', theme, count, paused, feedback: !!message, ok: true });
  } finally { win.destroy(); }
}
async function checkGoals(theme, empty = false) {
  nativeTheme.themeSource = theme;
  const win = await page('goals', { width: 560, height: 640 }, { goalsView: empty ? { goals: [] } : goalsFixture() });
  try {
    const value = await win.webContents.executeJavaScript(`(() => {
      const list = document.querySelector('#goals-list');
      const first = document.querySelector('.goal');
      if (first) first.querySelector('.goal-expand').click();
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
        const entry = document.querySelector('.entry');
        const range = document.querySelector('.progress-row input[type="range"]');
        resolve({
          bodyWidth: document.body.scrollWidth, bodyHeight: document.body.scrollHeight,
          emptyHidden: document.querySelector('#goals-empty').hidden,
          title: first ? first.querySelector('.goal-title').textContent : null,
          injected: !!document.querySelector('.goal-title b'),
          count: document.querySelector('#goals-count').textContent,
          entryCount: document.querySelectorAll('.entry').length,
          entryText: entry ? entry.querySelector('.entry-text').textContent : null,
          entryKind: entry ? entry.querySelector('.entry-kind').textContent : null,
          crossYearTime: [...document.querySelectorAll('.entry-time')]
            .find(node => node.textContent.startsWith('2025-10-19'))?.textContent ?? null,
          aiUiWired:typeof window.aiUi?.statusLabel==='function'&&typeof window.aiUi?.formatTime==='function'&&typeof window.aiUi?.el==='function',
          range: range ? range.value : null,
          warningHidden: document.querySelector('#goals-warning').hidden,
          warningText: document.querySelector('#goals-warning-text').textContent,
          exportText: document.querySelector('#btn-export').textContent,
          deleteLabels: [...document.querySelectorAll('.goal-delete, .entry-delete')].map(button => button.textContent),
          addPlaceholder: document.querySelector('#goal-input').placeholder,
          scroll: list.scrollHeight > list.clientHeight,
        });
      })));
    })()`);
    assert.ok(value.bodyWidth <= 560 && value.bodyHeight <= 640, 'goals body overflow');
    // SPEC-035：shared-ui.js 必须先于窗口脚本加载并挂好 window.aiUi（goals.ts 加载即解构）。
    assert.equal(value.aiUiWired, true, 'goals 页共享助手未接线');
    assert.equal(value.exportText, '导出');
    assert.equal(value.addPlaceholder, '新增目标，回车创建…');
    if (empty) {
      assert.equal(value.emptyHidden, false, 'empty state must show');
      assert.equal(value.count, '0 个进行中 · 0 个已完成');
    } else {
      assert.equal(value.emptyHidden, true);
      assert.equal(value.injected, false, 'goal title must be rendered as text');
      assert.ok(value.title.includes('<b>'), 'unsafe title should stay literal text');
      assert.equal(value.count, '5 个进行中 · 1 个已完成');
      assert.equal(value.entryCount, 4);
      assert.equal(value.entryKind, '问题');
      assert.equal(value.entryText, 'Windows 真机验收还欠一次');
      assert.equal(value.range, '40');
      // SPEC-034：跨年条目的时间必须带时间部分，与主进程 formatGoalTime 同构。
      const crossExpected = '2025-10-19 14:03';
      assert.equal(value.crossYearTime, crossExpected, 'SPEC-034 跨年时间格式与 formatGoalTime 不一致');
      assert.equal(value.warningHidden, false);
      assert.equal(value.warningText, '主文件损坏，已从备份恢复数据');
      assert.ok(value.deleteLabels.length > 0, 'delete affordances missing');
      assert.deepEqual(value.deleteLabels, value.deleteLabels.map(() => '✕'), 'delete buttons must not start armed');
      assert.equal(value.scroll, true, 'long goal list must scroll');

      // SPEC-026：模拟拖拽，断言把手、落点提示与 move 请求参数。
      const drag = await win.webContents.executeJavaScript(`(() => {
        const cards = [...document.querySelectorAll('.goal')];
        const a = cards[0], b = cards[1], c = cards[2];
        const handle = a.querySelector('.goal-drag');
        const dataTransfer = new DataTransfer();
        handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
        const dragging = a.classList.contains('dragging');
        const rectB = b.getBoundingClientRect();
        b.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, clientY: rectB.top + 2 }));
        const beforeMark = b.classList.contains('drop-before');
        const rectC = c.getBoundingClientRect();
        c.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, clientY: rectC.top + rectC.height - 2 }));
        const afterMark = c.classList.contains('drop-after');
        b.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientY: rectB.top + 2 }));
        handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
        return { handle: !!handle, dragging, beforeMark, afterMark, aId: a.dataset.goalId, bId: b.dataset.goalId };
      })()`);
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(drag.handle, true, 'drag handle missing');
      assert.equal(drag.dragging, true, 'dragged card should be marked');
      assert.equal(drag.beforeMark, true, 'upper half should show before mark');
      assert.equal(drag.afterMark, true, 'lower half should show after mark');
      assert.deepEqual(goalMoves[0], { id: drag.aId, beforeId: drag.bId });
    }
    writeFileSync(path.join(out, `goals-${theme}${empty ? '-empty' : ''}.png`), (await win.webContents.capturePage()).toPNG());
    results.push({ role: 'goals', theme, empty, ok: true });
  } finally { win.destroy(); }
}
// SPEC-031：数据推送重绘不得破坏输入态（草稿、光标、焦点、滚动）。
// 每个 AC 独立收集失败，一次 Red 能同时暴露全部缺口；最后统一断言。
async function checkGoalsInputPreservation(theme) {
  nativeTheme.themeSource = theme;
  const view = goalsFixture();
  const draft = '尚未提交的草稿一句';
  const win = await page('goals', { width: 560, height: 640 }, { goalsView: view, entrySubmitMode: 'fail-with-push' });
  const failures = [];
  const step = async (label, fn) => {
    try { await fn(); } catch (err) { failures.push(`${label}: ${err.message}`); }
  };
  const push = async (mutate) => {
    const pushed = JSON.parse(JSON.stringify(view));
    mutate(pushed);
    win.webContents.send('ui-goals-push', pushed);
    await new Promise(resolve => setTimeout(resolve, 150));
  };
  try {
    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('.goal')?.querySelector('.goal-expand')?.click();
    })()`);
    await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');

    await step('AC-01 时间线草稿/焦点/光标', async () => {
      await win.webContents.executeJavaScript(`(() => {
        const input = document.querySelector('.entry-input');
        input.value = ${JSON.stringify(draft)};
        input.focus();
        input.setSelectionRange(3, 3);
      })()`);
      // 推送的新记录必须落在已展开的 g1 上——未展开卡片的时间线本就不在 DOM 里。
      await push(p => { p.goals.find(g => g.id === 'g1').entries.push({ id: 'e8', at: Date.now(), kind: 'progress', text: '推送带来的新记录' }); });
      const after = await win.webContents.executeJavaScript(`(() => {
        const input = document.querySelector('.entry-input');
        return {
          value: input?.value ?? null,
          focused: document.activeElement === input,
          caret: input === document.activeElement ? input.selectionStart : null,
          pushedEntry: [...document.querySelectorAll('.entry-text')].some(n => n.textContent === '推送带来的新记录'),
        };
      })()`);
      assert.equal(after.value, draft, '草稿被推送清空');
      assert.equal(after.focused, true, '焦点丢失');
      assert.equal(after.caret, 3, '光标位置丢失');
      assert.equal(after.pushedEntry, true, '推送数据未渲染');
    });

    await step('AC-03 滚动位置', async () => {
      await win.webContents.executeJavaScript(`(() => {
        document.querySelector('#goals-list').scrollTop = 80;
      })()`);
      await push(() => undefined);
      const scrollTop = await win.webContents.executeJavaScript(`document.querySelector('#goals-list').scrollTop`);
      assert.equal(scrollTop, 80, '滚动位置被重置');
    });

    await step('AC-02 标题编辑草稿', async () => {
      await win.webContents.executeJavaScript(`(() => {
        document.querySelector('.goal')?.querySelector('.goal-title').click();
        const editor = document.querySelector('.goal-title-input');
        editor.value = '改了一半的标题';
        editor.focus();
        editor.setSelectionRange(4, 4);
      })()`);
      await push(p => { p.goals.find(g => g.id === 'g3').progress = 21; });
      const after = await win.webContents.executeJavaScript(`(() => {
        const editor = document.querySelector('.goal-title-input');
        return { value: editor?.value ?? null, focused: document.activeElement === editor };
      })()`);
      assert.equal(after.value, '改了一半的标题', '标题草稿被重置为旧标题');
      assert.equal(after.focused, true, '标题编辑焦点丢失');
      await win.webContents.executeJavaScript(`(() => {
        document.querySelector('.goal-title-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      })()`);
    });

    // SPEC-038/AC-01：推送前后卡片与时间线输入框必须是同一节点（keyed 复用锚）。
    // 节点身份是 IME 组合、选区、armed 等浏览器内部态存活的充分载体；
    // 现实现整树重建，身份必然变化——这就是本重构的特征 Red。
    await step('SPEC-038/AC-01 卡片与输入框节点身份', async () => {
      await win.webContents.executeJavaScript(`(() => {
        const card = document.querySelector('.goal');
        window.__spec038Card = card;
        window.__spec038Input = card?.querySelector('.entry-input') ?? null;
      })()`);
      await push(p => { p.goals.find(g => g.id === 'g1').entries.push({ id: 'e7', at: Date.now(), kind: 'progress', text: '身份断言推送的新记录' }); });
      const identity = await win.webContents.executeJavaScript(`(() => {
        const card = document.querySelector('.goal');
        const input = card?.querySelector('.entry-input');
        return {
          sameCard: !!card && card.isSameNode(window.__spec038Card),
          sameInput: !!input && input.isSameNode(window.__spec038Input),
          pushedEntry: [...document.querySelectorAll('.entry-text')].some(n => n.textContent === '身份断言推送的新记录'),
        };
      })()`);
      assert.equal(identity.sameCard, true, '推送后卡片节点被重建（身份变化）');
      assert.equal(identity.sameInput, true, '推送后时间线输入框被重建');
      assert.equal(identity.pushedEntry, true, '推送数据未渲染');
    });

    // SPEC-038/AC-02：armed 删除确认态在推送后保持——现状会被全量重绘重置。
    // 只点击一次进入确认态，绝不再点第二次（那会真的执行删除）。
    await step('SPEC-038/AC-02 armed 删除确认态保持', async () => {
      const pre = await win.webContents.executeJavaScript(`(() => {
        const btn = document.querySelector('.entry-delete');
        if (!btn) return null;
        btn.click();
        return { armed: btn.dataset.armed === '1', label: btn.textContent };
      })()`);
      assert.equal(pre?.armed ?? false, true, '夹具前置失败：删除按钮未进入确认态');
      await push(() => undefined);
      const armed = await win.webContents.executeJavaScript(`(() => {
        const btn = document.querySelector('.entry-delete');
        return { armed: btn?.dataset.armed === '1', label: btn?.textContent ?? null };
      })()`);
      assert.equal(armed.armed, true, '推送重置了删除确认态');
      assert.equal(armed.label, '确认', '确认态按钮文案被重置');
    });

    await step('AC-04 提交失败伴随推送时草稿保留', async () => {
      await win.webContents.executeJavaScript(`(() => {
        const input = document.querySelector('.entry-input');
        input.value = '提交失败的草稿';
        document.querySelector('.entry-submit')?.click();
      })()`);
      await new Promise(resolve => setTimeout(resolve, 300));
      const after = await win.webContents.executeJavaScript(`(() => {
        const input = document.querySelector('.entry-input');
        const toast = document.querySelector('#goals-toast');
        return { value: input?.value ?? null, toast: toast?.textContent ?? null };
      })()`);
      assert.equal(after.value, '提交失败的草稿', '失败后草稿被清空');
      assert.equal(after.toast, '夹具拒绝写入', '失败提示未出现');
    });

    assert.deepEqual(failures, [], `输入态保护失败 → ${failures.join(' | ')}`);
    writeFileSync(path.join(out, `goals-input-preservation-${theme}.png`), (await win.webContents.capturePage()).toPNG());
    results.push({ role: 'goals-input-preservation', theme, ok: true });
  } finally { win.destroy(); }
}

// SPEC-032：点击任务行后必须同步进入"跳转中"过渡态，全部请求结算后解除。
async function checkOverlayJumpFeedback() {
  const size = resolveCanvasSize(28, 3, 300, 'none', 400);
  const win = await page('overlay', size, { dock: 'none', snapshot: snapshot(3) });
  const probe = `(() => {
    const row = document.querySelector('.strip-row');
    const style = getComputedStyle(row);
    return {
      jumping: row.classList.contains('is-jumping'),
      busy: row.getAttribute('aria-busy'),
      dimRule: style.transitionProperty.split(',').map(s => s.trim()).includes('opacity'),
    };
  })()`;
  const settle = (value) => win.webContents.send('ui-task-action-resolve', value);
  try {
    // 夹具第一行是 running，点击只发 focus_terminal 一条请求。
    await win.webContents.executeJavaScript(`document.querySelector('.strip-row').click()`);
    const during = await win.webContents.executeJavaScript(probe);
    assert.equal(during.jumping, true, 'AC-01 点击后未进入跳转态');
    assert.equal(during.busy, 'true', 'AC-01 aria-busy 缺失');
    // 变暗样式已接线（opacity 过渡声明在 .strip-row.is-jumping 上）。
    // 隐藏夹具窗口不推进过渡帧，像素级变暗由 Windows 真机验收（SPEC-032 测试计划）。
    assert.equal(during.dimRule, true, 'AC-01 变暗规则未命中行');

    // AC-04：在途时重复点击不闪烁；只结算最早一批后仍保持。
    await win.webContents.executeJavaScript(`document.querySelector('.strip-row').click()`);
    const again = await win.webContents.executeJavaScript(probe);
    assert.equal(again.jumping, true, 'AC-04 重复点击后状态丢失');
    await settle({ count: 1, value: { ok: true } });
    await new Promise(resolve => setTimeout(resolve, 120));
    const partial = await win.webContents.executeJavaScript(probe);
    assert.equal(partial.jumping, true, 'AC-04 仍有在途请求时提前解除');

    // AC-02：全部结算后解除。
    await settle({ value: { ok: true } });
    await new Promise(resolve => setTimeout(resolve, 120));
    const after = await win.webContents.executeJavaScript(probe);
    assert.equal(after.jumping, false, 'AC-02 结算后未解除');
    assert.equal(after.busy, null, 'AC-02 aria-busy 未移除');

    // AC-03：失败结算同样解除（失败提示链路属 SPEC-013，不在本断言范围）。
    await win.webContents.executeJavaScript(`document.querySelector('.strip-row').click()`);
    const failedDuring = await win.webContents.executeJavaScript(probe);
    assert.equal(failedDuring.jumping, true, 'AC-03 失败路径未进入跳转态');
    await settle({ value: { ok: false, message: '夹具跳转失败' } });
    await new Promise(resolve => setTimeout(resolve, 120));
    const failedAfter = await win.webContents.executeJavaScript(probe);
    assert.equal(failedAfter.jumping, false, 'AC-03 失败结算后未解除');

    results.push({ role: 'overlay-jump-feedback', ok: true });
  } finally { win.destroy(); }
}

app.whenReady().then(async () => {
  for (const dock of ['none', 'left', 'right', 'top']) for (const count of [0, 1, 3, 20]) await checkOverlay(count, dock);
  // SPEC-025：目标行（含 0 任务仅目标、以及正常任务数 + 目标行）。
  // SPEC-028：贴边点阵的目标行放最前——用户报的就是这个形态（分隔线弯钩 + 常驻滚动条），
  // 一旦回归，失败点应该直接落在这个夹具上。
  await checkOverlay(3, 'left', { active: 2, done: 1, progress: 40 });
  await checkOverlay(3, 'top', { active: 2, done: 1, progress: 40 });
  await checkOverlay(3, 'none', { active: 2, done: 1, progress: 40 });
  await checkOverlay(0, 'none', { active: 1, done: 0, progress: 60 });
  for (const theme of ['light', 'dark']) { await checkPanel(theme, 7); await checkPanel(theme, 0); await checkPanel(theme, 3, true); }
  for (const theme of ['light', 'dark']) await checkPanel(theme, 3, false, '未找到 dsh 主窗口，请先打开工具后重试。<b>普通文字</b>：C:/example/very-long-path/'.repeat(4));
  for (const theme of ['light', 'dark']) { await checkGoals(theme); await checkGoals(theme, true); }
  // SPEC-031：输入态保护（推送重绘不丢草稿/焦点/滚动）。
  for (const theme of ['light', 'dark']) await checkGoalsInputPreservation(theme);
  // SPEC-032：任务行点击的即时跳转态。
  await checkOverlayJumpFeedback();
  writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`PASS: ${results.length} real Electron rendering cases; fixtures only; screenshots: ${out}`);
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
