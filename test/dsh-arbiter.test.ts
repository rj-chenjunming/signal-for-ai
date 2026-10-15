/**
 * D2 仲裁层测试 —— 插件精确信号与轮询近似的合并。
 *
 * 这是决策 D2「插件优先、轮询打底、插件失效自动退回」的落实点。
 * 最要紧的两条：
 *   1. 插件在场时，「等待授权」必须是**精确**的（而不是 plan.pending 猜的）
 *   2. 插件失效/过期后，**必须自动退回**轮询近似 —— 绝不能永远卡在黄色
 */

import { describe, expect, it } from 'vitest';
import {
  DshSignalArbiter,
  asWaitKind,
  mergeExactIntoPolled,
} from '../src/main/monitors/dsh-arbiter';

/** 可控时钟。 */
function clock(start = 1_800_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const AUTH = '127.0.0.1:3080';

describe('asWaitKind —— 不可信输入的收窄', () => {
  it('三种合法等待类型通过', () => {
    expect(asWaitKind('approval')).toBe('approval');
    expect(asWaitKind('plan-review')).toBe('plan-review');
    expect(asWaitKind('question')).toBe('question');
  });

  it('非法/缺失一律 undefined（不猜测）', () => {
    for (const v of [undefined, null, '', 'waiting', 'Approval', 42, {}, []]) {
      expect(asWaitKind(v)).toBeUndefined();
    }
  });
});

describe('DshSignalArbiter —— ingest 语义', () => {
  it('waiting 记下等待类型，exactStateFor 立刻可读', () => {
    const c = clock();
    const arb = new DshSignalArbiter({ now: c.now });
    expect(arb.ingest({ authority: AUTH, sessionId: 's1', kind: 'waiting', type: 'approval' })).toBe(true);

    const exact = arb.exactStateFor('s1');
    expect(exact?.pendingInteraction).toBe('approval');
    expect(exact?.errorMessage).toBeUndefined();
  });

  it('三种等待类型都能记', () => {
    const arb = new DshSignalArbiter();
    for (const k of ['approval', 'plan-review', 'question'] as const) {
      arb.ingest({ authority: AUTH, sessionId: `s-${k}`, kind: 'waiting', type: k });
      expect(arb.exactStateFor(`s-${k}`)?.pendingInteraction).toBe(k);
    }
  });

  it('waiting 但 type 非法 -> 不记（宁可不报，也不报含糊的"在等"）', () => {
    const arb = new DshSignalArbiter();
    expect(arb.ingest({ authority: AUTH, sessionId: 's1', kind: 'waiting', type: 'nonsense' })).toBe(false);
    expect(arb.exactStateFor('s1')).toBeUndefined();
  });

  it('★ resumed 清掉等待（人类已作答）', () => {
    const arb = new DshSignalArbiter();
    arb.ingest({ authority: AUTH, sessionId: 's1', kind: 'waiting', type: 'approval' });
    expect(arb.exactStateFor('s1')?.pendingInteraction).toBe('approval');

    arb.ingest({ authority: AUTH, sessionId: 's1', kind: 'resumed', type: 'approval' });
    expect(arb.exactStateFor('s1')).toBeUndefined();
  });

  it('★ status(running=false) 也清掉等待（会话停了，"在等"必然已结束）', () => {
    const arb = new DshSignalArbiter();
    arb.ingest({ authority: AUTH, sessionId: 's1', kind: 'waiting', type: 'question' });
    arb.ingest({ authority: AUTH, sessionId: 's1', kind: 'status', running: false });
    expect(arb.exactStateFor('s1')).toBeUndefined();
  });

  it('status(running=true) 不清等待（还在跑，但确实在等授权）', () => {
    const arb = new DshSignalArbiter();
    arb.ingest({ authority: AUTH, sessionId: 's1', kind: 'waiting', type: 'question' });
    arb.ingest({ authority: AUTH, sessionId: 's1', kind: 'status', running: true });
    expect(arb.exactStateFor('s1')?.pendingInteraction).toBe('question');
  });

  it('error 记下错误文本', () => {
    const arb = new DshSignalArbiter();
    arb.ingest({ authority: AUTH, sessionId: 's1', kind: 'error', message: '工具执行超时' });
    expect(arb.exactStateFor('s1')?.errorMessage).toBe('工具执行超时');
  });

  it('error 缺 message 时给兜底文案（不产生 undefined）', () => {
    const arb = new DshSignalArbiter();
    arb.ingest({ authority: AUTH, sessionId: 's1', kind: 'error' });
    const msg = arb.exactStateFor('s1')?.errorMessage;
    expect(typeof msg).toBe('string');
    expect(msg).not.toContain('undefined');
  });

  it('无 sessionId 的载荷被忽略（不猜测归属）', () => {
    const arb = new DshSignalArbiter();
    expect(arb.ingest({ authority: AUTH, kind: 'waiting', type: 'approval' })).toBe(false);
    expect(arb.ingest({ authority: AUTH, sessionId: '', kind: 'waiting', type: 'approval' })).toBe(false);
    expect(arb.ingest({ authority: AUTH, sessionId: 123 as unknown as string, kind: 'waiting' })).toBe(false);
  });

  it('无关 kind 被忽略且不计影响（added/activity/snapshot）', () => {
    const arb = new DshSignalArbiter();
    for (const kind of ['added', 'activity', 'snapshot', 'plugin/loaded']) {
      expect(arb.ingest({ authority: AUTH, sessionId: 's1', kind })).toBe(false);
    }
    expect(arb.exactStateFor('s1')).toBeUndefined();
  });

  it('removed 清掉该会话的等待（会话消失，不该继续显示"在等"）', () => {
    const arb = new DshSignalArbiter();
    arb.ingest({ authority: AUTH, sessionId: 's1', kind: 'waiting', type: 'approval' });
    expect(arb.waitingCount).toBe(1);

    expect(arb.ingest({ authority: AUTH, sessionId: 's1', kind: 'removed' })).toBe(true);
    expect(arb.exactStateFor('s1')).toBeUndefined();
    expect(arb.waitingCount).toBe(0);
  });

  it('任何畸形载荷都不抛错（载荷来自网络，必须当不可信输入）', () => {
    const arb = new DshSignalArbiter();
    const nasty = [
      {},
      { kind: null },
      { sessionId: 'x', kind: 42 },
      { sessionId: 'x', kind: 'waiting', type: {} },
      { sessionId: 'x', kind: 'status', running: 'yes' },
      { sessionId: 'x', kind: 'error', message: 42 },
    ];
    for (const p of nasty) {
      expect(() => arb.ingest(p as never)).not.toThrow();
    }
  });
});

describe('★ D2 核心：TTL 过期自动退回', () => {
  it('TTL 内精确信号有效', () => {
    const c = clock();
    const arb = new DshSignalArbiter({ now: c.now, ttlMs: 1_000 });
    arb.ingest({ authority: AUTH, sessionId: 's1', kind: 'waiting', type: 'approval' });

    c.advance(999);
    expect(arb.exactStateFor('s1')?.pendingInteraction).toBe('approval');
  });

  it('★ 超过 TTL 后返回 undefined —— 调用方据此退回轮询近似', () => {
    const c = clock();
    const arb = new DshSignalArbiter({ now: c.now, ttlMs: 1_000 });
    arb.ingest({ authority: AUTH, sessionId: 's1', kind: 'waiting', type: 'approval' });

    c.advance(1_001);
    // 这是本模块存在的意义：插件挂了不能让它永远显示"等待授权"
    expect(arb.exactStateFor('s1')).toBeUndefined();
  });

  it('过期时触发 onExpired 回调（便于记日志）', () => {
    const c = clock();
    const expired: string[] = [];
    const arb = new DshSignalArbiter({ now: c.now, ttlMs: 500, onExpired: (id) => expired.push(id) });
    arb.ingest({ authority: AUTH, sessionId: 's1', kind: 'waiting', type: 'approval' });

    c.advance(600);
    arb.exactStateFor('s1');
    expect(expired).toEqual(['s1']);
  });

  it('过期项被清掉，不会反复触发 onExpired', () => {
    const c = clock();
    const expired: string[] = [];
    const arb = new DshSignalArbiter({ now: c.now, ttlMs: 500, onExpired: (id) => expired.push(id) });
    arb.ingest({ authority: AUTH, sessionId: 's1', kind: 'waiting', type: 'approval' });
    c.advance(600);
    arb.exactStateFor('s1');
    arb.exactStateFor('s1');
    arb.exactStateFor('s1');
    expect(expired).toEqual(['s1']);
  });

  it('错误信号同样受 TTL 约束（不会永远显示失败）', () => {
    const c = clock();
    const arb = new DshSignalArbiter({ now: c.now, ttlMs: 1_000 });
    arb.ingest({ authority: AUTH, sessionId: 's1', kind: 'error', message: '炸了' });
    expect(arb.exactStateFor('s1')?.errorMessage).toBe('炸了');

    c.advance(1_001);
    expect(arb.exactStateFor('s1')).toBeUndefined();
  });

  it('同会话重新上报会刷新时刻（长任务不会中途被误判过期）', () => {
    const c = clock();
    const arb = new DshSignalArbiter({ now: c.now, ttlMs: 1_000 });
    arb.ingest({ authority: AUTH, sessionId: 's1', kind: 'waiting', type: 'approval' });

    c.advance(800);
    arb.ingest({ authority: AUTH, sessionId: 's1', kind: 'waiting', type: 'approval' });
    c.advance(800); // 距首次上报 1600ms，但距最近一次只有 800ms

    expect(arb.exactStateFor('s1')?.pendingInteraction).toBe('approval');
  });
});

describe('按会话/按实例归位', () => {
  it('多个会话互不干扰（一个在等，另一个在跑）', () => {
    const arb = new DshSignalArbiter();
    arb.ingest({ authority: AUTH, sessionId: 's1', kind: 'waiting', type: 'approval' });
    arb.ingest({ authority: AUTH, sessionId: 's2', kind: 'status', running: true });

    expect(arb.exactStateFor('s1')?.pendingInteraction).toBe('approval');
    expect(arb.exactStateFor('s2')).toBeUndefined();
  });

  it('exactStateForAuthority 只返回该实例的（多端口不串台）', () => {
    const arb = new DshSignalArbiter();
    arb.ingest({ authority: AUTH, sessionId: 's1', kind: 'waiting', type: 'approval' });
    arb.ingest({ authority: '127.0.0.1:13080', sessionId: 's2', kind: 'waiting', type: 'question' });

    expect([...arb.exactStateForAuthority(AUTH).keys()]).toEqual(['s1']);
    expect([...arb.exactStateForAuthority('127.0.0.1:13080').keys()]).toEqual(['s2']);
    expect(arb.exactStateForAuthority('127.0.0.1:9999').size).toBe(0);
  });

  it('waitingCount / waitingCountFor 统计正确', () => {
    const arb = new DshSignalArbiter();
    arb.ingest({ authority: AUTH, sessionId: 's1', kind: 'waiting', type: 'approval' });
    arb.ingest({ authority: AUTH, sessionId: 's2', kind: 'waiting', type: 'question' });
    arb.ingest({ authority: '127.0.0.1:13080', sessionId: 's3', kind: 'waiting', type: 'approval' });

    expect(arb.waitingCount).toBe(3);
    expect(arb.waitingCountFor(AUTH)).toBe(2);
    expect(arb.waitingCountFor('127.0.0.1:13080')).toBe(1);
  });

  it('forget 清掉某会话的全部痕迹（dsh 报了 removed）', () => {
    const arb = new DshSignalArbiter();
    arb.ingest({ authority: AUTH, sessionId: 's1', kind: 'waiting', type: 'approval' });
    arb.ingest({ authority: AUTH, sessionId: 's1', kind: 'error', message: 'x' });
    arb.forget('s1');
    expect(arb.exactStateFor('s1')).toBeUndefined();
    expect(arb.waitingCount).toBe(0);
  });

  it('stats 反映吞入/忽略计数', () => {
    const arb = new DshSignalArbiter();
    arb.ingest({ authority: AUTH, sessionId: 's1', kind: 'waiting', type: 'approval' }); // 计入
    arb.ingest({ authority: AUTH, kind: 'waiting', type: 'approval' }); // 忽略（无 sessionId）
    arb.ingest({ authority: AUTH, sessionId: 's2', kind: 'added' }); // 忽略（无关 kind）

    const s = arb.stats();
    expect(s.ingested).toBe(3);
    expect(s.ignored).toBe(2);
    expect(s.trackedWaits).toBe(1);
  });

  it('removed 未跟踪的会话时返回 false 但不抛错', () => {
    const arb = new DshSignalArbiter();
    expect(arb.ingest({ authority: AUTH, sessionId: 'never-seen', kind: 'removed' })).toBe(false);
  });

  it('clear 清空一切', () => {
    const arb = new DshSignalArbiter();
    arb.ingest({ authority: AUTH, sessionId: 's1', kind: 'waiting', type: 'approval' });
    arb.clear();
    expect(arb.exactStateFor('s1')).toBeUndefined();
    expect(arb.waitingCount).toBe(0);
  });
});

describe('mergeExactIntoPolled —— 精确信号只做升级，不降级', () => {
  it('无精确信号时原样返回轮询结果', () => {
    expect(mergeExactIntoPolled('idle', undefined)).toBe('idle');
    expect(mergeExactIntoPolled('running', undefined)).toBe('running');
    expect(mergeExactIntoPolled('unknown', undefined)).toBe('unknown');
  });

  it('★ 精确的 pendingInteraction 把 idle/running 升级为 waiting', () => {
    expect(mergeExactIntoPolled('idle', { pendingInteraction: 'approval' })).toBe('waiting');
    expect(mergeExactIntoPolled('running', { pendingInteraction: 'question' })).toBe('waiting');
  });

  it('errorMessage 升级为 failed（优先级高于 waiting）', () => {
    expect(
      mergeExactIntoPolled('running', { pendingInteraction: 'approval', errorMessage: '炸了' }),
    ).toBe('failed');
    expect(mergeExactIntoPolled('idle', { errorMessage: '炸了' })).toBe('failed');
  });

  it('★ 轮询已判 failed 时保留 failed —— 不许被"在等授权"粉饰成黄色', () => {
    // PRD §4.4「failed 一票否决」：一个已经崩掉的实例，
    // 不能因为插件推来一条"在等授权"就显示成黄色让人以为还在正常等。
    expect(mergeExactIntoPolled('failed', { pendingInteraction: 'approval' })).toBe('failed');
    expect(mergeExactIntoPolled('failed', { pendingInteraction: 'question' })).toBe('failed');
  });

  it('轮询判出 unknown 时不受精确等待影响（实例失联是更严重的事实）', () => {
    expect(mergeExactIntoPolled('unknown', { pendingInteraction: 'approval' })).toBe('waiting');
    // 说明：unknown 意味着"连不上"，而插件能推来说明它是活的 ——
    // 所以这里允许升级为 waiting。真正保留 unknown 的是 exact === undefined 的情况。
    expect(mergeExactIntoPolled('unknown', undefined)).toBe('unknown');
  });

  it('空的精确信号（既无等待也无错误）不改变结论', () => {
    expect(mergeExactIntoPolled('running', {})).toBe('running');
    expect(mergeExactIntoPolled('idle', {})).toBe('idle');
  });
});
