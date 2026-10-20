import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { buildHiddenWindowScript, parseHiddenWindow } from '../src/main/hidden-window';

it('keeps process names as encoded data rather than executable PowerShell', () => {
  const name = "test'; throw 'injected\n.exe";
  const script = buildHiddenWindowScript([name]);
  expect(script).not.toContain(name);
  const encoded = script.match(/FromBase64String\('([^']+)'\)/u)?.[1] ?? '';
  expect(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))).toEqual([name.slice(0, -4)]);
});

it.runIf(process.platform === 'win32')('executes the real read-only Windows discovery including Add-Type', () => {
  // The query process itself exists: this must compile the C# and call EnumWindows,
  // rather than pass via the early return for an absent process.
  const script = `${buildHiddenWindowScript(['powershell.exe'])}\nWrite-Output 'DISCOVERY_COMPLETED'`;
  const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  const lines = child.stdout.trim().split(/\r?\n/u);
  // exit 0 in the no-process branch would otherwise falsely pass as a real EnumWindows check.
  expect(lines.pop()).toBe('DISCOVERY_COMPLETED');
  const payload = lines.join('\n');
  expect(Array.isArray(JSON.parse(payload))).toBe(true);
  expect(parseHiddenWindow(payload, ['powershell.exe'], '')).toBeNull();
}, 20000);
