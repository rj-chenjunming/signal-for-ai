import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

describe('start launcher CLI contract (SPEC-009)', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ai-indicator-launcher-'));
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'node_modules', 'electron'), { recursive: true });
    copyFileSync(resolve('scripts/start.mjs'), join(root, 'scripts', 'start.mjs'));
    writeFileSync(join(root, 'node_modules', 'electron', 'index.js'), 'module.exports = "fixture-electron.exe";');
    writeFileSync(join(root, 'capture.cjs'), `
      const cp = require('node:child_process');
      const { EventEmitter } = require('node:events');
      cp.spawn = (bin, args, options) => {
        console.log('CAPTURE:' + JSON.stringify({
          bin, args, cwd: options.cwd,
          runAsNode: options.env.ELECTRON_RUN_AS_NODE ?? null
        }));
        const child = new EventEmitter();
        queueMicrotask(() => {
          if (process.env.LAUNCHER_TEST_ERROR === '1') child.emit('error', new Error('fixture spawn error'));
          else child.emit('exit', Number(process.env.LAUNCHER_TEST_EXIT ?? 0), null);
        });
        return child;
      };
      require('node:module').syncBuiltinESMExports();
    `);
  });

  afterAll(() => {
    if (root && resolve(root).startsWith(resolve(tmpdir()) + '\\') ||
        root && resolve(root).startsWith(resolve(tmpdir()) + '/')) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function launch(args: string[], extraEnv: Record<string, string> = {}) {
    const result = spawnSync(process.execPath, ['--require', join(root, 'capture.cjs'), join(root, 'scripts', 'start.mjs'), ...args], {
      encoding: 'utf8', timeout: 15_000, windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extraEnv },
    });
    if (result.error) throw result.error;
    const line = result.stdout.split(/\r?\n/u).find((value) => value.startsWith('CAPTURE:'));
    expect(line, result.stderr).toBeDefined();
    return { result, captured: JSON.parse(line!.slice('CAPTURE:'.length)) as { args: string[]; cwd: string; runAsNode: string | null } };
  }

  it('forwards npm-style config arguments without an extra separator, preserving spaces', () => {
    const { result, captured } = launch(['--config', './private config.yaml']);
    expect(result.status).toBe(0);
    expect(captured.args.slice(-2)).toEqual(['--config', './private config.yaml']);
    expect(resolve(captured.cwd)).toBe(root);
  });

  it('keeps the explicit separator calling convention', () => {
    const { captured } = launch(['--', '--config', './config.local.yaml']);
    expect(captured.args.slice(-2)).toEqual(['--config', './config.local.yaml']);
    expect(captured.args).not.toContain('--');
  });

  it('keeps default GPU flags when launched without arguments', () => {
    const { captured } = launch([]);
    expect(captured.args).toContain('--disable-gpu');
    expect(captured.args[0]).toBe('.');
  });

  it('honors direct enable-gpu and cleans the child environment', () => {
    const { captured } = launch(['--enable-gpu']);
    expect(captured.args).toEqual(['.', '--enable-gpu']);
    expect(captured.runAsNode).toBeNull();
  });

  it('preserves a failing Electron exit code', () => {
    expect(launch([], { LAUNCHER_TEST_EXIT: '7' }).result.status).toBe(7);
  });

  it('reports a spawn error and exits with failure', () => {
    const { result } = launch([], { LAUNCHER_TEST_ERROR: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fixture spawn error');
  });
});
