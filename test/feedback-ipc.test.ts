import { expect, it, vi } from 'vitest';
const registered = vi.hoisted(() => new Map<string, (event: unknown, payload?: unknown) => unknown>());
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: any) => registered.set(name, handler) } }));
import { registerIpcHandlers } from '../src/main/ipc';
import type { IpcHandlers } from '../src/main/ipc';
import type { Logger } from '../src/main/logger';
it('panel feedback rejects invalid payloads and isolates handler failures', async () => {
  const show = vi.fn();
  registerIpcHandlers({ showPanelMessage: show, takePanelMessage: () => ({ message: '待显示' }) } as unknown as IpcHandlers, { error: vi.fn() } as unknown as Logger);
  const handler = registered.get('panel:showMessage');
  expect(typeof handler).toBe('function');
  for (const value of [null, {}, '', ' '.repeat(10), 'a'.repeat(2001)]) expect(await handler!({}, value)).toMatchObject({ ok: false });
  expect(show).not.toHaveBeenCalled();
  expect(await handler!({}, '完整提示')).toEqual({ ok: true });
  expect(show).toHaveBeenCalledWith('完整提示');
  expect(await registered.get('panel:takeMessage')!({})).toEqual({ message: '待显示' });
  show.mockImplementation(() => { throw new Error('fixture'); });
  expect(await handler!({}, '失败')).toMatchObject({ ok: false });
});
