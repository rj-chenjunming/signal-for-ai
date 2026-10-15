/**
 * dsh-discovery 单测。
 *
 * 分两部分：
 *   1. 纯函数部分（netstat 解析、候选合并/去重、分类）—— 用注入的探针，确定性
 *   2. 真实扫描部分 —— 真的枚举本机端口、真的探 3080，验证端到端可用
 *
 * 注意第 2 部分依赖本机确实有 dsh web 在跑；若没有则跳过（不误报失败）。
 */

import { describe, expect, it } from 'vitest';
import { parseNetstatOutput, discoverDshInstances, enumerateListeners } from '../src/main/monitors/dsh-discovery';

describe('parseNetstatOutput', () => {
  it('抽出 LISTENING 行的 地址/端口/PID', () => {
    const text = [
      '',
      '活动连接',
      '',
      '  协议  本地地址          外部地址        状态           PID',
      '  TCP    127.0.0.1:3080         0.0.0.0:0              LISTENING       20156',
      '  TCP    127.0.0.1:13080        0.0.0.0:0              LISTENING       19432',
      '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1192',
      '  TCP    127.0.0.1:5000         127.0.0.1:6000         ESTABLISHED     999',
      '',
    ].join('\r\n');

    const listeners = parseNetstatOutput(text);
    expect(listeners).toHaveLength(3);
    expect(listeners[0]).toEqual({ address: '127.0.0.1', port: 3080, pid: 20156 });
    expect(listeners[1]).toEqual({ address: '127.0.0.1', port: 13080, pid: 19432 });
    expect(listeners[2]).toEqual({ address: '0.0.0.0', port: 135, pid: 1192 });
  });

  it('忽略非 LISTENING 行与无关键', () => {
    const text = [
      '  TCP    127.0.0.1:5000   127.0.0.1:6000   ESTABLISHED   999',
      '  UDP    127.0.0.1:5000   *:*                                999',
      'garbage line',
      '  TCP    127.0.0.1:8080   0.0.0.0:0        LISTENING     1234',
    ].join('\n');

    const listeners = parseNetstatOutput(text);
    expect(listeners).toHaveLength(1);
    expect(listeners[0]?.port).toBe(8080);
  });

  it('空输入不崩', () => {
    expect(parseNetstatOutput('')).toEqual([]);
  });
});

describe('enumerateListeners', () => {
  it('能真的枚举出本机监听端口（或明确说明两条路径都不可用）', async () => {
    const result = await enumerateListeners();
    if (result.error !== undefined) {
      // 沙箱环境两条路径都被拦是可能的；此时必须明确报错而不是静默返回空
      expect(result.source).toBe('none');
      expect(result.error.length).toBeGreaterThan(0);
    } else {
      expect(['Get-NetTCPConnection', 'netstat -ano']).toContain(result.source);
      expect(result.listeners.length).toBeGreaterThan(0);
      // 每个 listener 的字段形状都要靠谱
      for (const l of result.listeners) {
        expect(Number.isInteger(l.port)).toBe(true);
        expect(l.port).toBeGreaterThan(0);
        expect(l.port).toBeLessThanOrEqual(65535);
      }
    }
  }, 30_000);

  it('excludePorts 能真的把端口挡掉', async () => {
    const all = await enumerateListeners();
    if (all.error !== undefined) return; // 环境不支持则跳过
    const victim = all.listeners[0];
    if (victim === undefined) return;

    const filtered = await enumerateListeners([victim.port]);
    expect(filtered.listeners.some((l) => l.port === victim.port)).toBe(false);
  }, 40_000);
});

describe('discoverDshInstances —— 注入探针，确定性', () => {
  /** 造一个假探针：只对给定端口答"是 dsh web"。 */
  const makeProbe = (dshPorts: Set<string>, authedPorts: Set<string>) =>
    async (authority: string) => {
      const isDsh = dshPorts.has(authority);
      if (!isDsh) {
        return { reachable: true, isDshWeb: false, status: 200, hint: '别的服务' };
      }
      const authed = authedPorts.has(authority);
      return {
        reachable: true,
        isDshWeb: true,
        status: authed ? 200 : 401,
        hint: authed ? '特征匹配' : '401 未授权',
      };
    };

  it('只把确认是 dsh web 的收进 instances，其余进 nonDsh', async () => {
    const result = await discoverDshInstances({
      extraPorts: [3080, 13080, 9999],
      probe: makeProbe(new Set(['127.0.0.1:3080', '127.0.0.1:13080']), new Set(['127.0.0.1:3080'])),
    });

    const authorities = result.instances.map((i) => i.authority).sort();
    expect(authorities).toContain('127.0.0.1:3080');
    expect(authorities).toContain('127.0.0.1:13080');
    expect(authorities).not.toContain('127.0.0.1:9999');

    const nines = result.nonDsh.find((n) => n.authority === '127.0.0.1:9999');
    expect(nines).toBeDefined();
  });

  it('200 → local；401 → remote（本机密钥不匹配即是隧道型）', async () => {
    const result = await discoverDshInstances({
      extraAuthorities: ['127.0.0.1:3080', '127.0.0.1:13080'],
      probe: makeProbe(new Set(['127.0.0.1:3080', '127.0.0.1:13080']), new Set(['127.0.0.1:3080'])),
    });

    const local = result.instances.find((i) => i.authority === '127.0.0.1:3080');
    const remote = result.instances.find((i) => i.authority === '127.0.0.1:13080');

    expect(local?.kind).toBe('local');
    expect(local?.authenticated).toBe(true);
    expect(remote?.kind).toBe('remote');
    expect(remote?.authenticated).toBe(false);
  });

  it('手动追加的 authority 标记为 manual（不会被自动扫描覆盖成 auto）', async () => {
    const result = await discoverDshInstances({
      extraAuthorities: ['127.0.0.1:3080'],
      probe: makeProbe(new Set(['127.0.0.1:3080']), new Set(['127.0.0.1:3080'])),
    });
    const found = result.instances.find((i) => i.authority === '127.0.0.1:3080');
    expect(found?.origin).toBe('manual');
  });

  it('单个探针抛异常不会让整体失败（错误隔离铁律）', async () => {
    const result = await discoverDshInstances({
      extraAuthorities: ['127.0.0.1:1111', '127.0.0.1:2222'],
      probe: async (authority) => {
        if (authority.endsWith(':1111')) throw new Error('探针炸了');
        return { reachable: true, isDshWeb: true, status: 200, hint: 'ok' };
      },
    });

    // 1111 抛错被兜住，2222 仍然正常
    expect(result.instances.some((i) => i.authority === '127.0.0.1:2222')).toBe(true);
    expect(result.instances.some((i) => i.authority === '127.0.0.1:1111')).toBe(false);
  });

  it('cookieFor 会为每个候选 authority 提供 cookie（含手动追加的）', async () => {
    const seen: (string | undefined)[] = [];
    await discoverDshInstances({
      // 注意：discoverDshInstances 会**自动枚举真实端口**，所以 cookieFor
      // 会被本机所有候选各调一次 —— 断言要针对"目标 authority 拿到了正确 cookie"，
      // 而不是"只被调了一次"。
      extraAuthorities: ['127.0.0.1:3080'],
      cookieFor: (authority) => `cookie-for-${authority}`,
      probe: async (_authority, cookieHeader) => {
        seen.push(cookieHeader);
        return { reachable: true, isDshWeb: true, status: 200, hint: 'ok' };
      },
    });

    expect(seen.length).toBeGreaterThan(0);
    // 每个候选都必须拿到与自己 authority 对应的 cookie，一个都不能是 undefined
    expect(seen.every((c) => typeof c === 'string' && c.startsWith('cookie-for-127.0.0.1:'))).toBe(true);
    expect(seen).toContain('cookie-for-127.0.0.1:3080');
  });
});

describe('discoverDshInstances —— 真实扫描本机', () => {
  it('能在本机发现至少一个 dsh web（若无则明确记录而不是假通过）', async () => {
    const result = await discoverDshInstances({ onProgress: () => undefined });

    if (result.listenerError !== undefined) {
      // 端口枚举不可用 → 至少要明确报错
      expect(result.listenerError.length).toBeGreaterThan(0);
      return;
    }

    // 本机实测有 dsh web 在跑（3080 / 13080）。若这条断言失败，
    // 说明分类逻辑回归了，而不是"环境没起服务"—— 用 probedCount 佐证确实扫了。
    expect(result.probedCount).toBeGreaterThan(0);
    expect(result.instances.length).toBeGreaterThan(0);

    for (const inst of result.instances) {
      expect(inst.authority).toMatch(/^[\d.]+:\d+$/u);
      expect(['local', 'remote']).toContain(inst.kind);
      // 分类与状态码必须自洽
      if (inst.kind === 'local') expect(inst.status).toBe(200);
      else expect(inst.status).toBe(401);
    }
  }, 120_000);
});
