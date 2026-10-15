/**
 * 真实环境端到端：用**真配置 + 真 MonitorHost + 真 TaskStore**
 * 去监控**真正在跑的 dsh**（authority 自动发现，不写死端口）。
 *
 * 这是"能不能用"的最终证据 —— 之前的测试都用假服务器，
 * 这里必须打通真实链路：读 ~/.dsh/.credentials.yaml → 自签 cookie →
 * 真的 POST /api/session/list → 解析真会话 → 聚合 → 写进 store。
 *
 * 用法（项目根目录，先 build）：
 *   node node_modules/typescript/bin/tsc -p tsconfig.json
 *   node scripts/live-dsh-check.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findLiveDshAuthority } from './lib/live-dsh.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const require = createRequire(import.meta.url);

const YAML = require('yaml');
const { validateConfig } = require(resolve(root, 'dist/main/config.js'));
const { TaskStore } = require(resolve(root, 'dist/main/store.js'));
const { MonitorHost } = require(resolve(root, 'dist/main/monitors/host.js'));

// ---------------------------------------------------------------------------
// authority 用**自动发现**，不写死端口 —— dsh 换过端口（本机 3080 -> 19387），
// 写死会让这条链误报失败，制造假警报。
// ---------------------------------------------------------------------------
const DISCOVERED = await findLiveDshAuthority(root);
if (DISCOVERED === null) {
  console.error('❌ 找不到任何可用的本机 dsh 实例（本检查需要真实 dsh 在跑）');
  console.error('   请先启动 dsh（桌面客户端或 dsh web），或检查 config.dsh.example.yaml');
  process.exit(2); // 2 = 前置条件不满足（与"验证失败"区分）
}
console.log(`（自动发现活跃 dsh：${DISCOVERED.authority}，${DISCOVERED.sessions} 会话）\n`);

const CONFIG_TEXT = `
app:
  pollIntervalMs: 3000
tasks:
  - id: dsh-live
    name: dsh（自动发现）
    enabled: true
    monitor:
      type: dsh
      authority: "${DISCOVERED.authority}"
      intervalMs: 1500
      timeoutMs: 8000
`;

const outcome = validateConfig(YAML.parse(CONFIG_TEXT));
if (outcome.warnings.length > 0) {
  console.log('配置警告：');
  for (const w of outcome.warnings) console.log(`  - ${w}`);
}
const config = outcome.config;

// ---------------------------------------------------------------------------
// 日志：把关键信息透出来
// ---------------------------------------------------------------------------
const logLines = [];
const logger = {
  debug: () => undefined,
  info: (m, ...a) => logLines.push(`[info] ${m} ${a.map(String).join(' ')}`),
  warn: (m, ...a) => logLines.push(`[warn] ${m} ${a.map(String).join(' ')}`),
  error: (m, ...a) => logLines.push(`[error] ${m} ${a.map(String).join(' ')}`),
  logError: (m, e) => logLines.push(`[error] ${m} ${e instanceof Error ? e.message : String(e)}`),
};

// ---------------------------------------------------------------------------
// 真 store + 真 host
// ---------------------------------------------------------------------------
const store = new TaskStore(config.tasks, { logger });
const host = new MonitorHost({ store, config, logger });

console.log(`启动 MonitorHost，监控 ${config.tasks.length} 个任务...\n`);
await host.start();

// 等状态从初始态推进到有信号（最多 20s）
const deadline = Date.now() + 20_000;
let snapshot = store.getSnapshot();
let lastStatus;

while (Date.now() < deadline) {
  snapshot = store.getSnapshot();
  const t = snapshot.tasks.find((x) => x.taskId === 'dsh-live');
  lastStatus = t?.status;
  if (lastStatus !== undefined && lastStatus !== 'idle') break;
  await new Promise((r) => setTimeout(r, 400));
}

await host.stopAll();

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
console.log('=== 日志 ===');
for (const l of logLines) console.log(`  ${l}`);

console.log('\n=== store 快照 ===');
for (const t of snapshot.tasks) {
  console.log(`  ${t.taskId.padEnd(12)} status=${String(t.status).padEnd(8)} message=${t.message ?? ''}`);
}

const task = snapshot.tasks.find((x) => x.taskId === 'dsh-live');

const checks = [];
const check = (name, cond, detail = '') => {
  checks.push({ name, cond, detail });
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`);
};

console.log('\n=== 断言 ===');
check('任务存在于 store', task !== undefined);
check(
  '读到了真实状态（合法七态之一）',
  task?.status !== undefined &&
    ['idle', 'starting', 'running', 'waiting', 'success', 'failed', 'unknown'].includes(task.status),
  `status=${String(task?.status)}`,
);
// ⚠️ 这里**不能**断言"非 idle"。
// 曾经那么断言过，而它能通过**只是因为一个 bug**：
// 静默判定排在 running 判定之后，导致会话一旦被标 running 就永远不转 idle，
// 于是灯永远是蓝的（用户反馈的"执行完了还显示运行中"）。
// 修好之后，没有活跃会话时正确答案就是 idle。
// 现在改为断言"真的拿到了会话数与 authority"——那才是"读到了 dsh"的证据。
check(
  'message 里带上了会话数（证明真的解析了 session/list）',
  typeof task?.message === 'string' && /会话/u.test(task.message),
  String(task?.message ?? ''),
);
check(
  'message 里带上了 authority（证明是我们的适配器写的）',
  typeof task?.message === 'string' && task.message.includes(DISCOVERED.authority),
  String(task?.message),
);
check('聚合态是合法七态之一', ['idle', 'starting', 'running', 'waiting', 'success', 'failed', 'unknown'].includes(String(task?.status)));

const failed = checks.filter((c) => !c.cond);
console.log(`\n${failed.length === 0 ? '✅ 真实 dsh 端到端打通' : `❌ ${failed.length} 项失败`}`);
process.exit(failed.length === 0 ? 0 : 1);
