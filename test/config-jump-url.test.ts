/**
 * `jump.openUrl` 的校验测试。
 *
 * 【为什么单独一个文件】这份校验的核心不是"能不能用"，而是**安全边界** ——
 * 这个值最终会交给系统去"打开"，若不限协议，配置就能写成
 * `file:///…` 或自定义协议处理程序，变成一个可被配置驱动的任意行为入口。
 * **任务配置不是可信输入**（可能来自分享的示例文件），所以协议必须白名单。
 */

import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/main/config';
import type { JumpConfig } from '../src/shared/types';

/** 造一个带 jump 的最小合法配置。 */
const withJump = (jump: unknown) => ({
  app: { hookPort: 17_890 },
  tasks: [
    {
      id: 't1',
      name: 'T1',
      enabled: true,
      monitor: { type: 'webhook', listen: '127.0.0.1', path: '/hook/t1' },
      jump,
    },
  ],
});

const jumpOf = (jump: unknown): JumpConfig | undefined => {
  const out = validateConfig(withJump(jump));
  return out.config.tasks[0]?.jump;
};

describe('jump.openUrl —— 合法值被接受', () => {
  it('http 被接受', () => {
    expect(jumpOf({ openUrl: 'http://127.0.0.1:3080' })?.openUrl).toBe('http://127.0.0.1:3080');
  });

  it('https 被接受', () => {
    expect(jumpOf({ openUrl: 'https://example.com/a?b=1' })?.openUrl).toBe(
      'https://example.com/a?b=1',
    );
  });

  it('两端的空白被裁掉', () => {
    expect(jumpOf({ openUrl: '  http://127.0.0.1:3080  ' })?.openUrl).toBe(
      'http://127.0.0.1:3080',
    );
  });

  it('可以和 cwd 并存（URL 优先，cwd 作兜底）', () => {
    const j = jumpOf({ openUrl: 'http://127.0.0.1:3080', cwd: 'D:/x' });
    expect(j?.openUrl).toBe('http://127.0.0.1:3080');
    expect(j?.cwd).toBe('D:/x');
  });
});

describe('★★ jump.openUrl —— 危险协议必须被拒绝', () => {
  it('★ file:// 被拒绝（否则能打开任意本地文件）', () => {
    const out = validateConfig(withJump({ openUrl: 'file:///C:/Windows/System32/calc.exe' }));
    expect(out.config.tasks[0]?.jump?.openUrl).toBeUndefined();
    expect(out.warnings.join(' ')).toContain('openUrl');
  });

  it('★ 自定义协议被拒绝（否则能触发任意协议处理程序）', () => {
    for (const bad of [
      'ms-settings:',
      'javascript:alert(1)',
      'vbscript:msgbox',
      'search-ms:query=x',
      'ftp://example.com',
    ]) {
      const j = jumpOf({ openUrl: bad });
      expect(j?.openUrl, `应拒绝 ${bad}`).toBeUndefined();
    }
  });

  it('★ 不是 URL 的字符串被拒绝', () => {
    for (const bad of ['not a url', 'D:/some/path', '//example.com', 'http://']) {
      const j = jumpOf({ openUrl: bad });
      expect(j?.openUrl, `应拒绝 ${JSON.stringify(bad)}`).toBeUndefined();
    }
  });

  it('说明：`http:/broken` 这类会被 WHATWG 规范化后**接受**，不是漏网', () => {
    // 【我原本写错了这条断言】我以为 `http:/broken` 是非法 URL 会被拒。
    // 实测 `new URL('http:/broken')` 是**成功的** —— WHATWG 规范把它
    // 规范化为 `http://broken/`（单斜杠被当作路径分隔容错）。
    // 所以它确实是一个合法的 http URL，接受它是对的，不该"修"代码去迎合错断言。
    expect(new URL('http:/broken').protocol).toBe('http:');
    expect(jumpOf({ openUrl: 'http:/broken' })?.openUrl).toBe('http:/broken');
  });

  it('非字符串被拒绝且不崩', () => {
    for (const bad of [123, true, {}, [], null]) {
      const j = jumpOf({ openUrl: bad });
      expect(j?.openUrl).toBeUndefined();
    }
  });

  it('空字符串被当作"未配置"处理（不告警）', () => {
    const out = validateConfig(withJump({ openUrl: '' }));
    expect(out.config.tasks[0]?.jump?.openUrl).toBeUndefined();
    // 空串在 YAML 里很常见（用户注释掉内容但留了 key），不该刷警告
    expect(out.warnings.filter((w) => w.includes('openUrl'))).toHaveLength(0);
  });

  it('非法协议只丢该字段，**不影响同一 jump 里的其它字段**', () => {
    // 容错原则：单个字段非法只丢弃该字段并记警告
    const j = jumpOf({ openUrl: 'file:///x', cwd: 'D:/keep-me', logFile: 'D:/a.log' });
    expect(j?.openUrl).toBeUndefined();
    expect(j?.cwd).toBe('D:/keep-me');
    expect(j?.logFile).toBe('D:/a.log');
  });
});

describe('jump.openUrlDebugPort —— 合法值被接受', () => {
  it('整数端口被接受', () => {
    const j = jumpOf({ openUrl: 'http://127.0.0.1:13080', openUrlDebugPort: 9222 });
    expect(j?.openUrlDebugPort).toBe(9222);
  });

  it('边界值 1 与 65535 被接受', () => {
    expect(jumpOf({ openUrlDebugPort: 1 })?.openUrlDebugPort).toBe(1);
    expect(jumpOf({ openUrlDebugPort: 65535 })?.openUrlDebugPort).toBe(65535);
  });
});

describe('jump.openUrlDebugPort —— 非法值被拒绝', () => {
  it('越界端口被拒绝', () => {
    for (const bad of [0, -1, 65536, 99999]) {
      expect(jumpOf({ openUrlDebugPort: bad })?.openUrlDebugPort, `应拒绝 ${bad}`).toBeUndefined();
    }
  });

  it('非整数 / 非数字被拒绝', () => {
    for (const bad of [1.5, NaN, '9222', true, {}, [], null]) {
      expect(jumpOf({ openUrlDebugPort: bad })?.openUrlDebugPort, `应拒绝 ${JSON.stringify(bad)}`).toBeUndefined();
    }
  });

  it('非法值只丢该字段，不影响 openUrl', () => {
    const j = jumpOf({ openUrl: 'http://127.0.0.1:13080', openUrlDebugPort: 0 });
    expect(j?.openUrlDebugPort).toBeUndefined();
    expect(j?.openUrl).toBe('http://127.0.0.1:13080');
  });
});

describe('jump.openUrlViaExtension —— 布尔开关', () => {
  it('true / false 都被接受', () => {
    expect(
      jumpOf({ openUrl: 'http://127.0.0.1:13080', openUrlViaExtension: true })?.openUrlViaExtension,
    ).toBe(true);
    expect(jumpOf({ openUrlViaExtension: false })?.openUrlViaExtension).toBe(false);
  });

  it('非布尔被拒绝（字符串 "true" 也不行，避免 YAML 引号歧义）', () => {
    for (const bad of ['true', 1, 0, {}, [], null]) {
      expect(
        jumpOf({ openUrlViaExtension: bad })?.openUrlViaExtension,
        `应拒绝 ${JSON.stringify(bad)}`,
      ).toBeUndefined();
    }
  });

  it('非法值只丢该字段，不影响 openUrl 与它的组合', () => {
    const j = jumpOf({
      openUrl: 'http://127.0.0.1:13080',
      openUrlViaExtension: 'yes',
      openUrlDebugPort: 9222,
    });
    expect(j?.openUrlViaExtension).toBeUndefined();
    expect(j?.openUrl).toBe('http://127.0.0.1:13080');
    expect(j?.openUrlDebugPort).toBe(9222);
  });
});
