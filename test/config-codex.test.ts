import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateConfig, parseConfigText } from '../src/main/config';

describe('SPEC-002 Codex 配置', () => {
  it('保留 Codex 监控及进程窗口目标', () => {
    const { config } = validateConfig({ version: 1, tasks: [{ id: 'codex', name: 'Codex', monitor: { type: 'codex', sessionsDir: '/fixture/sessions', intervalMs: 2000, activeWithinMs: 300000 }, jump: { terminal: { type: 'windowProcess', processNames: ['Codex.exe'] } } }] });
    expect(config.tasks).toHaveLength(1);
    expect(config.tasks[0].monitor).toEqual({ type: 'codex', sessionsDir: '/fixture/sessions', intervalMs: 2000, activeWithinMs: 300000 });
  });
  it('三工具桌面模板完整解析且全部定位显式进程窗口', () => {
    const { config, warnings } = parseConfigText(readFileSync('config.desktop.example.yaml', 'utf8'));
    expect(warnings).toEqual([]);
    expect(config.tasks.map(t => t.monitor.type)).toEqual(['dsh', 'sqlite', 'codex']);
    expect(config.tasks.every(t => t.enabled && t.jump?.terminal?.type === 'windowProcess')).toBe(true);
    expect(config.tasks.every(t => t.jump?.cwd === undefined && t.jump?.openUrl === undefined)).toBe(true);
  });
  it('非法选项有警告并使用安全默认值', () => {
    const { config, warnings } = validateConfig({ version: 1, tasks: [{ id: 'codex', monitor: { type: 'codex', sessionsDir: '', intervalMs: -1, activeWithinMs: 'bad' } }] });
    expect(config.tasks).toHaveLength(1);
    expect(config.tasks[0].monitor).toEqual({ type: 'codex' });
    expect(warnings.join(' ')).toContain('codex');
  });
});
