/**
 * SPEC-005：`authority: auto` 的自动发现选择逻辑。
 *
 * 这里只测"候选如何被挑选"——真实端口枚举/HTTP 探测属于 IO，由真机验收覆盖
 * （`discoverDshInstances` 本身已有独立测试）。
 */
import { describe, expect, it, vi } from 'vitest';

import { discoverLocalAuthority } from '../src/main/monitors/dsh-auto';
import { StaticSecretSource } from '../src/main/monitors/dsh';
import type { DiscoveryResult } from '../src/main/monitors/dsh-discovery';

const SECRET = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');

function result(instances: DiscoveryResult['instances']): DiscoveryResult {
  return {
    listenerSource: 'Get-NetTCPConnection',
    listenerError: undefined,
    probedCount: instances.length,
    instances,
    nonDsh: [],
  };
}

function instance(authority: string, status: number, hint = '') {
  return {
    authority,
    pid: 123,
    origin: 'auto' as const,
    kind: status === 200 ? ('local' as const) : ('remote' as const),
    authenticated: status === 200,
    status,
    hint,
  };
}

const base = {
  secretSources: [new StaticSecretSource(SECRET)],
};

describe('SPEC-005 自动发现：挑选能用本机密钥认证的实例', () => {
  it('只有一个 200（本机型）→ 选它', async () => {
    const discover = vi.fn(async () =>
      result([instance('127.0.0.1:52119', 200, '本机密钥认证通过（23 会话）')]),
    );
    const chosen = await discoverLocalAuthority({ ...base, discover });
    expect(chosen).toBe('127.0.0.1:52119');
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it('★ 本机型与隧道型同时存在时，必须选本机型（401 的不能抢）', async () => {
    const discover = vi.fn(async () =>
      result([
        instance('127.0.0.1:13080', 401, '本机密钥被拒（远端/隧道型）'),
        instance('127.0.0.1:52119', 200, '本机密钥认证通过（23 会话）'),
      ]),
    );
    const chosen = await discoverLocalAuthority({ ...base, discover });
    expect(chosen).toBe('127.0.0.1:52119');
  });

  it('只有 401（远端/隧道型）→ 返回 null，并给出可读告警', async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const discover = vi.fn(async () => result([instance('127.0.0.1:13080', 401)]));
    const chosen = await discoverLocalAuthority({ ...base, discover, log });
    expect(chosen).toBeNull();
    expect(log.warn).toHaveBeenCalled();
    expect(String(log.warn.mock.calls[0]?.[0])).toContain('没有一个能用本机密钥认证');
  });

  it('一个 dsh 都没认出 → null（不是抛异常）', async () => {
    const discover = vi.fn(async () => result([]));
    await expect(discoverLocalAuthority({ ...base, discover })).resolves.toBeNull();
  });

  it('发现器自己抛错 → null（错误隔离，不能把监控打崩）', async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const discover = vi.fn(async () => {
      throw new Error('netstat 被拦');
    });
    const chosen = await discoverLocalAuthority({ ...base, discover, log });
    expect(chosen).toBeNull();
    expect(String(log.warn.mock.calls[0]?.[0])).toContain('自动发现失败（已隔离）');
  });

  it('监听枚举两条路径都失败时记录原因，仍然不抛', async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const discover = vi.fn(async () => ({
      ...result([instance('127.0.0.1:52119', 200)]),
      listenerSource: 'none' as const,
      listenerError: 'powershell 与 netstat 都不可用',
    }));
    const chosen = await discoverLocalAuthority({ ...base, discover, log });
    expect(chosen).toBe('127.0.0.1:52119');
    expect(
      log.warn.mock.calls.some((c) => String(c[0]).includes('监听端口枚举两条路径都失败')),
    ).toBe(true);
  });
});
