/**
 * 规则引擎批量判定的补充测试（QA 补充）。
 *
 * 既有 pattern.test.ts 已覆盖单行判定与 failed 优先级，
 * 本文件专门钉住**多行混合场景**下批量判定的真实行为——
 * 这是既有测试的盲区：它只用「failed 在最后一行」验证过failed 优先。
 */
import { describe, expect, it } from 'vitest';

import { compileRules, judgeStatus, judgeStatusBatch } from '../src/main/monitors/pattern';
import type { LogRule } from '../src/shared/types';

const RULES: LogRule[] = [
  { state: 'failed', match: '(error|fatal|exception)' },
  { state: 'waiting', match: '(permission request|waiting for input)' },
  { state: 'success', match: '(task complete|done)' },
  { state: 'running', match: '(running|executing|step [0-9]+)' },
];

const compiled = compileRules(RULES);

describe('judgeStatusBatch 多行混合场景（PRD T11「failed 优先」）', () => {
  it('failed 在最后一行时判 failed（既有测试覆盖的场景）', () => {
    expect(judgeStatusBatch(['running step 1', 'done', 'fatal crash'], compiled)?.status).toBe('failed');
  });

  it('failed 在第一行、后面跟 running 时仍应判 failed', () => {
    // 真实日志形态：AI 工具先报错，之后还在刷「step N executing」的收尾输出。
    // 若这里判成 running，用户会看到蓝灯而错过真正的失败。
    expect(judgeStatusBatch(['fatal crash', 'running step 2'], compiled)?.status).toBe('failed');
  });

  it('failed 在中间行、后面跟 success 时仍应判 failed', () => {
    // 「报错后又打印 done」的日志很常见，必须以 failed 为准。
    expect(judgeStatusBatch(['error: boom', 'task complete'], compiled)?.status).toBe('failed');
  });

  it('多行里 failed 与 waiting 共存时判 failed', () => {
    expect(
      judgeStatusBatch(['permission request', 'exception raised', 'waiting for input'], compiled)?.status,
    ).toBe('failed');
  });

  it('无 failed 时取最后一条有效判定（越新的行代表当前状态）', () => {
    expect(judgeStatusBatch(['running step 1', 'done'], compiled)?.status).toBe('success');
  });

  it('最后一行无命中但前面有命中时，仍返回前面那条', () => {
    expect(judgeStatusBatch(['fatal crash', 'neutral output'], compiled)?.status).toBe('failed');
  });

  it('单行内与跨行的 failed 优先级应一致（同一段文本两种入口同结果）', () => {
    const lines = ['error: disk full', 'still running'];
    const batched = judgeStatusBatch(lines, compiled)?.status;
    const joined = judgeStatus(lines.join('\n'), compiled)?.status;
    expect(batched).toBe(joined);
  });

  it('空数组返回 null', () => {
    expect(judgeStatusBatch([], compiled)).toBeNull();
  });

  it('规则集为空时返回 null', () => {
    expect(judgeStatusBatch(['anything'], compileRules([]))).toBeNull();
  });
});

describe('judgeStatus 规则顺序无关性（failed 恒优先）', () => {
  it('即使 failed 规则写在最后，也必须压过前面的 running/success', () => {
    // 用户在 YAML 里把 failed 规则写在最后是常见写法，语义不能依赖书写顺序。
    const reordered = compileRules([
      { state: 'running', match: '(running|executing)' },
      { state: 'success', match: '(done|complete)' },
      { state: 'failed', match: '(error|fatal)' },
    ]);
    expect(judgeStatus('running and then error', reordered)?.status).toBe('failed');
    expect(judgeStatus('done but with fatal error', reordered)?.status).toBe('failed');
  });

  it('多个 failed 规则命中时取第一个（配置顺序）', () => {
    const multi = compileRules([
      { state: 'failed', match: 'error' },
      { state: 'failed', match: 'fatal' },
    ]);
    const m = judgeStatus('error and fatal', multi);
    expect(m?.rule.source).toBe('error');
  });

  it('sample 截断到 200 字符，避免超长日志污染面板', () => {
    const long = `error ${'x'.repeat(1000)}`;
    const m = judgeStatus(long, compiled);
    expect(m?.sample.length).toBeLessThanOrEqual(200);
  });
});

describe('compileRules 健壮性', () => {
  it('多条非法规则全部被跳过，errors 逐条记录', () => {
    const r = compileRules([
      { state: 'failed', match: '(unclosed' },
      { state: 'running', match: '[bad-class' },
      { state: 'success', match: 'ok' },
    ]);
    expect(r.rules).toHaveLength(1);
    expect(r.errors).toHaveLength(2);
    expect(r.empty).toBe(false);
  });

  it('match 为空字符串的规则被丢弃', () => {
    const r = compileRules([{ state: 'failed', match: '' }]);
    expect(r.empty).toBe(true);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('非法 state 不影响正则编译（state 由 config 层校验）', () => {
    const r = compileRules([{ state: 'nonsense' as never, match: 'foo' }]);
    expect(r.rules).toHaveLength(1);
  });

  it('大小写不敏感：ERROR/Error/error 等价', () => {
    const c = compileRules([{ state: 'failed', match: '^error' }]);
    for (const s of ['ERROR x', 'Error x', 'error x']) {
      expect(judgeStatus(s, c)?.status).toBe('failed');
    }
  });
});