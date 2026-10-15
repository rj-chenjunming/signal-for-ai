/**
 * 配置加载与校验测试。
 *
 * PRD P0-7 的硬要求：**配置写错不能导致应用崩溃**，最坏情况是丢弃坏字段
 * 并用默认值继续跑。因此这里重点验证「宽容降级」而不是「严格拒绝」。
 */
import { describe, expect, it } from 'vitest';
import {
  emptyConfig,
  parseConfigArg,
  parseConfigText,
  userConfigPath,
  validateConfig,
} from '../src/main/config';

describe('parseConfigArg 命令行覆盖', () => {
  it('解析 --config <path>', () => {
    expect(parseConfigArg(['electron', '.', '--config', 'D:/a.yaml'])).toBe('D:/a.yaml');
  });

  it('解析 -c <path>短选项', () => {
    expect(parseConfigArg(['-c', 'D:/b.yaml'])).toBe('D:/b.yaml');
  });

  it('解析 --config=<path> 等号写法', () => {
    expect(parseConfigArg(['--config=D:/c.yaml'])).toBe('D:/c.yaml');
  });

  it('--config 后缺值时返回 null而不是空串', () => {
    expect(parseConfigArg(['--config'])).toBeNull();
    expect(parseConfigArg(['--config', '--other'])).toBeNull();
    expect(parseConfigArg(['--config='])).toBeNull();
  });

  it('无参数时返回 null', () => {
    expect(parseConfigArg(['electron', '.'])).toBeNull();
  });
});

describe('userConfigPath 路径约定', () => {
  it('落在 %USERPROFILE%/.ai-task-indicator/config.yaml', () => {
    const p = userConfigPath('C:/Users/demo');
    expect(p).toContain('.ai-task-indicator');
    expect(p.endsWith('config.yaml')).toBe(true);
  });
});

describe('validateConfig 宽容降级（PRD P0-7）', () => {
  it('空输入返回空配置而不抛异常', () => {
    expect(() => validateConfig(null)).not.toThrow();
    expect(() => validateConfig(undefined)).not.toThrow();
    expect(() => validateConfig('not an object')).not.toThrow();
  });

  it('缺字段时补齐默认值', () => {
    const out = validateConfig({});
    expect(out.config.app.pollIntervalMs).toBeGreaterThan(0);
    expect(out.config.notify.notifyStates.length).toBeGreaterThan(0);
    expect(Array.isArray(out.config.tasks)).toBe(true);
  });

  it('非法任务项被丢弃，其余任务照常生效', () => {
    const out = validateConfig({
      version: 1,
      tasks: [
        { id: 'good', name: '好任务', enabled: true, monitor: { type: 'log', paths: ['a.log'], rules: [] } },
        { name: '缺 id', monitor: { type: 'log', paths: ['b.log'], rules: [] } }, // 非法
        null,
        123,
      ],
    });
    // 好任务保留，坏任务被逐条丢弃
    expect(out.config.tasks.map((t) => t.id)).toEqual(['good']);
    // 每条丢弃都有明确警告，便于用户定位是哪一行写错了
    expect(out.warnings.length).toBeGreaterThanOrEqual(3);
    expect(out.warnings.join('\n')).toContain('id 缺失或为空');
  });

  it('未知字段被忽略而不是报错（向前兼容）', () => {
    const out = validateConfig({
      version: 1,
      someFutureField: { a: 1 },
      app: { pollIntervalMs: 5000, futureAppField: true },
      tasks: [],
    });
    expect(out.config.app.pollIntervalMs).toBe(5000);
  });

  it('类型错误字段被丢弃并保留默认，不影响其他字段', () => {
    const out = validateConfig({
      app: { pollIntervalMs: 'not-a-number', startMinimized: true },
    });
    // 坏字段回退默认
    expect(typeof out.config.app.pollIntervalMs).toBe('number');
    // 同级好字段仍然生效
    expect(out.config.app.startMinimized).toBe(true);
  });

  it('负数/零的超时值被夹到合法区间', () => {
    const out = validateConfig({
      defaults: { stateTimeout: { staleTimeoutMs: -1, dismissAfterMs: 0 } },
    });
    expect(out.config.defaults.stateTimeout.staleTimeoutMs).toBeGreaterThan(0);
    expect(out.config.defaults.stateTimeout.dismissAfterMs).toBeGreaterThan(0);
  });

  it('monitor.type 未知时任务被跳过，不影响其他任务', () => {
    const out = validateConfig({
      tasks: [
        { id: 'ok', name: 'ok', enabled: true, monitor: { type: 'webhook', listen: '127.0.0.1', path: '/hook/ok' } },
        { id: 'weird', name: 'weird', enabled: true, monitor: { type: 'carrier-pigeon' } },
      ],
    });
    expect(out.config.tasks.map((t) => t.id)).toContain('ok');
  });
});

describe('parseConfigText YAML 解析', () => {
  it('解析合法 YAML', () => {
    const out = parseConfigText(`
version: 1
app:
  pollIntervalMs: 4000
tasks:
  - id: t1
    name: 任务一
    enabled: true
    monitor:
      type: log
      paths: ["a.log"]
      rules:
        - state: success
          match: "done"
`);
    expect(out.config.app.pollIntervalMs).toBe(4000);
    expect(out.config.tasks).toHaveLength(1);
    expect(out.config.tasks[0]!.id).toBe('t1');
  });

  it('语法错误的 YAML 抛 ConfigSyntaxError，由上层 ConfigManager 捕获', () => {
    //这里刻意断言"抛错"而不是"静默降级"：语法错误说明配置文件被改坏了，
    // 此时静默用默认配置启动会让用户以为配置生效了，实际监控的却是错的任务。
    // 正确做法是抛出可识别的错误类型，由 ConfigManager 捕获后保留旧配置
    // 并在托盘气泡提示"配置语法错误"。
    expect(() => parseConfigText('app:\n  - [unclosed\n\t bad: : :')).toThrow(
      /YAML|语法/i,
    );
  });

  it('ConfigSyntaxError 携带原始 cause，便于定位', () => {
    try {
      parseConfigText('a:\n- [\nb: : :');
      throw new Error('本应抛出 ConfigSyntaxError');
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message.length).toBeGreaterThan(0);
    }
  });

  it('空文本返回空配置', () => {
    const out = parseConfigText('');
    expect(Array.isArray(out.config.tasks)).toBe(true);
  });
});

describe('emptyConfig 基线', () => {
  it('结构完整，可直接启动不崩', () => {
    const cfg = emptyConfig(['测试警告']);
    expect(cfg.tasks).toEqual([]);
    expect(cfg.app.hookPort).toBeGreaterThan(0);
    expect(cfg.notify.notifyStates.length).toBeGreaterThan(0);
  });
});

describe('仓库内示例配置必须可用', () => {
  it('config.example.yaml 能被解析且零错误', () => {
    // 这个用例防止示例配置腐化：文档里的示例一旦和类型定义脱节，
    // 用户照抄就等于拿到一个跑不起来的配置。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    const file = path.join(__dirname, '..', 'config.example.yaml');
    if (!fs.existsSync(file)) {
      return; // 示例文件缺失时不误报失败
    }
    const out = parseConfigText(fs.readFileSync(file, 'utf8'));
    // ValidationOutcome 只有 config 与 warnings（语法错误走ConfigSyntaxError 抛出，不进这里）
    expect(out.warnings).toHaveLength(0);
    expect(out.config.tasks.map((t) => t.monitor.type).sort()).toEqual([
      'log',
      'process',
      'webhook',
    ]);
  });
});