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
ipcMain.on('ui-fixture', event => { event.returnValue = fixture; });
const results = [];
function snapshot(count, paused = false) {
  const store = new TaskStore(Array.from({ length: count }, (_, i) => ({ id: `fixture-${i}`, name: ['Codex', 'dsh', 'WorkBuddy'][i % 3], enabled: true, monitor: { type: 'webhook', listen: '127.0.0.1', path: `/fixture/${i}` } })));
  const s = store.getSnapshot();
  s.version = 1; s.paused = paused; s.aggregate = 'running'; s.runningCount = 1;
  s.tasks = s.tasks.map((t, i) => ({ ...t, toolKind: ['codex', 'dsh', 'workbuddy'][i % 3], status: states[i % 7], paused, unread: i % 7 === 2, portLabel: '很长的工具标签与端口名称', name: i === 0 ? 'Codex · 很长的任务名称 <b>纯文本</b>' : t.name, message: '示例任务状态 · 长文本自动换行，其他操作收进更多菜单。', startedAt: Date.now() - 127000, durationMs: 127000 }));
  s.displayTasks = s.tasks; s.stripMode = count >= 2;
  s.counts = Object.fromEntries(states.map(state => [state, s.tasks.filter(t => t.status === state).length]));
  return s;
}
async function page(role, size, data) {
  fixture = data;
  const win = new BrowserWindow({ ...size, show: false, frame: false, transparent: role === 'overlay', webPreferences: { preload: path.join(__dirname, 'ui-render-preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(path.resolve(__dirname, `../dist/renderer/${role}.html`));
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  return win;
}
async function checkOverlay(count, dock) {
  const size = resolveCanvasSize(28, count, 300, dock, 400);
  const win = await page('overlay', size, { dock, snapshot: snapshot(count), overlayMessage: '无法定位终端：未配置可用的 cwd / logFile，且窗口聚焦失败' });
  try {
    const value = await win.webContents.executeJavaScript(`(() => {
      const rows = document.querySelector('#strip-rows');
      const rect = el => { const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; };
      const strip = document.querySelector('#lamp-strip'); const core = document.querySelector('#lamp-core');
      const points = [...document.querySelectorAll('.strip-row')].map(row => ({row:rect(row),dot:rect(row.querySelector('.strip-dot')),svg:!!row.querySelector('svg')}));
      if (rows) { rows.scrollTop=rows.scrollHeight; rows.scrollLeft=rows.scrollWidth; }
      const last=document.querySelector('.strip-row:last-child');
      const toast=document.querySelector('.lamp-toast');
      return {stripHidden:strip.hidden,coreHidden:core.hidden,bodyWidth:document.body.scrollWidth,bodyHeight:document.body.scrollHeight,points,last:last&&rect(last),viewport:rect(rows),width:innerWidth,height:innerHeight,toastHeight:toast.offsetHeight,toastWrap:getComputedStyle(toast).whiteSpace};
    })()`);
    assert.equal(value.stripHidden, count < 2); assert.equal(value.coreHidden, count >= 2);
    assert.equal(value.toastWrap, 'nowrap'); assert.ok(value.toastHeight <= 36, 'narrow toast became vertical text');
    assert.ok(value.bodyWidth <= size.width && value.bodyHeight <= size.height, 'body exceeds canvas');
    for (const { row, dot, svg } of value.points) {
      assert.ok(svg, 'missing local SVG'); assert.ok(row.width >= 32 && row.height >= 32, 'target too small');
      assert.ok(dot.x >= row.x && dot.right <= row.right && dot.y >= row.y && dot.bottom <= row.bottom, 'status dot clipped by target');
    }
    if (value.last) {
      assert.ok(value.last.right <= value.viewport.right + 1 && value.last.bottom <= value.viewport.bottom + 1, 'last target unreachable after scroll');
      assert.ok(value.last.right <= size.width && value.last.bottom <= size.height, 'last target outside window');
    }
    if (count === 3) writeFileSync(path.join(out, `overlay-${dock}.png`), (await win.webContents.capturePage()).toPNG());
    results.push({ role: 'overlay', count, dock, size, ok: true });
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
app.whenReady().then(async () => {
  for (const dock of ['none', 'left', 'right', 'top']) for (const count of [0, 1, 3, 20]) await checkOverlay(count, dock);
  for (const theme of ['light', 'dark']) { await checkPanel(theme, 7); await checkPanel(theme, 0); await checkPanel(theme, 3, true); }
  for (const theme of ['light', 'dark']) await checkPanel(theme, 3, false, '未找到 dsh 主窗口，请先打开工具后重试。<b>普通文字</b>：C:/example/very-long-path/'.repeat(4));
  writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`PASS: ${results.length} real Electron rendering cases; fixtures only; screenshots: ${out}`);
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
