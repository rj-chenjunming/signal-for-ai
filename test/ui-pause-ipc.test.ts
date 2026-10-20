import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>() }));
vi.mock('electron', () => ({ ipcMain: { handle: (key: string, fn: (event: unknown, payload: unknown) => Promise<unknown>) => mocks.handlers.set(key, fn) } }));
import { registerIpcHandlers, type IpcHandlers } from '../src/main/ipc';
import { TaskStore } from '../src/main/store';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), logError: vi.fn() };
beforeEach(() => mocks.handlers.clear());
function setup(fail = false) {
  const pause = vi.fn(async (_paused: boolean) => { if (fail) throw new Error('fixture'); return { ok: true }; });
  const handlers = { getSnapshot: () => new TaskStore([]).getSnapshot(), handleTaskAction: vi.fn(), handleNotifyAction: vi.fn(), togglePanel: vi.fn(), lampDragged: vi.fn(), quit: vi.fn(), reprobeTerminal: vi.fn(), setMonitoringPaused: pause };
  registerIpcHandlers(handlers as IpcHandlers, logger);
  return pause;
}
describe('SPEC-012 pause IPC', () => {
  it('布尔暂停请求交给现有业务入口并回传结果', async () => {
    const pause = setup(); const handler = mocks.handlers.get('app:setMonitoringPaused');
    expect(handler).toBeTypeOf('function');
    expect(await handler!({}, true)).toEqual({ ok: true }); expect(pause).toHaveBeenCalledWith(true);
    await handler!({}, false); expect(pause).toHaveBeenLastCalledWith(false);
  });
  it('非法参数不调用业务、异常返回可展示的失败', async () => {
    const pause = setup(true); const handler = mocks.handlers.get('app:setMonitoringPaused');
    expect(handler).toBeTypeOf('function');
    expect(await handler!({}, 'false')).toMatchObject({ ok: false }); expect(pause).not.toHaveBeenCalled();
    expect(await handler!({}, true)).toMatchObject({ ok: false, message: expect.any(String) });
  });
});
