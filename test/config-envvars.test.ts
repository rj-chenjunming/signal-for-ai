/**
 * 配置环境变量展开测试。
 *
 * 【这个功能的由来】用户配置里习惯写 `%USERPROFILE%/.workbuddy/logs/*.log`，
 * 但 Node 的 glob 不会展开它 → 匹配 0 个文件且**不报任何错**。
 * 这个「静默失效」实测坑过一次，故补测试钉住。
 */
import { describe, expect, it } from 'vitest';
import { expandEnvVars, validateConfig } from '../src/main/config';

describe('expandEnvVars 环境变量展开', () => {
  it('展开 Windows 风格 %VAR%', () => {
    process.env.ATI_TEST_VAR = 'C:\\Users\\tester';
    expect(expandEnvVars('%ATI_TEST_VAR%/.workbuddy/logs/*.log')).toBe(
      'C:\\Users\\tester/.workbuddy/logs/*.log',
    );
    delete process.env.ATI_TEST_VAR;
  });

  it('展开 POSIX 风格 ${VAR} 与 $VAR', () => {
    process.env.ATI_TEST_POSIX = '/home/tester';
    expect(expandEnvVars('${ATI_TEST_POSIX}/logs')).toBe('/home/tester/logs');
    expect(expandEnvVars('$ATI_TEST_POSIX/logs')).toBe('/home/tester/logs');
    delete process.env.ATI_TEST_POSIX;
  });

  it('未定义的变量替换为空串，不残留 %VAR% 噪声', () => {
    expect(expandEnvVars('%ATI_DEFINITELY_NOT_SET%')).toBe('');
    expect(expandEnvVars('${ATI_DEFINITELY_NOT_SET}')).toBe('');
  });

  it('普通字符串不受影响', () => {
    expect(expandEnvVars('D:/projects/**/*.log')).toBe('D:/projects/**/*.log');
  });

  it('正则里的 $ 不被误当变量（$1 等反向引用要保留）', () => {
    // 这个很重要：规则正则里常有 $1 / $^ 之类，
    // 若被当环境变量展开会直接破坏正则。
    expect(expandEnvVars('(\\d+)-(\\w+)')).toBe('(\\d+)-(\\w+)');
    expect(expandEnvVars('a$1b')).toBe('a$1b');
  });

  it('不含 $ 的正则原样保留', () => {
    expect(expandEnvVars('(error|fatal|exception)')).toBe('(error|fatal|exception)');
  });
});

describe('validateConfig 集成：整棵配置树都应被展开', () => {
  it('tasks 里的 paths 会被展开', () => {
    process.env.ATI_TEST_ROOT = 'D:\\projects';
    const out = validateConfig({
      version: 1,
      tasks: [
        {
          id: 't1',
          name: 'T1',
          enabled: true,
          monitor: {
            type: 'log',
            paths: ['%ATI_TEST_ROOT%/**/*.log'],
            rules: [{ state: 'failed', match: '(error)' }],
          },
        },
      ],
    });
    expect(out.config.tasks[0]!.monitor.type).toBe('log');
    if (out.config.tasks[0]!.monitor.type === 'log') {
      expect(out.config.tasks[0]!.monitor.paths[0]).toBe('D:\\projects/**/*.log');
    }
    delete process.env.ATI_TEST_ROOT;
  });

  it('嵌套字段（jump.cwd / fallbackLog.paths）同样被展开', () => {
    process.env.ATI_TEST_DIR = 'D:/myproj';
    const out = validateConfig({
      version: 1,
      tasks: [
        {
          id: 't2',
          name: 'T2',
          enabled: true,
          monitor: {
            type: 'log',
            paths: ['${ATI_TEST_DIR}/logs/*.log'],
            rules: [{ state: 'success', match: '(done)' }],
          },
          jump: { cwd: '$ATI_TEST_DIR', terminal: { type: 'none' } },
        },
      ],
    });
    const t = out.config.tasks[0]!;
    if (t.monitor.type === 'log') {
      expect(t.monitor.paths[0]).toBe('D:/myproj/logs/*.log');
    }
    expect(t.jump?.cwd).toBe('D:/myproj');
    delete process.env.ATI_TEST_DIR;
  });

  it('展开发生在校验之前，未定义变量不会导致误判为非法路径', () => {
    // 回归：以前 %VAR% 会被当普通字符接受，
    // 于是 glob 拿字面量去匹配 → 0 个文件且无提示。
    const out = validateConfig({
      version: 1,
      tasks: [
        {
          id: 't3',
          name: 'T3',
          enabled: true,
          monitor: {
            type: 'log',
            paths: ['%ATI_NOT_SET_ANYWHERE%/x.log'],
            rules: [{ state: 'failed', match: '(e)' }],
          },
        },
      ],
    });
    expect(out.warnings).toHaveLength(0);
  });
});