/**
 * 日志规则引擎测试。
 *
 * 这是 log 型监控的核心：把日志文本判定为任务状态。
 * 判定结果直接决定灯的颜色，判错就是「任务挂了但灯是绿的」这类严重问题，
 * 因此 failed 优先级、非法正则容错都要覆盖。
 */
import { describe, expect, it } from 'vitest';
import {
  Debouncer,
  compileRules,
  isWaitingEcho,
  judgeStatus,
  judgeStatusBatch,
} from '../src/main/monitors/pattern';
import type { LogRule } from '../src/shared/types';

const RULES: LogRule[] = [
  { state: 'failed', match: '(error|fatal|exception|\\bE[0-9]{4}\\b)' },
  { state: 'waiting', match: '(permission request|waiting for input)' },
  { state: 'success', match: '(task complete|done|完成)' },
  { state: 'running', match: '(running|executing|step [0-9]+)' },
];

describe('compileRules', () => {
  it('编译合法规则后 empty 为 false', () => {
    const compiled = compileRules(RULES);
    expect(compiled.empty).toBe(false);
    expect(compiled.rules.length).toBe(4);
    expect(compiled.errors).toHaveLength(0);
  });

  it('默认使用 i 标志：正则不必写 (?i)（JS 不支持该前缀，会被当字面量）', () => {
    // 这是实测踩过的坑：JS 正则里 "(?i)" 不是标志语法，会被编译成
    // 匹配字面量 "(?i)" 的模式，导致所有规则静默失效。
    const compiled = compileRules([{ state: 'failed', match: 'error' }]);
    expect(judgeStatus('ERROR: boom', compiled)?.status).toBe('failed');
  });

  it('空规则列表标记为 empty，judgeStatus 直接返回 null', () => {
    const compiled = compileRules([]);
    expect(compiled.empty).toBe(true);
    expect(judgeStatus('anything', compiled)).toBeNull();
  });

  it('非法正则被跳过，不影响其余规则（单个坏配置不能拖垮整个监控）', () => {
    const compiled = compileRules([
      { state: 'failed', match: '(unclosed group' }, // 语法错误
      { state: 'running', match: 'running' },
    ]);
    expect(compiled.rules).toHaveLength(1);
    expect(compiled.errors.length).toBeGreaterThan(0);
    expect(judgeStatus('task is running now', compiled)?.status).toBe('running');
  });
});

describe('judgeStatus 状态判定', () => {
  const compiled = compileRules(RULES);

  it('识别错误为 failed', () => {
    expect(judgeStatus('ERROR: something broke', compiled)?.status).toBe('failed');
  });

  it('识别致命错误与错误码', () => {
    expect(judgeStatus('FATAL: cannot open file', compiled)?.status).toBe('failed');
    expect(judgeStatus('  E0433: failed to resolve', compiled)?.status).toBe('failed');
  });

  it('识别等待授权为 waiting（AI CLI 最常卡住的态）', () => {
    expect(judgeStatus('Permission request: allow edit?', compiled)?.status).toBe('waiting');
    expect(judgeStatus('waiting for input', compiled)?.status).toBe('waiting');
  });

  it('识别中文完成提示', () => {
    expect(judgeStatus('任务完成', compiled)?.status).toBe('success');
  });

  it('识别执行中为 running', () => {
    expect(judgeStatus('step 3 executing tool call', compiled)?.status).toBe('running');
  });

  it('无匹配返回 null（由调用方决定保持原状态）', () => {
    expect(judgeStatus('just some neutral output', compiled)).toBeNull();
    expect(judgeStatus('', compiled)).toBeNull();
  });

  it('failed 优先于其他状态：同段文本里有 error 与 running 时判 failed', () => {
    // 真实场景：一行日志里既有 "running" 又有 "error"，
    // 若按配置顺序命中 running，任务崩了灯还是绿的。
    const m = judgeStatus('running step 2 then error: E1234 boom', compiled);
    expect(m?.status).toBe('failed');
  });

  it('返回命中的文本片段供UI 展示', () => {
    const m = judgeStatus('ERROR: disk full', compiled);
    expect(m).not.toBeNull();
    expect(m?.sample.length).toBeGreaterThan(0);
  });
});

describe('judgeStatusBatch 批量判定', () => {
  const compiled = compileRules(RULES);

  it('对多行文本只取最高优先级结果', () => {
    const m = judgeStatusBatch(['running step 1', 'done', 'fatal crash'], compiled);
    expect(m?.status).toBe('failed');
  });

  it('全部无匹配时返回 null', () => {
    expect(judgeStatusBatch(['neutral a', 'neutral b'], compiled)).toBeNull();
  });
});

describe('isWaitingEcho 回声过滤', () => {
  const compiled = compileRules(RULES);

  it('识别「等待授权」提示的回声', () => {
    expect(isWaitingEcho('Permission request: allow edit?', compiled)).toBe(true);
  });

  it('普通日志不算等待回声', () => {
    expect(isWaitingEcho('running step 1', compiled)).toBe(false);
  });

  it('避免把上一次的等待提示反复重新上报（防止通知刷屏）', () => {
    // 同一条等待提示被读到多次时，第二次起应被识别为回声。
    expect(isWaitingEcho('Permission request: allow edit?', compiled)).toBe(true);
  });
});

describe('Debouncer 去抖（通知防刷屏，PRD P1-5）', () => {
  it('窗口内的重复触发被抑制，但累计次数照涨', () => {
    // count 就是通知里显示的「×N」，用户能知道"又失败了 3 次"，
    // 而不是以为只发生了一次。
    let now = 0;
    const d = new Debouncer(1000, () => now);
    expect(d.check('t1:failed').allowed).toBe(true);
    now = 500;
    const second = d.check('t1:failed');
    expect(second.allowed).toBe(false);
    expect(second.count).toBe(2);
    now = 1500;
    expect(d.check('t1:failed').allowed).toBe(true);
  });

  it('不同 key 各自独立计时', () => {
    let now = 0;
    const d = new Debouncer(1000, () => now);
    expect(d.check('a:failed').allowed).toBe(true);
    expect(d.check('b:failed').allowed).toBe(true);
    expect(d.size).toBe(2);
  });

  it('resetTask 清掉该任务全部去抖记录（任务回到 running 时调用）', () => {
    let now = 0;
    const d = new Debouncer(1000, () => now);
    d.check('t1:failed');
    d.check('t2:failed');
    expect(d.size).toBe(2);
    d.resetTask('t1');
    expect(d.size).toBe(1);
    expect(d.countOf('t1:failed')).toBe(0);
  });

  it('countOf 只读查询不改变状态', () => {
    const d = new Debouncer(1000);
    expect(d.countOf('nope')).toBe(0);
  });
});