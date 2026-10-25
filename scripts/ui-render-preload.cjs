// Fixture API used only by ui-render-check.cjs. No real monitoring or user data.
const { contextBridge, ipcRenderer } = require('electron');
const fixture = ipcRenderer.sendSync('ui-fixture');
const ok = async () => ({ ok: true });
// SPEC-031：goals 渲染器注册的推送回调；主脚本经 ui-goals-push 投递新视图。
let goalsListener = null;
ipcRenderer.on('ui-goals-push', (_event, view) => { if (goalsListener) goalsListener(view); });
// SPEC-032：任务行动作挂起，直到主脚本经 ui-task-action-resolve 放行结算；
// count 可只结算最早的一批，用于验证"旧批次结算、新批次在途时跳转态保持"。
const pendingTaskActions = [];
ipcRenderer.on('ui-task-action-resolve', (_event, result) => {
  const count = result && typeof result.count === 'number' ? result.count : Infinity;
  for (let i = 0; i < count && pendingTaskActions.length > 0; i += 1) {
    pendingTaskActions.shift().resolve(result.value ?? { ok: true });
  }
});
contextBridge.exposeInMainWorld('aiIndicator', {
  getSnapshot: async () => fixture.snapshot,
  getLayout: async () => ({ dock: fixture.dock }),
  onSnapshot: () => {}, onToast: listener => { if (fixture.overlayMessage) listener({ message: fixture.overlayMessage }); }, onPlaySound: () => {},
  onLayout: listener => { listener({ dock: fixture.dock }); },
  togglePanel: async () => ({ expanded: true }),
  setMonitoringPaused: async () => ({ ok: true }),
  // SPEC-032：任务行动作挂起直到主脚本放行结算（见 pendingTaskActions）。
  sendTaskAction: (payload) => new Promise(resolve => {
    pendingTaskActions.push({ resolve });
    ipcRenderer.send('ui-task-action', payload);
  }),
  showPanelMessage: async () => ({ ok: true }),
  takePanelMessage: async () => fixture.message ? { message: fixture.message } : {},

  // SPEC-024 fixtures：目标窗口只依赖这些白名单方法，不需要真实主进程。
  getGoals: async () => fixture.goalsView ?? { goals: [] },
  // SPEC-031：onGoals 注册后由主脚本经 ui-goals-push 推送新视图，驱动重绘。
  onGoals: listener => { goalsListener = listener; },
  addGoal: ok,
  deleteGoal: ok,
  updateGoalTitle: ok,
  setGoalProgress: ok,
  completeGoal: ok,
  // SPEC-031 AC-04：提交失败且伴随推送——先推送、后返回 ok:false，复现"推送先于结果"时序。
  addGoalEntry: (goalId, kind, text) => {
    if (fixture.entrySubmitMode === 'fail-with-push') {
      return new Promise(resolve => {
        ipcRenderer.once('ui-entry-resolve', () => resolve({ ok: false, message: '夹具拒绝写入' }));
        ipcRenderer.send('ui-entry-attempt', { goalId, kind, text });
      });
    }
    return ok();
  },
  deleteGoalEntry: ok,
  moveGoal: async (id, beforeId) => {
    ipcRenderer.send('ui-goal-move', { id, beforeId });
    return { ok: true };
  },
  exportGoals: async () => ({ ok: true, path: 'C:/fixture/goals.md' }),
  hideGoals: async () => undefined,
  openGoals: async () => { ipcRenderer.send('ui-goal-open'); return { ok: true }; },
});
