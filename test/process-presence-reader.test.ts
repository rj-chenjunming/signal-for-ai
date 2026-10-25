import { expect, it, vi } from 'vitest';
import { createPresenceReader, desktopProcessNames, parsePresenceNames } from '../src/main/monitors/process-presence';
import type { TaskConfig } from '../src/shared/types';

const inventory = '"System Idle Process","0","Services","0","8 K"\r\n"System","4","Services","0","1,000 K"\r\n"ChatGPT.exe","123","Console","1","100 K"';
it('parses a complete Windows inventory, rejecting empty/malformed/partial error payloads', () => {
  expect(parsePresenceNames(inventory)).toEqual(['System', 'ChatGPT.exe']);
  for (const bad of ['', 'ERROR: access denied', '[]', `${inventory}\r\nERROR: partial`, '"x","no pid"']) {
    expect(() => parsePresenceNames(bad)).toThrow();
  }
});
it('shares in-flight reads and short cache, bypasses cache for errors and retries after read failure', async () => {
  let resolve!: (s: string) => void; let now = 100;
  const read = vi.fn(() => new Promise<string>(r => { resolve = r; }));
  const reader = createPresenceReader(read, () => now);
  const a = reader(); const b = reader(true); expect(read).toHaveBeenCalledTimes(1);
  resolve(inventory); expect(await a).toEqual(await b);
  await reader(); expect(read).toHaveBeenCalledTimes(1);
  read.mockResolvedValueOnce(inventory); await reader(true); expect(read).toHaveBeenCalledTimes(2);
  now += 1001; read.mockRejectedValueOnce(new Error('timeout')); await expect(reader()).rejects.toThrow('timeout');
  read.mockResolvedValueOnce(inventory); await reader(); expect(read).toHaveBeenCalledTimes(4);
});
it('gates all four explicit desktop tools, but excludes web/CLI/remote and generic monitors', () => {
  const route = { terminal: { type: 'windowProcess' as const, processNames: [' App.EXE ', 'app'] } };
  const dsh: TaskConfig = { id: 'd', name: 'd', enabled: true, monitor: { type: 'dsh', authority: 'auto' }, jump: route };
  expect(desktopProcessNames(dsh)).toEqual(['app']);
  expect(desktopProcessNames({ ...dsh, monitor: { type: 'sqlite', database: '/fixture' } })).toEqual(['app']);
  expect(desktopProcessNames({ ...dsh, monitor: { type: 'codex', sessionsDir: '/fixture' }, jump: { terminal: { type: 'windowTitle', match: 'x', processNames: ['app.exe'] } } })).toEqual(['app']);
  expect(desktopProcessNames({ ...dsh, monitor: { type: 'zcode', dbPath: '/fixture' } })).toEqual(['app']);
  expect(desktopProcessNames({ ...dsh, monitor: { type: 'dsh', authority: '127.0.0.1:123' } })).toEqual(['app']);
  for (const authority of ['server.example:123', '192.168.1.1:123']) {
    expect(desktopProcessNames({ ...dsh, monitor: { type: 'dsh', authority } })).toEqual([]);
  }
  expect(desktopProcessNames({ ...dsh, monitor: { type: 'dsh', authority: 'auto', sshHost: 'remote' } })).toEqual([]);
  expect(desktopProcessNames({ ...dsh, jump: { openUrl: 'http://localhost', terminal: { type: 'none' } } })).toEqual([]);
  expect(desktopProcessNames({ ...dsh, monitor: { type: 'log', paths: ['/fixture'], rules: [] } })).toEqual([]);
});
