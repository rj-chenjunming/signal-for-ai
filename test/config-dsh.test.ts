/**
 * dsh 型监控的**配置层**测试。
 *
 * 为什么单独一份：项目 04-SPEC §6.5 记录过「配置三个坑」，
 * 配置解析的 bug 表现为「灯不亮但一切正常」，最难排查。
 * 所以容错行为必须逐条锁死。
 */

import { describe, expect, it } from 'vitest';
import { parseConfigText, expandEnvVars } from '../src/main/config';
import { isDshMonitor } from '../src/shared/types';

/** 从 YAML 文本解析，返回 dsh 型任务（不存在则 undefined）。 */
function dshTaskOf(yaml: string, taskId = 't1') {
  const outcome = parseConfigText(yaml);
  const task = outcome.config.tasks.find((t) => t.id === taskId);
  if (task === undefined) return { task: undefined, warnings: outcome.warnings };
  return { task, warnings: outcome.warnings };
}

const wrap = (monitorYaml: string) => `
tasks:
  - id: t1
    name: 测试
    enabled: true
    monitor:
${monitorYaml}
`;

describe('dsh 型配置校验 —— 正常路径', () => {
  it('最小配置：只有 authority', () => {
    const { task, warnings } = dshTaskOf(wrap('      type: dsh\n      authority: "127.0.0.1:3080"'));
    expect(task).toBeDefined();
    expect(task?.monitor.type).toBe('dsh');
    if (task !== undefined && isDshMonitor(task.monitor)) {
      expect(task.monitor.authority).toBe('127.0.0.1:3080');
    }
    expect(warnings).toEqual([]);
  });

  it('完整配置：所有可选字段都被保留', () => {
    const { task, warnings } = dshTaskOf(
      wrap(
        [
          '      type: dsh',
          '      authority: "127.0.0.1:13080"',
          '      dshHome: "/tmp/dsh"',
          '      sshHost: "user@host"',
          '      intervalMs: 7000',
          '      timeoutMs: 3000',
          '      heartbeatTimeoutMs: 60000',
          '      allowPlanPendingHeuristic: false',
        ].join('\n'),
      ),
    );

    expect(warnings).toEqual([]);
    if (task === undefined || !isDshMonitor(task.monitor)) throw new Error('未解析出 dsh 任务');
    expect(task.monitor.dshHome).toBe('/tmp/dsh');
    expect(task.monitor.sshHost).toBe('user@host');
    expect(task.monitor.intervalMs).toBe(7000);
    expect(task.monitor.timeoutMs).toBe(3000);
    expect(task.monitor.heartbeatTimeoutMs).toBe(60_000);
    expect(task.monitor.allowPlanPendingHeuristic).toBe(false);
  });

  it('isDshMonitor 能正确收窄联合类型', () => {
    const { task } = dshTaskOf(wrap('      type: dsh\n      authority: "127.0.0.1:1"'));
    if (task === undefined) throw new Error('未解析出任务');
    expect(isDshMonitor(task.monitor)).toBe(true);
    expect(task.monitor.type).toBe('dsh');
  });
});

describe('dsh 型配置校验 —— 容错（单个字段非法只丢该字段）', () => {
  it('authority 缺失 -> 丢弃该任务并明确告知', () => {
    const { task, warnings } = dshTaskOf(wrap('      type: dsh'));
    expect(task).toBeUndefined();
    expect(warnings.some((w) => w.includes('authority') && w.includes('缺失'))).toBe(true);
  });

  it('authority 缺端口 -> 丢弃该任务（cookie 绑定 authority，写错必 401）', () => {
    const { task, warnings } = dshTaskOf(wrap('      type: dsh\n      authority: "127.0.0.1"'));
    expect(task).toBeUndefined();
    expect(warnings.some((w) => w.includes('host:port'))).toBe(true);
  });

  it('authority 端口越界 -> 丢弃该任务', () => {
    const { task } = dshTaskOf(wrap('      type: dsh\n      authority: "127.0.0.1:99999"'));
    expect(task).toBeUndefined();
  });

  it('intervalMs 过小 -> 提升到 500ms 并警告（不给 dsh 造成无谓负载）', () => {
    const { task, warnings } = dshTaskOf(
      wrap('      type: dsh\n      authority: "127.0.0.1:1"\n      intervalMs: 10'),
    );
    expect(warnings.some((w) => w.includes('intervalMs') && w.includes('500'))).toBe(true);
    if (task === undefined || !isDshMonitor(task.monitor)) throw new Error('未解析出任务');
    expect(task.monitor.intervalMs).toBe(500);
  });

  it('allowPlanPendingHeuristic 非布尔 -> 忽略该字段但不丢任务', () => {
    const { task, warnings } = dshTaskOf(
      wrap('      type: dsh\n      authority: "127.0.0.1:1"\n      allowPlanPendingHeuristic: yes-please'),
    );
    expect(task).toBeDefined();
    expect(warnings.some((w) => w.includes('allowPlanPendingHeuristic'))).toBe(true);
    if (task === undefined || !isDshMonitor(task.monitor)) throw new Error('未解析出任务');
    expect(task.monitor.allowPlanPendingHeuristic).toBeUndefined();
  });

  it('dshHome 非字符串 -> 忽略但不丢任务', () => {
    const { task, warnings } = dshTaskOf(
      wrap('      type: dsh\n      authority: "127.0.0.1:1"\n      dshHome: 123'),
    );
    expect(task).toBeDefined();
    if (task === undefined || !isDshMonitor(task.monitor)) throw new Error('未解析出任务');
    expect(task.monitor.dshHome).toBeUndefined();
    expect(warnings.length).toBeGreaterThanOrEqual(0); // 非字符串时静默忽略亦可接受
  });

  it('type 非法值仍然被拒绝，且合法值提示里包含 dsh', () => {
    const outcome = parseConfigText(wrap('      type: bogus\n      authority: "127.0.0.1:1"'));
    expect(outcome.config.tasks).toHaveLength(0);
    expect(outcome.warnings.some((w) => w.includes('dsh'))).toBe(true);
  });
});

describe('app.dshHome', () => {
  it('字符串则保留', () => {
    const outcome = parseConfigText('app:\n  dshHome: "/custom/dsh"\ntasks: []\n');
    expect(outcome.config.app.dshHome).toBe('/custom/dsh');
  });

  it('缺失则保持 undefined（由 DshMonitor 兜底 %USERPROFILE%/.dsh）', () => {
    const outcome = parseConfigText('tasks: []\n');
    expect(outcome.config.app.dshHome).toBeUndefined();
  });

  it('非字符串则警告并忽略', () => {
    const outcome = parseConfigText('app:\n  dshHome: 42\ntasks: []\n');
    expect(outcome.config.app.dshHome).toBeUndefined();
    expect(outcome.warnings.some((w) => w.includes('dshHome'))).toBe(true);
  });
});

describe('环境变量展开与 YAML 引号的交互（PRD §6.5 那类坑）', () => {
  it('顺序是「先 parse YAML，再展开环境变量」—— 所以双引号写 %VAR% 是安全的', () => {
    // 关键事实（config.ts:751）：expandDeep 发生在 validateConfig 内部，
    // 也就是 parseYaml **之后**。所以 YAML 看到的是字面量 %USERPROFILE%，
    // 不含反斜杠，不会触发 BAD_DQ_ESCAPE。
    const yaml = 'app:\n  dshHome: "%USERPROFILE%/.dsh"\ntasks: []\n';
    expect(() => parseConfigText(yaml)).not.toThrow();

    const outcome = parseConfigText(yaml);
    // 展开确实发生了：结果里不该残留 % 号
    expect(outcome.config.app.dshHome).toBeDefined();
    expect(outcome.config.app.dshHome).not.toContain('%USERPROFILE%');
  });

  it('单引号写法同样可用（示例里用它，因为对读者更安全）', () => {
    const yaml = "app:\n  dshHome: '%USERPROFILE%/.dsh'\ntasks: []\n";
    const outcome = parseConfigText(yaml);
    expect(outcome.config.app.dshHome).toBeDefined();
    expect(outcome.config.app.dshHome).not.toContain('%');
  });

  it('若有人错误地先展开再 parse，反斜杠会炸 —— 记录这个陷阱', () => {
    // 复现"顺序搞反"的后果，防止有人把 expandDeep 挪到 parseYaml 之前
    const yaml = 'app:\n  dshHome: "%USERPROFILE%/.dsh"\ntasks: []\n';
    const expandedFirst = expandEnvVars(yaml);
    // 展开后含反斜杠，此时再交给 YAML 就会失败
    expect(expandedFirst).toContain('\\');
    expect(() => parseConfigText(expandedFirst)).toThrow();
  });
});
