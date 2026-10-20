// Fixture API used only by ui-render-check.cjs. No real monitoring or user data.
const { contextBridge, ipcRenderer } = require('electron');
const fixture = ipcRenderer.sendSync('ui-fixture');
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
});
