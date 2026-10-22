// Fixture API used only by ui-render-check.cjs. No real monitoring or user data.
const { contextBridge, ipcRenderer } = require('electron');
const fixture = ipcRenderer.sendSync('ui-fixture');
const ok = async () => ({ ok: true });
contextBridge.exposeInMainWorld('aiIndicator', {
  getSnapshot: async () => fixture.snapshot,
  getLayout: async () => ({ dock: fixture.dock }),
  onSnapshot: () => {}, onToast: listener => { if (fixture.overlayMessage) listener({ message: fixture.overlayMessage }); }, onPlaySound: () => {},
  onLayout: listener => { listener({ dock: fixture.dock }); },
  togglePanel: async () => ({ expanded: true }),
  setMonitoringPaused: async () => ({ ok: true }),
  sendTaskAction: async () => ({ ok: true }),
  showPanelMessage: async () => ({ ok: true }),
  takePanelMessage: async () => fixture.message ? { message: fixture.message } : {},

  // SPEC-024 fixtures：目标窗口只依赖这些白名单方法，不需要真实主进程。
  getGoals: async () => fixture.goalsView ?? { goals: [] },
  onGoals: () => {},
  addGoal: ok,
  deleteGoal: ok,
  updateGoalTitle: ok,
  setGoalProgress: ok,
  completeGoal: ok,
  addGoalEntry: ok,
  deleteGoalEntry: ok,
  moveGoal: async (id, beforeId) => {
    ipcRenderer.send('ui-goal-move', { id, beforeId });
    return { ok: true };
  },
  exportGoals: async () => ({ ok: true, path: 'C:/fixture/goals.md' }),
  hideGoals: async () => undefined,
  openGoals: async () => { ipcRenderer.send('ui-goal-open'); return { ok: true }; },
});
