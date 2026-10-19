/**
 * SPEC-003/AC-01~03：`openUrl` + `openUrlViaExtension` 的三条路径都要有明确结果。
 *
 * 用户现场：点 dsh-web 每次都新开一个标签页，日志里只有"已打开"，看不出扩展
 * 到底有没有连上。这里锁住三件事：
 *   1. 扩展不在线 -> 仍然打开 URL（点击不能没效果），但要 warn + 一次性提示；
 *   2. 扩展在线命中 -> 切标签、不 spawn、不提示（既有行为，特征测试锁住）；
 *   3. 扩展在线但没找到标签 -> 提示一次，再退回打开 URL。
 */
import { describe, expect, it, vi } from 'vitest';
import { FocusService, type ExecResult, type FocusLogger, type SpawnExecutor } from '../src/main/focus';
import type { TaskConfig } from '../src/shared/types';

const TASK: TaskConfig = {
  id: 'dsh-web',
  name: 'dsh（web 13080）',
  enabled: true,
  monitor: { type: 'webhook', listen: '127.0.0.1', path: '/hook/dsh-web' },
};

/** dsh-web 的真实跳转形态：只配了 openUrl，并要求走浏览器扩展。 */
const JUMP = { openUrl: 'http://127.0.0.1:13080', openUrlViaExtension: true } as const;

function setup(options: { connected: boolean; activated: boolean }) {
  const spawns: string[] = [];
  const spawner: SpawnExecutor = {
    exec: async (): Promise<ExecResult> => ({ ok: true, stdout: '', stderr: '', code: 0 }),
    spawn: (command: string): boolean => {
      spawns.push(command);
      return true;
    },
  };
  const activator = {
    isExtensionConnected: (): boolean => options.connected,
    requestActivate: async (): Promise<boolean> => options.activated,
  };
  const notify = vi.fn<(message: string) => void>();
  const logs: string[] = [];
  const push = (level: string) => (message: string): void => {
    logs.push(`${level} ${message}`);
  };
  const logger: FocusLogger = { info: push('INFO'), warn: push('WARN'), error: push('ERROR') };
  return { spawns, spawner, activator, notify, logs, logger };
}

function build(options: { connected: boolean; activated: boolean }) {
  const env = setup(options);
  const svc = new FocusService({
    spawner: env.spawner,
    logger: env.logger,
    extensionActivator: env.activator,
    notify: env.notify,
  });
  return { ...env, svc };
}

describe('SPEC-003 打开 URL 型任务时的扩展可用性反馈', () => {
  it('AC-01 扩展不在线：提示一次、仍然打开 URL，不谎称切了标签', async () => {
    const env = build({ connected: false, activated: false });
    const result = await env.svc.focusTerminal(TASK, JUMP);

    expect(result.ok).toBe(true);
    expect(env.spawns).toContain('rundll32.exe');
    expect(env.logs.some((line) => line.startsWith('WARN') && line.includes('扩展'))).toBe(true);
    expect(env.logs.some((line) => line.includes('已通过浏览器扩展切到'))).toBe(false);

    expect(env.notify).toHaveBeenCalledTimes(1);
    expect(env.notify.mock.calls[0]?.[0]).toContain('扩展');
  });

  it('AC-02 扩展在线且命中：切标签、不 spawn、不提示（既有行为不变）', async () => {
    const env = build({ connected: true, activated: true });
    const result = await env.svc.focusTerminal(TASK, JUMP);

    expect(result.ok).toBe(true);
    expect(env.spawns).toEqual([]);
    expect(env.notify).not.toHaveBeenCalled();
    expect(env.logs.some((line) => line.includes('已通过浏览器扩展切到'))).toBe(true);
  });

  it('AC-03 扩展在线但没找到标签：提示一次后回退打开 URL', async () => {
    const env = build({ connected: true, activated: false });
    const result = await env.svc.focusTerminal(TASK, JUMP);

    expect(result.ok).toBe(true);
    expect(env.spawns).toContain('rundll32.exe');
    expect(env.logs.some((line) => line.includes('浏览器扩展未确认切换'))).toBe(true);
    expect(env.notify).toHaveBeenCalledTimes(1);
    expect(env.notify.mock.calls[0]?.[0]).toContain('扩展');
  });

  it('未配置 openUrlViaExtension 时不产生额外提示（不受本规格影响）', async () => {
    const env = build({ connected: false, activated: false });
    const result = await env.svc.focusTerminal(TASK, { openUrl: 'http://127.0.0.1:13080' });

    expect(result.ok).toBe(true);
    expect(env.notify).not.toHaveBeenCalled();
  });
});
