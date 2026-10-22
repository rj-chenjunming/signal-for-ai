/** README 截图生成：真实渲染当前 dist/renderer，不启动监控、不读用户数据。 */
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const { writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');

const { resolveCanvasSize } = require('../dist/main/overlay-layout.js');
const { TaskStore } = require('../dist/main/store.js');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const out = path.resolve(__dirname, '../deliverables');
mkdirSync(out, { recursive: true });

let fixture;
ipcMain.on('ui-fixture', (event) => { event.returnValue = fixture; });

const now = Date.now();
const TASKS = [
  {
    id: 'dsh-local', name: 'dsh（本地客户端）', toolKind: 'dsh', status: 'running',
    portLabel: '本地客户端', message: '正在执行：补齐目标清单的导出与排序', startedAt: now - 127000,
    durationMs: 127000, paused: false, unread: false,
    availableActions: ['focus_terminal', 'open_log', 'open_dir', 'retry', 'mark_read'],
  },
  {
    id: 'workbuddy', name: 'WorkBuddy 主进程', toolKind: 'workbuddy', status: 'waiting',
    portLabel: '等待授权', message: '等待确认：写入项目文件', startedAt: now - 30000,
    durationMs: 30000, paused: false, unread: false,
    availableActions: ['focus_terminal', 'open_log', 'open_dir', 'retry', 'mark_read'],
  },
  {
    id: 'codex', name: 'Codex', toolKind: 'codex', status: 'success',
    portLabel: '已完成', message: '已完成：3 files changed', startedAt: now - 640000,
    durationMs: 640000, paused: false, unread: true,
    availableActions: ['focus_terminal', 'open_log', 'open_dir', 'retry', 'mark_read'],
  },
];

function snapshot() {
  // 从真实 TaskStore 取快照骨架，再替换成 README 用的干净演示数据。
  const store = new TaskStore(
    TASKS.map((task) => ({
      id: task.id,
      name: task.name,
      enabled: true,
      monitor: { type: 'webhook', listen: '127.0.0.1', path: `/hook/${task.id}` },
    })),
  );
  const snap = store.getSnapshot();
  snap.tasks = snap.tasks.map((task, index) => ({
    ...task,
    ...TASKS[index],
    paused: false,
    status: TASKS[index].status,
    toolKind: TASKS[index].toolKind,
    unread: TASKS[index].unread,
  }));
  snap.displayTasks = snap.tasks;
  snap.aggregate = 'running';
  snap.runningCount = 1;
  snap.counts = { idle: 0, starting: 0, running: 1, waiting: 1, success: 1, failed: 0, unknown: 0 };
  snap.stripMode = true;
  snap.goalsSummary = { active: 2, done: 1, progress: 40 };
  return snap;
}

async function render(role, size, data) {
  fixture = data;
  const win = new BrowserWindow({
    ...size, show: false, frame: false, transparent: role === 'overlay',
    webPreferences: {
      preload: path.join(__dirname, 'ui-render-preload.cjs'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  await win.loadFile(path.resolve(__dirname, `../dist/renderer/${role}.html`));
  await win.webContents.executeJavaScript(
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  );
  return win;
}

async function shot(role, size, data, file) {
  const win = await render(role, size, data);
  try {
    const image = await win.webContents.capturePage();
    writeFileSync(path.join(out, file), image.toPNG());
    console.log(`${file}: ${image.getSize().width}x${image.getSize().height}`);
  } finally {
    win.destroy();
  }
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  const snap = snapshot();

  await shot('panel', { width: 420, height: 520 }, { dock: 'none', snapshot: snap }, 'panel-current.png');

  const stripSize = resolveCanvasSize(28, 4, 300, 'none', 400, true);
  await shot('overlay', stripSize, { dock: 'none', snapshot: snap }, 'overlay-current.png');

  const leftSize = resolveCanvasSize(28, 4, 300, 'left', 400, true);
  await shot('overlay', leftSize, { dock: 'left', snapshot: snap }, 'dock-vertical.png');

  const topSize = resolveCanvasSize(28, 4, 300, 'top', 400, true);
  await shot('overlay', topSize, { dock: 'top', snapshot: snap }, 'dock-horizontal.png');

  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
