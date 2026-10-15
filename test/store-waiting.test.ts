/**
 * 状态机边缘场景回归测试。
 *
 * 这批用例针对 QA 与我在修复过程中确认的真实缺陷：
 *  1. `waiting -> success` 缺失会让灯永久卡在黄色（见下方 describe 说明）；
 *  2. 同一状态重复上报需要去重，否则日志高频输出会刷爆通知；
 *  3. `idle/unknown -> waiting` 缺失会让**推送型监控的精确信号被丢弃**，
 *     灯永远不变黄（见下方 describe 说明）。
 *
 * 与 store.test.ts 的区别：那份验证「转移表本身」，这份验证
 * **监控器真实上报的序列**能否被状态机正确承接。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALLOWED_TRANSITIONS, TaskStore, canTransition } from '../src/main/store';
import type { LogRule, TaskConfig, TaskStatus } from '../src/shared/types';

/* ============================================================================
 * idle / unknown -> waiting：推送型监控的精确信号不能被丢弃
 * ==========================================================================*/

describe('★ idle/unknown -> waiting（"卡住等你授权"能显示出来的前提）', () => {
  const task = (): TaskConfig => ({
    id: 'dsh-1',
    name: 'dsh @ 3080',
    enabled: true,
    monitor: { type: 'dsh', authority: '127.0.0.1:3080' },
  });

  it('转移表允许 idle -> waiting', () => {
    expect(ALLOWED_TRANSITIONS.idle).toContain('waiting');
    expect(canTransition('idle', 'waiting')).toBe(true);
  });

  it('★ 刻意**不**放开 unknown -> waiting（与 idle 的区别）', () => {
    // idle = "没在干活"（安全）  vs  unknown = "看不见它了"（可能已崩）。
    // 失联期间实例可能早就挂了，若允许它直接转 waiting，就会显示
    // "明明挂了却卡在等你授权" —— 比停在灰色更危险（漏报失败）。
    // 失联实例必须先被观察到真实运行信号（-> running）才可能进入 waiting。
    // 这条约束由 store.test.ts / store-extra.test.ts 守着，这里再钉一次。
    expect(ALLOWED_TRANSITIONS.unknown).not.toContain('waiting');
    expect(canTransition('unknown', 'waiting')).toBe(false);
  });

  it('unknown 仍可恢复到 running/failed/idle/starting（心跳回来即恢复）', () => {
    for (const to of ['running', 'failed', 'idle', 'starting'] as const) {
      expect(canTransition('unknown', to)).toBe(true);
    }
  });

  it('★ 回归：idle 的任务收到 waiting 信号，apply 必须被接受', () => {
    // 这是实测抓到的缺陷。dsh 型/插件型任务在收到信号前一直是 idle，
    // 当插件推来「会话正在等授权」时，**前一个状态就是 idle**
    // （不会有 starting/running —— 那是轮询/日志型的路径）。
    //
    // 若转移表拒绝 idle -> waiting，apply 返回 null，于是：
    //   仲裁器记到了信号 ✓   per-session 判成 waiting ✓   apply 被拒 ✗
    //   -> 灯停在灰色，用户**永远看不到"卡住等你授权"**
    // 即本产品最值钱的功能被静默打掉。
    const store = new TaskStore([task()]);
    expect(store.getSnapshot().tasks[0]!.status).toBe('idle'); // 起始就是 idle

    const change = store.apply('dsh-1', {
      status: 'waiting',
      message: '等待批准：pwsh',
      isSignal: true,
    });

    expect(change).not.toBeNull(); // 关键：不能被拒绝
    expect(store.getSnapshot().tasks[0]!.status).toBe('waiting');
    expect(store.getSnapshot().aggregate).toBe('waiting');
  });

  it('不变量：没有引入 unknown -> success 或 failed -> success', () => {
    // PRD §4.2 的两条硬不变量必须保持
    expect(canTransition('unknown', 'success')).toBe(false);
    expect(canTransition('failed', 'success')).toBe(false);
    expect(ALLOWED_TRANSITIONS.failed).not.toContain('success');
    expect(ALLOWED_TRANSITIONS.unknown).not.toContain('success');
  });

  it('★ idle -> success 允许（sqlite 型「完成提醒」的前提）', () => {
    // 【为什么从 false 改成 true】
    // 原先禁止它的理由是"没干活就变绿"。但那条保证**改由信号源本身承担**：
    // sqlite 型只在一个会话的 status 变成非 working **且** updated_at 新鲜时
    // 才上报 success —— 即数据库确认"确实有任务刚跑完"。
    // 一个从没跑过的任务，结构上不可能让 SQL 算出 recentlyDoneCount > 0。
    //
    // 而 sqlite 型在两次任务之间**一直上报 idle**，所以"刚完成"那一刻的
    // 前一个状态必然是 idle。这条边若不开，apply 会返回 null，
    // 完成提醒的绿灯根本不亮 —— 用户看到的正是
    // 「执行完了任务直接变灰，失去了提醒效果」。
    //
    // ⚠️ 注意「允许这条边」≠「会自动变绿」：它只由监控的**真实完成信号**
    //    驱动（带 isSignal），store 自身不会凭空走到 success。
    expect(canTransition('idle', 'success')).toBe(true);
  });
});

/* ============================================================================
 * waiting -> success：灯卡死缺陷的回归防护
 * ==========================================================================*/

describe('waiting -> success（QA 裁决补充的转移）', () => {
  it('转移表允许 waiting -> success', () => {
    expect(ALLOWED_TRANSITIONS.waiting).toContain('success');
  });

  it('当前态 waiting + 判定为 success：apply 被接受，灯变绿', () => {
    // 复现缺陷的最小场景：log 型监控器每轮只上报 judgeStatusBatch 的
    // 单个结果。当一轮日志里授权提示与完成信号同时出现时，batch 按
    // 「最后一条命中」返回 success —— 中间不会有 running。
    // 若转移表拒绝 waiting->success，apply 返回 null，灯永久停在黄色。
    const store = new TaskStore([
      { id: 't1', name: 'T1', enabled: true, monitor: { type: 'webhook', listen: '127.0.0.1', path: '/hook/t1' } },
    ]);
    store.apply('t1', { status: 'running', isSignal: true });
    store.apply('t1', { status: 'waiting', isSignal: true });
    expect(store.getSnapshot().tasks[0]!.status).toBe('waiting');

    const change = store.apply('t1', { status: 'success', isSignal: true });
    expect(change).not.toBeNull(); // 关键：不能被拒绝
    expect(store.getSnapshot().tasks[0]!.status).toBe('success');
    expect(store.getSnapshot().aggregate).toBe('success');
  });

  it('不影响 waiting -> running 常规路径（授权通过后继续执行）', () => {
    const store = new TaskStore([
      { id: 't1', name: 'T1', enabled: true, monitor: { type: 'webhook', listen: '127.0.0.1', path: '/hook/t1' } },
    ]);
    store.apply('t1', { status: 'running', isSignal: true });
    store.apply('t1', { status: 'waiting', isSignal: true });
    store.apply('t1', { status: 'running', isSignal: true });
    expect(store.getSnapshot().tasks[0]!.status).toBe('running');
  });

  it('waiting -> failed 仍被允许（授权悬挂也是失败）', () => {
    expect(canTransition('waiting', 'failed')).toBe(true);
  });

  it('反向约束：unknown -> success 必须仍为 false', () => {
    // 失联任务不能凭空变绿。这是防止「假绿灯」的核心不变量，
    // 放开 waiting->success 时绝不能顺带把它放开。
    expect(canTransition('unknown', 'success')).toBe(false);
  });

  it('★ idle -> success 允许，但同样只由真实完成信号驱动', () => {
    // 详见上方「idle -> success 允许」那条的说明。
    // 这里保留的约束是"不自动变绿"：转移表放开这条边，
    // 不代表 store 会自己走到 success —— 必须有监控上报的完成信号。
    expect(canTransition('idle', 'success')).toBe(true);
  });
});

/* ============================================================================
 * LogMonitor 端到端：真实文件 + 真实轮询，验证上报序列
 * ==========================================================================*/

const RULES: LogRule[] = [
  { state: 'failed', match: '(error|fatal)' },
  { state: 'waiting', match: '(permission request|waiting for input)' },
  { state: 'success', match: '(task complete|done)' },
  { state: 'running', match: '(running|step [0-9]+)' },
];

describe('LogMonitor 端到端状态上报', () => {
  let dir: string;
  let logFile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ati-logmon-'));
    logFile = path.join(dir, 'run.log');
    fs.writeFileSync(logFile, '', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * 驱动一次 LogMonitor 轮询：起monitor → 追加日志 → 等一轮 tick → 停。
   * 用真实文件与真实 glob/tail，不 mock 文件系统。
   *
   * 契约依据 base.ts 的 MonitorContext：监控器只通过 `sink(taskId, ev)`
   * 上报，框架侧负责写 store。这里我们直接接管 sink 来观察事件序列。
   */
  async function pollOnce(lines: readonly string[]): Promise<TaskStatus[]> {
    // 动态 import 以避免与 electron 相关的模块副作用
    const { LogMonitor } = await import('../src/main/monitors/logfile');
    const { compileRules } = await import('../src/main/monitors/pattern');

    const task: TaskConfig = {
      id: 't1',
      name: 'T1',
      enabled: true,
      monitor: {
        type: 'log',
        paths: [logFile],
        rules: RULES,
        idleAfterSilenceMs: 999_999,
        staleTimeoutMs: 999_999,
      },
    };

    const emitted: TaskStatus[] = [];
    const monitor = new LogMonitor(
      {
        task,
        // 只收 status 事件；heartbeat 不改变灯色，不纳入断言
        sink: (_id, ev) => {
          if (ev.kind === 'status') {
            emitted.push(ev.status);
          }
        },
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
          logError: () => {},
        },
        rules: compileRules(RULES),
        timeouts: {
          startTimeoutMs: 999_999,
          staleTimeoutMs: 999_999,
          waitingTimeoutMs: 999_999,
        },
      },
      // 只覆盖轮询间隔，其余走 LogMonitor 自己的默认值。
      // 这里刻意不用 `as never` —— 那样会让整个 ctx 逃出类型检查，
      // 写错字段名（如误传 onState）编译期也不报错，正是它一开始掩盖的问题。
      { pollIntervalMs: 20 },
    );

    await monitor.start();
    // 首次轮询只建立游标（不把历史内容当信号）
    await new Promise((r) => setTimeout(r, 80));
    emitted.length = 0;

    if (lines.length > 0) {
      fs.appendFileSync(logFile, lines.join('\n') + '\n', 'utf8');
      await new Promise((r) => setTimeout(r, 120));
    }
    await monitor.stop();
    return emitted;
  }

  it('「授权提示 + 完成」同批次时能推进到 success，不会卡在 waiting', async () => {
    // 这是本次修复的核心保障：整段日志只上报一个状态（success），
    // 状态机必须接得住，否则灯停在黄色不动。
    const emitted = await pollOnce(['permission request: allow edit?', 'task complete']);
    expect(emitted).toContain('success');
    expect(emitted).not.toContain('failed');
  });

  it('同一状态重复上报会被去重（failed 不刷屏）', async () => {
    // 配合 failed 立即定案的语义，一轮内多个失败只报第一个。
    // 若不去重，日志高频输出 error 会不断触发通知。
    const emitted = await pollOnce(['error: disk full', 'error: again', 'error: still']);
    const failedCount = emitted.filter((s) => s === 'failed').length;
    expect(failedCount).toBeLessThanOrEqual(1);
  });

  it('纯授权提示判定为 waiting', async () => {
    const emitted = await pollOnce(['permission request: allow edit?']);
    expect(emitted).toContain('waiting');
  });

  it('有新增内容但无规则命中视为 running（日志在动就是活着）', async () => {
    const emitted = await pollOnce(['some neutral output line']);
    expect(emitted).toContain('running');
  });

  it('stop() 幂等：重复调用不抛异常', async () => {
    const { LogMonitor } = await import('../src/main/monitors/logfile');
    const { compileRules } = await import('../src/main/monitors/pattern');
    const task: TaskConfig = {
      id: 't1',
      name: 'T1',
      enabled: true,
      monitor: { type: 'log', paths: [logFile], rules: RULES },
    };
    const monitor = new LogMonitor({
      task,
      sink: () => {},
      logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
          logError: () => {},
        },
      rules: compileRules(RULES),
      timeouts: {
        startTimeoutMs: 999_999,
        staleTimeoutMs: 999_999,
        waitingTimeoutMs: 999_999,
      },
    });
    await monitor.start();
    await expect(monitor.stop()).resolves.toBeUndefined();
    await expect(monitor.stop()).resolves.toBeUndefined();
  });
});
/* ============================================================================
 * 失败后重试（实测踩到的灯卡死缺陷）
 * ==========================================================================*/

describe('failed 之后可以重试（灯卡死缺陷的回归防护）', () => {
  function newStore() {
    return new TaskStore([
      { id: 'r', name: 'R', enabled: true, monitor: { type: 'log', paths: ['a.log'], rules: [] } },
    ]);
  }

  it('running -> failed -> running 被接受（重试后灯应变蓝）', () => {
    // 曾经的 bug：failed 只允许转 idle/starting，导致
    // 「任务崩溃 → 用户重试 → 日志又输出 running」时灯卡在红色，
    // 必须等 10 分钟 dismiss 清理才恢复。
    const store = newStore();
    store.apply('r', { status: 'running', isSignal: true });
    store.apply('r', { status: 'failed', isSignal: true });
    expect(store.getSnapshot().tasks[0]!.status).toBe('failed');

    const change = store.apply('r', { status: 'running', isSignal: true });
    expect(change).not.toBeNull();
    expect(store.getSnapshot().tasks[0]!.status).toBe('running');
    expect(store.getSnapshot().aggregate).toBe('running');
  });

  it('反复「失败→重试→再失败」都能正常流转', () => {
    const store = newStore();
    const seq: TaskStatus[] = ['running', 'failed', 'running', 'failed', 'running'];
    for (const st of seq) {
      store.apply('r', { status: st, isSignal: true });
    }
    expect(store.getSnapshot().tasks[0]!.status).toBe('running');
  });

  it('failed -> waiting 也允许（重试后又卡在授权提示）', () => {
    expect(canTransition('failed', 'waiting')).toBe(true);
  });

  it('关键不变量：failed -> success 仍必须禁止（不能凭空显示完成）', () => {
    // 放宽「失败后重试」不能连带破坏「红灯不被洗绿」：
    // 失败的任务不允许自己变成成功。
    expect(canTransition('failed', 'success')).toBe(false);
  });

  it('关键不变量：unknown -> success 仍必须禁止（失联任务不得凭空变绿）', () => {
    expect(canTransition('unknown', 'success')).toBe(false);
  });
});
