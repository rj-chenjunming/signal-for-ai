/**
 * 配置加载补充测试（QA 补充）—— 架构 T02 验收项。
 *
 * 既有 config.test.ts 覆盖了 validateConfig 的逐项降级，
 * 本文件专门补齐它遗漏的两块：
 *  1. `resolveConfigPath` 的四级优先级（既有测试只测了 parseConfigArg 单函数）；
 *  2. `defaults.colors` 的校验与**实际生效链路**（颜色是 PRD §6 暴露给用户的配置项）。
 */
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseConfigText, resolveConfigPath, validateConfig } from '../src/main/config';
import { STATUS_COLOR } from '../src/shared/constants';

const HOME = path.join('C:', 'Users', 'tester');
const USER_DATA = path.join('C:', 'appdata', 'ai-task-indicator');
const USER_CONFIG = path.join(HOME, '.ai-task-indicator', 'config.yaml');
const USER_DATA_CONFIG = path.join(USER_DATA, 'config.yaml');

describe('resolveConfigPath 四级优先级（架构 D7 / §1.7）', () => {
  it('1 级：--config 最高优先级，压过所有已存在的文件', () => {
    const r = resolveConfigPath({
      argv: ['--config', 'C:/custom/my.yaml'],
      userDataDir: USER_DATA,
      homeDir: HOME,
      exists: () => true, // 用户配置与 userData 配置都存在
    });
    expect(r.source).toBe('cli');
    expect(path.normalize(r.path)).toBe(path.normalize(path.resolve('C:/custom/my.yaml')));
  });

  it('2 级：用户配置路径存在时优先于 userData', () => {
    const r = resolveConfigPath({
      argv: [],
      userDataDir: USER_DATA,
      homeDir: HOME,
      exists: (p) => path.normalize(p) === path.normalize(USER_CONFIG),
    });
    expect(r.source).toBe('user');
    expect(path.normalize(r.path)).toBe(path.normalize(USER_CONFIG));
  });

  it('3 级：用户配置不存在但 userData 存在时用 userData', () => {
    const r = resolveConfigPath({
      argv: [],
      userDataDir: USER_DATA,
      homeDir: HOME,
      exists: (p) => path.normalize(p) === path.normalize(USER_DATA_CONFIG),
    });
    expect(r.source).toBe('userData');
    expect(path.normalize(r.path)).toBe(path.normalize(USER_DATA_CONFIG));
  });

  it('4 级：全都不存在时回落到用户配置路径（供首次运行落盘模板）', () => {
    const r = resolveConfigPath({
      argv: [],
      userDataDir: USER_DATA,
      homeDir: HOME,
      exists: () => false,
    });
    expect(r.source).toBe('default');
    // 必须落回可写的用户目录，而不是 userData
    expect(path.normalize(r.path)).toBe(path.normalize(USER_CONFIG));
  });

  it('同时存在 user 与 userData 时，user 胜出', () => {
    const r = resolveConfigPath({
      argv: [],
      userDataDir: USER_DATA,
      homeDir: HOME,
      exists: () => true,
    });
    expect(r.source).toBe('user');
  });

  it('-c 短选项与 --config 等价', () => {
    for (const argv of [['--config', 'x.yaml'], ['-c', 'x.yaml'], ['--config=x.yaml']]) {
      expect(resolveConfigPath({ argv, userDataDir: USER_DATA, homeDir: HOME, exists: () => true }).source).toBe('cli');
    }
  });

  it('--config 缺值时视为未提供，继续走 2 级（不返回空路径）', () => {
    const r = resolveConfigPath({
      argv: ['--config'],
      userDataDir: USER_DATA,
      homeDir: HOME,
      exists: (p) => path.normalize(p) === path.normalize(USER_CONFIG),
    });
    expect(r.source).toBe('user');
    expect(r.path.length).toBeGreaterThan(0);
  });
});

describe('defaults.colors 校验（PRD §6）', () => {
  it('合法 #RRGGBB 覆盖被接受', () => {
    const { config, warnings } = validateConfig({ defaults: { colors: { failed: '#FF0000' } } });
    expect(config.defaults.colors.failed).toBe('#FF0000');
    expect(warnings).toHaveLength(0);
  });

  it('合法 #RGB 短格式被接受', () => {
    const { config } = validateConfig({ defaults: { colors: { running: '#0F0' } } });
    expect(config.defaults.colors.running).toBe('#0F0');
  });

  it('非法颜色格式被丢弃并产生 warning（PRD P0-7 不崩溃）', () => {
    const { config, warnings } = validateConfig({
      defaults: { colors: { failed: 'red', running: '#GGGGGG' } },
    });
    expect(config.defaults.colors.failed).toBeUndefined();
    expect(config.defaults.colors.running).toBeUndefined();
    expect(warnings.some((w) => w.includes('颜色格式非法'))).toBe(true);
  });

  it('非七态的键被丢弃并提示合法值', () => {
    const { config, warnings } = validateConfig({ defaults: { colors: { crashed: '#FF0000' } } });
    // colors 的类型是 Partial<Record<TaskStatus, string>>，合法键只有七态。
    // 因此不能写 colors.crashed（那会被 TS 拦下），要用索引签名断言"该键不存在"。
    const colors = config.defaults.colors as Record<string, string | undefined>;
    expect(colors.crashed).toBeUndefined();
    expect(warnings.some((w) => w.includes('不是合法状态名'))).toBe(true);
  });

  it('未配置 colors 时默认为空对象（回落到 STATUS_COLOR）', () => {
    const { config } = validateConfig({});
    expect(config.defaults.colors).toEqual({});
  });

  it('默认状态色与 PRD §5.1 逐字一致（单一来源校验）', () => {
    expect(STATUS_COLOR).toEqual({
      idle: '#6B7280',
      starting: '#93C5FD',
      running: '#3B82F6',
      waiting: '#F59E0B',
      success: '#22C55E',
      failed: '#EF4444',
      unknown: '#4B5563',
    });
  });
});

describe('配置宽容降级的边界（PRD P0-7）', () => {
  it('根节点是数组/字符串时返回全默认配置而不抛异常', () => {
    for (const bad of [[], 'text', 42, true]) {
      const { config } = validateConfig(bad);
      expect(config.tasks).toEqual([]);
      expect(config.app.pollIntervalMs).toBeGreaterThan(0);
    }
  });

  it('task id 首尾空白被trim，重复 id 只保留第一条', () => {
    const { config, warnings } = validateConfig({
      tasks: [
        { id: '  a  ', name: 'A', monitor: { type: 'webhook' } },
        { id: 'a', name: 'A2', monitor: { type: 'webhook' } },
      ],
    });
    expect(config.tasks).toHaveLength(1);
    expect(config.tasks[0]?.id).toBe('a');
    expect(warnings.some((w) => w.includes('重复'))).toBe(true);
  });

  it('task id 为纯空白字符串时被丢弃', () => {
    const { config, warnings } = validateConfig({
      tasks: [{ id: '   ', monitor: { type: 'webhook' } }],
    });
    expect(config.tasks).toHaveLength(0);
    expect(warnings.some((w) => w.includes('id 缺失'))).toBe(true);
  });

  it('webhook.listen 非 loopback 被强制改回 127.0.0.1（架构 §4.4 安全）', () => {
    const { config, warnings } = validateConfig({
      tasks: [{ id: 'a', monitor: { type: 'webhook', listen: '0.0.0.0' } }],
    });
    expect(config.tasks[0]?.monitor.type).toBe('webhook');
    if (config.tasks[0]?.monitor.type === 'webhook') {
      expect(config.tasks[0].monitor.listen).toBe('127.0.0.1');
    }
    expect(warnings.some((w) => w.includes('loopback'))).toBe(true);
  });

  it('webhook.path 不以 / 开头时回退到 /hook/<id>', () => {
    const { config } = validateConfig({
      tasks: [{ id: 'abc', monitor: { type: 'webhook', path: 'hook/abc' } }],
    });
    if (config.tasks[0]?.monitor.type === 'webhook') {
      expect(config.tasks[0].monitor.path).toBe('/hook/abc');
    }
  });

  it('hookPort 超出 65535 时回退默认端口', () => {
    const { config, warnings } = validateConfig({ app: { hookPort: 999999 } });
    expect(config.app.hookPort).toBe(17890);
    expect(warnings.some((w) => w.includes('端口范围'))).toBe(true);
  });

  it('notify.actions 超过 3 个被截断（Windows 通知按钮上限）', () => {
    const { config, warnings } = validateConfig({
      notify: {
        actions: [
          { id: 'focus_terminal', label: 'A' },
          { id: 'open_log', label: 'B' },
          { id: 'open_dir', label: 'C' },
          { id: 'focus_terminal', label: 'D' },
        ],
      },
    });
    expect(config.notify.actions).toHaveLength(3);
    expect(warnings.some((w) => w.includes('超过 3 个'))).toBe(true);
  });

  it('notify.actions 含非法 id 时丢弃该项，其余保留', () => {
    const { config, warnings } = validateConfig({
      notify: {
        actions: [
          { id: 'focus_terminal', label: '打开终端' },
          { id: 'delete_everything', label: '危险' },
        ],
      },
    });
    expect(config.notify.actions).toHaveLength(1);
    expect(warnings.some((w) => w.includes('非法'))).toBe(true);
  });

  it('notify.notifyStates 全为非法值时回落到默认三态', () => {
    const { config, warnings } = validateConfig({ notify: { notifyStates: ['oops', 'nope'] } });
    expect(config.notify.notifyStates).toEqual(['waiting', 'success', 'failed']);
    expect(warnings.some((w) => w.includes('非法状态'))).toBe(true);
  });

  it('stateTimeout 负数与零被忽略并保留默认（不产生 0ms 疯狂触发）', () => {
    const { config } = validateConfig({
      defaults: { stateTimeout: { staleTimeoutMs: -1, dismissAfterMs: 0 } },
    });
    expect(config.defaults.stateTimeout.staleTimeoutMs).toBe(60_000);
    expect(config.defaults.stateTimeout.dismissAfterMs).toBe(600_000);
  });

  it('version 非 1 时保留原值但给出 warning（向前兼容不丢配置）', () => {
    const { config, warnings } = validateConfig({ version: 2, tasks: [] });
    expect(config.version).toBe(2);
    expect(warnings.some((w) => w.includes('version'))).toBe(true);
  });

  it('单个坏任务不影响好任务（PRD P0-7 核心保证）', () => {
    const { config } = validateConfig({
      tasks: [
        { id: 'good1', monitor: { type: 'webhook' } },
        { id: 'bad', monitor: { type: 'nonsense' } },
        'not-an-object',
        { name: 'no-id', monitor: { type: 'webhook' } },
        { id: 'good2', monitor: { type: 'log', paths: ['a.log'], rules: [{ state: 'failed', match: 'err' }] } },
      ],
    });
    expect(config.tasks.map((t) => t.id)).toEqual(['good1', 'good2']);
  });
});

describe('YAML 文本解析', () => {
  it('带注释与引号的合法 YAML 能正确解析', () => {
    const { config } = parseConfigText(`
version: 1
app:
  pollIntervalMs: 5000   # 5秒
tasks:
  - id: "quoted-task"
    name: 'single quoted'
    monitor:
      type: webhook
      path: /hook/quoted-task
`);
    expect(config.app.pollIntervalMs).toBe(5000);
    expect(config.tasks[0]?.id).toBe('quoted-task');
    expect(config.tasks[0]?.name).toBe('single quoted');
  });

  it('缩进错误的 YAML 抛 ConfigSyntaxError（由上层保留旧配置）', () => {
    expect(() => parseConfigText('app:\n  pollIntervalMs: 1\n bad indent: x')).toThrow();
  });

  it('注释-only 的 YAML 返回空配置', () => {
    const { config, warnings } = parseConfigText('# 只有注释\n');
    expect(config.tasks).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });
});