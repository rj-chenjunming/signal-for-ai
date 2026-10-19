import { describe, expect, it, vi } from 'vitest';
import { FocusService, type ExecResult, type SpawnExecutor } from '../src/main/focus';
import { parseConfigText } from '../src/main/config';
import type { TaskConfig } from '../src/shared/types';

const window = { Id: 42, ProcessName: 'Codex', MainWindowTitle: '修复网络请求', MainWindowHandle: 500 };
const task: TaskConfig = { id: 'codex', name: 'Codex', enabled: true, monitor: { type: 'webhook', listen: '127.0.0.1', path: '/hook/codex' } };
function setup(confirmed = true) {
  const spawns: string[] = [];
  const exec: SpawnExecutor['exec'] = async (cmd, args): Promise<ExecResult> => {
    const script = args.join(' ');
    const stdout = cmd === 'where.exe' ? 'C:\\Tools\\wt.exe' :
      script.includes('Get-Process |') ? JSON.stringify([window]) :
      script.includes('LAMPFOCUS') ? `LAMPFOCUS ok=${confirmed ? 'True' : 'False'}` : 'False';
    return { ok: true, stdout, stderr: '', code: 0 };
  };
  const spawner: SpawnExecutor = { exec, spawn: (command) => { spawns.push(command); return true; } };
  return { spawner, spawns };
}
const jump = { cwd: 'D:/project', terminal: { type: 'windowTitle' as const, match: '修复网络请求', processNames: ['Codex.exe'] } };

describe('SPEC-002/AC-03 桌面切换', () => {
  it('安装 WT 时显式桌面目标仍优先，不新建终端', async () => {
    const f = setup();
    const svc = new FocusService({ spawner: f.spawner, tasks: () => [{ ...task, jump }] });
    await svc.probeWt();
    const result = await svc.focusTerminal(task, jump);
    expect(result.level).toBe('L2');
    expect(f.spawns).toEqual([]);
  });

  it('激活被拒绝不能报告窗口切换成功', async () => {
    const f = setup(false);
    const svc = new FocusService({ spawner: f.spawner, tasks: () => [{ ...task, jump }] });
    const result = await svc.focusTerminal(task, { terminal: jump.terminal });
    expect(result.ok).toBe(false);
    expect(f.spawns).toEqual([]);
  });

  it('切换结果等待真实激活结束，不能 fire-and-forget 提前成功', async () => {
    const f = setup();
    const svc = new FocusService({ spawner: f.spawner, tasks: () => [{ ...task, jump }] });
    await svc.refreshWindows();
    let release!: (value: boolean) => void;
    vi.spyOn(svc, 'focusExistingWindow').mockReturnValue(new Promise<boolean>((resolve) => { release = resolve; }));
    let settled = false;
    const pending = svc.focusTerminal(task, { terminal: jump.terminal }).then((result) => { settled = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    release(false);
    expect((await pending).ok).toBe(false);
  });

  it('windowProcess 可定位不带品牌名的 Codex 窗口', async () => {
    const parsed = parseConfigText(`tasks:\n  - id: codex\n    monitor: {type: webhook, listen: 127.0.0.1, path: /hook/codex}\n    jump:\n      terminal: {type: windowProcess, processNames: [Codex.exe]}\n`);
    expect(parsed.warnings).toEqual([]);
    const cfg = parsed.config.tasks[0]!;
    const f = setup();
    const svc = new FocusService({ spawner: f.spawner, tasks: () => [cfg] });
    const result = await svc.focusTerminal(cfg, cfg.jump);
    expect(result.ok).toBe(true);
    expect(result.level).toBe('L2');
    expect(f.spawns).toEqual([]);
  });

  it('应用重启后旧 HWND 激活失败，重新枚举并切到新窗口', async () => {
    const f = setup();
    const svc = new FocusService({ spawner: f.spawner, tasks: () => [{ ...task, jump }] });
    await svc.refreshWindows();
    const original = f.spawner.exec;
    f.spawner.exec = async (cmd, args, timeout) => args.join(' ').includes('Get-Process |')
      ? { ok: true, stdout: JSON.stringify([{ ...window, Id: 43, MainWindowHandle: 501 }]), stderr: '', code: 0 }
      : original(cmd, args, timeout);
    const activation = vi.spyOn(svc, 'focusExistingWindow').mockImplementation(async win => win.hwnd === 501);
    const result = await svc.focusTerminal(task, { terminal: jump.terminal });
    expect(result.ok).toBe(true);
    expect(activation.mock.calls.map(call => call[0].hwnd)).toEqual([500, 501]);
  });

  it('windowProcess 必须提供有效进程名，不能匹配所有窗口', () => {
    const parsed = parseConfigText('tasks:\n  - id: codex\n    monitor: {type: webhook, listen: 127.0.0.1, path: /hook/codex}\n    jump:\n      terminal: {type: windowProcess, processNames: []}\n');
    expect(parsed.config.tasks[0]?.jump?.terminal).toBeUndefined();
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });
});
