/**
 * D11 通知策略测试。
 *
 * 设计决策 D11：
 *   - **只通知三个关键态**：waiting（等你授权）/ failed / success
 *   - **文案带端口**：多端口下必须一眼看出是哪个实例
 *   - 沿用 30s 同任务去重（显示 ×N），去重键 = `<实例id>:<状态>`
 *
 * 通知文案的实现在 notify-content.ts（**不依赖 electron**），可直接单测。
 * `Notification` 本身依赖 electron，本文件不碰它。
 */

import { describe, expect, it } from 'vitest';
import {
  statusTitle,
  buildNotificationContent,
  formatDuration,
} from '../src/main/notify-content';
import { DEFAULT_NOTIFY_STATES, DEFAULT_NOTIFY_SETTINGS } from '../src/shared/constants';
import { parseConfigText } from '../src/main/config';

// ---------------------------------------------------------------------------
describe('statusTitle —— 七态都有可读文案', () => {
  it('三个关键态文案明确', () => {
    expect(statusTitle('waiting')).toContain('等待授权');
    expect(statusTitle('failed')).toContain('失败');
    expect(statusTitle('success')).toContain('已完成');
  });

  it('其余四态也有文案（不落到 undefined）', () => {
    for (const s of ['idle', 'starting', 'running', 'unknown'] as const) {
      expect(typeof statusTitle(s)).toBe('string');
      expect(statusTitle(s).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
describe('buildNotificationContent —— D11 核心：文案带端口', () => {
  const base = { name: 'dsh @ 3080', status: 'waiting' as const };

  it('★ 带 portLabel 时端口出现在正文最前', () => {
    const { title, body } = buildNotificationContent({ ...base, portLabel: '3080' }, 1);
    expect(title).toContain('等待授权');
    expect(title).toContain('dsh @ 3080');
    // 端口必须在最前 —— 多端口下这是"哪个实例卡住了"的唯一线索
    expect(body.startsWith('端口 3080')).toBe(true);
  });

  it('不同端口产生不同正文（多端口可区分）', () => {
    const a = buildNotificationContent({ ...base, portLabel: '3080' }, 1);
    const b = buildNotificationContent({ ...base, portLabel: '13080' }, 1);
    expect(a.body).not.toBe(b.body);
    expect(a.body).toContain('3080');
    expect(b.body).toContain('13080');
  });

  it('没有 portLabel 时不写"端口"二字（避免出现「端口 undefined」）', () => {
    const { body } = buildNotificationContent({ ...base, portLabel: undefined }, 1);
    expect(body).not.toContain('端口');
    expect(body).not.toContain('undefined');
  });

  it('portLabel 为空串时同样不写', () => {
    const { body } = buildNotificationContent({ ...base, portLabel: '' }, 1);
    expect(body).not.toContain('端口');
  });

  it('正文顺序：端口 → 目录 → 耗时 → 消息', () => {
    const { body } = buildNotificationContent(
      {
        ...base,
        portLabel: '3080',
        cwd: 'D:\\your-project',
        durationMs: 65_000,
        message: '等待批准：pwsh',
      },
      1,
    );
    const idxPort = body.indexOf('端口 3080');
    const idxCwd = body.indexOf('D:\\your-project');
    const idxDur = body.indexOf('耗时');
    const idxMsg = body.indexOf('等待批准');
    expect(idxPort).toBeGreaterThanOrEqual(0);
    expect(idxPort).toBeLessThan(idxCwd);
    expect(idxCwd).toBeLessThan(idxDur);
    expect(idxDur).toBeLessThan(idxMsg);
  });

  it('count > 1 时追加 ×N（与 30s 去抖计数衔接）', () => {
    const once = buildNotificationContent({ ...base, portLabel: '3080' }, 1);
    const thrice = buildNotificationContent({ ...base, portLabel: '3080' }, 3);
    expect(once.body).not.toContain('×');
    expect(thrice.body).toContain('×3');
  });

  it('各字段缺失时正文仍可读（只有端口或空）', () => {
    expect(buildNotificationContent({ ...base, portLabel: '3080' }, 1).body).toBe('端口 3080');
    expect(buildNotificationContent(base, 1).body).toBe('');
  });

  it('durationMs 为 0 时不写耗时（0 不是有意义的信息）', () => {
    const { body } = buildNotificationContent({ ...base, durationMs: 0 }, 1);
    expect(body).not.toContain('耗时');
  });
});

// ---------------------------------------------------------------------------
describe('formatDuration', () => {
  it('不足 1 小时用 mm:ss', () => {
    expect(formatDuration(0)).toBe('00:00');
    expect(formatDuration(5_000)).toBe('00:05');
    expect(formatDuration(65_000)).toBe('01:05');
    expect(formatDuration(3_599_000)).toBe('59:59');
  });

  it('超过 1 小时用 h:mm:ss', () => {
    expect(formatDuration(3_600_000)).toBe('1:00:00');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
  });

  it('负数按 0 处理（防脏数据渲染出 -1:-1）', () => {
    expect(formatDuration(-5_000)).toBe('00:00');
  });
});

// ---------------------------------------------------------------------------
describe('D11 白名单默认值 —— 只通知三个关键态', () => {
  it('DEFAULT_NOTIFY_STATES 恰好是 waiting/success/failed', () => {
    expect([...DEFAULT_NOTIFY_STATES].sort()).toEqual(['failed', 'success', 'waiting']);
  });

  it('高频态不在默认白名单里（这是多端口不刷屏的关键）', () => {
    for (const s of ['running', 'starting', 'idle'] as const) {
      expect(DEFAULT_NOTIFY_STATES).not.toContain(s);
    }
  });

  it('DEFAULT_NOTIFY_SETTINGS 引用的就是那份白名单', () => {
    expect([...DEFAULT_NOTIFY_SETTINGS.notifyStates].sort()).toEqual([
      'failed',
      'success',
      'waiting',
    ]);
  });

  it('users 配了非法值时回落到默认三态', () => {
    const outcome = parseConfigText('notify:\n  notifyStates: ["oops", "nope"]\ntasks: []\n');
    expect([...outcome.config.notify.notifyStates].sort()).toEqual([
      'failed',
      'success',
      'waiting',
    ]);
  });

  it('用户可以显式加上高频态（配置比默认优先，不锁死）', () => {
    const outcome = parseConfigText(
      'notify:\n  notifyStates: ["running", "failed"]\ntasks: []\n',
    );
    expect(outcome.config.notify.notifyStates).toContain('running');
    expect(outcome.config.notify.notifyStates).toContain('failed');
  });

  it('去抖间隔默认 30s（D11 沿用旧项目语义）', () => {
    expect(DEFAULT_NOTIFY_SETTINGS.debounceMs).toBe(30_000);
  });
});
