import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteMonitor, type SqliteProbeRow } from '../src/main/monitors/sqlite';
import * as processEnum from '../src/main/monitors/process-enum';
import { compileRules } from '../src/main/monitors/pattern';
import type { MonitorEvent } from '../src/main/monitors/base';
import type { SqliteMonitorConfig } from '../src/shared/types';
const row: SqliteProbeRow = { activeCount: 0, freshActiveCount: 0, lastDoneAt: 1000, totalCount: 1, lastActivityAt: 1000 };
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), logError: vi.fn() };
const monitors: SqliteMonitor[] = [];
function fixture(gate = false) {
  const config: SqliteMonitorConfig = { type: 'sqlite', database: '/fixture/workbuddy.db', maxFailures: 1, ...(gate ? { requireProcess: [{ processNames: ['WorkBuddy.exe'] }] } : {}) };
  const events: MonitorEvent[] = [];
  const monitor = new SqliteMonitor({ task: { id: 'wb', name: 'WB', enabled: true, monitor: config }, sink: (_, e) => events.push(e), logger, rules: compileRules([]), timeouts: { startTimeoutMs: 1000, staleTimeoutMs: 30000, waitingTimeoutMs: 30000 } }, config);
  monitors.push(monitor);
  // 控制查询完成时机，覆盖暂停与在途 IO 竞争；SQL 本身由真实 SQLite 用例验证。
  const query = vi.spyOn(monitor as unknown as { queryDatabase(): Promise<SqliteProbeRow> }, 'queryDatabase');
  return { monitor, query, events };
}
afterEach(async () => { for (const monitor of monitors.splice(0)) await monitor.stop(); vi.restoreAllMocks(); });
describe('SPEC-002 SQLite 生命周期', () => {
  it('重复启动只创建一个轮询定时器', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval'); const f = fixture(); f.query.mockResolvedValue(row);
    await f.monitor.start(); await f.monitor.start(); expect(interval).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('停止后在途查询不再上报（reject=%s）或重建定时器', async reject => {
    const interval = vi.spyOn(globalThis, 'setInterval'); const f = fixture();
    let finish!: () => void;
    f.query.mockImplementation(() => new Promise((resolve, fail) => { finish = () => reject ? fail(new Error('fixture')) : resolve(row); }));
    const starting = f.monitor.start(); await f.monitor.stop(); finish(); await starting;
    expect(f.events).toEqual([]); expect(interval).not.toHaveBeenCalled();
  });
  it('进程闸门查询失败不能假定进程存在并亮绿', async () => {
    vi.spyOn(processEnum, 'runCimOnce').mockImplementation((_, cb) => cb({ processes: [], source: 'cim' }, new Error('fixture access denied')));
    const f = fixture(true); f.query.mockResolvedValue(row); await f.monitor.start();
    expect(f.events.some(e => e.kind === 'status' && e.status === 'success')).toBe(false);
    expect(f.events.some(e => e.kind === 'status' && e.status === 'unknown')).toBe(true);
  });
});
