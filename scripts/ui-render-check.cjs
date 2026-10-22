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
ipcMain.on('ui-fixture', event => { event.returnValue = fixture; });
ipcMain.on('ui-goal-open', () => { goalsOpened += 1; });
const results = [];
function snapshot(count, paused = false, goalsSummary = null) {
  const store = new TaskStore(Array.from({ length: count }, (_, i) => ({ id: `fixture-${i}`, name: ['Codex', 'dsh', 'WorkBuddy'][i % 3], enabled: true, monitor: { type: 'webhook', listen: '127.0.0.1', path: `/fixture/${i}` } })));
  const s = store.getSnapshot();
  s.version = 1; s.paused = paused; s.aggregate = 'running'; s.runningCount = 1;
  s.tasks = s.tasks.map((t, i) => ({ ...t, toolKind: ['codex', 'dsh', 'dsh-web', 'workbuddy'][i % 4], status: states[i % 7], paused, unread: i % 7 === 2, portLabel: '很长的工具标签与端口名称', name: i === 0 ? 'Codex · 很长的任务名称 <b>纯文本</b>' : t.name, message: '示例任务状态 · 长文本自动换行，其他操作收进更多菜单。', startedAt: Date.now() - 127000, durationMs: 127000 }));
  s.displayTasks = s.tasks;
  s.stripMode = count >= 2 || (goalsSummary !== null && goalsSummary.active > 0);
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
  const forceStrip = count >= 2 || goalRow > 0;
  const size = resolveCanvasSize(28, rows, 300, dock, 400, forceStrip);
  const win = await page('overlay', size, { dock, snapshot: snapshot(count, false, goalsSummary), overlayMessage: goalsSummary ? undefined : '无法定位终端：未配置可用的 cwd / logFile，且窗口聚焦失败' });
  try {
    const value = await win.webContents.executeJavaScript(`(() => {
      const rows = document.querySelector('#strip-rows');
      const rect = el => { const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; };
      const strip = document.querySelector('#lamp-strip'); const core = document.querySelector('#lamp-core');
      const points = [...document.querySelectorAll('.strip-row')].map(row => {
        const dot = row.querySelector('.strip-dot');
        return {row:rect(row), dot: dot ? rect(dot) : null, svg:!!row.querySelector('svg'), hasDot: !!dot};
      });
      if (rows) { rows.scrollTop=rows.scrollHeight; rows.scrollLeft=rows.scrollWidth; }
      const last=document.querySelector('.strip-row:last-child');
      const toast=document.querySelector('.lamp-toast');
      const goal = (() => {
        const row = document.querySelector('.strip-goal-row');
        if (!row) return null;
        const ring = row.querySelector('.strip-goal-ring');
        return {
          label: row.querySelector('.strip-port')?.textContent ?? null,
          icon: !!row.querySelector('svg'),
          progress: ring ? getComputedStyle(ring).getPropertyValue('--goal-progress').trim() : null,
          ringVisible: ring ? getComputedStyle(ring).display !== 'none' : false,
        };
      })();
      return {stripHidden:strip.hidden,coreHidden:core.hidden,bodyWidth:document.body.scrollWidth,bodyHeight:document.body.scrollHeight,points,goal,last:last&&rect(last),viewport:rect(rows),width:innerWidth,height:innerHeight,toastHeight:toast.offsetHeight,toastWrap:getComputedStyle(toast).whiteSpace};
    })()`);
    assert.equal(value.stripHidden, !forceStrip); assert.equal(value.coreHidden, forceStrip);
    assert.equal(value.toastWrap, 'nowrap'); assert.ok(value.toastHeight <= 36, 'narrow toast became vertical text');
    assert.ok(value.bodyWidth <= size.width && value.bodyHeight <= size.height, 'body exceeds canvas');
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
    if (goalsSummary && dock === 'none') writeFileSync(path.join(out, `overlay-goals-${count}.png`), (await win.webContents.capturePage()).toPNG());
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
        missingLogHidden:first?.querySelector('[data-action="open_log"]').hidden,btn:document.querySelector('#btn-pause').textContent,
        feedback:(()=>{const t=document.querySelector('.panel-toast');if(!t)return null;const r=t.getBoundingClientRect();return {text:t.textContent,width:r.width,bottom:r.bottom,top:r.top,children:t.children.length};})()};
    })()`);
    assert.equal(value.empty, count === 0); assert.ok(value.width <= 420 && value.height <= 520, 'panel body overflow');
    if (count) { assert.equal(value.primary, '切回工具'); assert.ok(value.missingLogHidden); assert.equal(value.injected, false); }
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
      assert.equal(value.entryCount, 3);
      assert.equal(value.entryKind, '问题');
      assert.equal(value.entryText, 'Windows 真机验收还欠一次');
      assert.equal(value.range, '40');
      assert.equal(value.warningHidden, false);
      assert.equal(value.warningText, '主文件损坏，已从备份恢复数据');
      assert.ok(value.deleteLabels.length > 0, 'delete affordances missing');
      assert.deepEqual(value.deleteLabels, value.deleteLabels.map(() => '✕'), 'delete buttons must not start armed');
      assert.equal(value.scroll, true, 'long goal list must scroll');
    }
    writeFileSync(path.join(out, `goals-${theme}${empty ? '-empty' : ''}.png`), (await win.webContents.capturePage()).toPNG());
    results.push({ role: 'goals', theme, empty, ok: true });
  } finally { win.destroy(); }
}
app.whenReady().then(async () => {
  for (const dock of ['none', 'left', 'right', 'top']) for (const count of [0, 1, 3, 20]) await checkOverlay(count, dock);
  // SPEC-025：目标行（含 0 任务仅目标、以及正常任务数 + 目标行）。
  await checkOverlay(3, 'none', { active: 2, done: 1, progress: 40 });
  await checkOverlay(0, 'none', { active: 1, done: 0, progress: 60 });
  await checkOverlay(3, 'left', { active: 2, done: 1, progress: 40 });
  for (const theme of ['light', 'dark']) { await checkPanel(theme, 7); await checkPanel(theme, 0); await checkPanel(theme, 3, true); }
  for (const theme of ['light', 'dark']) await checkPanel(theme, 3, false, '未找到 dsh 主窗口，请先打开工具后重试。<b>普通文字</b>：C:/example/very-long-path/'.repeat(4));
  for (const theme of ['light', 'dark']) { await checkGoals(theme); await checkGoals(theme, true); }
  writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`PASS: ${results.length} real Electron rendering cases; fixtures only; screenshots: ${out}`);
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
