import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/main/config';

describe('SPEC-041 ZCode 配置', () => {
  it('保留 ZCode 监控、项目过滤与进程窗口目标', () => {
    const { config } = validateConfig({
      version: 1,
      tasks: [
        {
          id: 'zcode',
          name: 'ZCode',
          monitor: {
            type: 'zcode',
            dbPath: 'C:/Users/fixture/.zcode/cli/db/db.sqlite',
            projects: ['C:/Users/fixture/PRJ/ai-signal'],
            intervalMs: 3000,
            activeWithinMs: 600000,
            maxFailures: 3,
          },
          jump: { terminal: { type: 'windowProcess', processNames: ['ZCode.exe'] } },
        },
      ],
    });
    expect(config.tasks).toHaveLength(1);
    expect(config.tasks[0].monitor).toEqual({
      type: 'zcode',
      dbPath: 'C:/Users/fixture/.zcode/cli/db/db.sqlite',
      projects: ['C:/Users/fixture/PRJ/ai-signal'],
      intervalMs: 3000,
      activeWithinMs: 600000,
      maxFailures: 3,
    });
  });

  it('缺省字段走默认值口径，非法字段有警告并按字段丢弃', () => {
    const { config, warnings } = validateConfig({
      version: 1,
      tasks: [{ id: 'zcode', monitor: { type: 'zcode', dbPath: '', projects: 'not-an-array', intervalMs: -1, maxFailures: 'bad' } }],
    });
    expect(config.tasks).toHaveLength(1);
    expect(config.tasks[0].monitor).toEqual({ type: 'zcode' });
    expect(warnings.join(' ')).toContain('zcode');
  });

  it('projects 元素非法时丢弃非法元素', () => {
    const { config, warnings } = validateConfig({
      version: 1,
      tasks: [{ id: 'zcode', monitor: { type: 'zcode', projects: ['C:/ok', 42, ''] } }],
    });
    expect(config.tasks[0].monitor).toEqual({ type: 'zcode', projects: ['C:/ok'] });
    expect(warnings.join(' ')).toContain('projects');
  });
});
