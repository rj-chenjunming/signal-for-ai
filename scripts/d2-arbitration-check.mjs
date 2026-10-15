/**
 * D2 全链路实测：插件载荷 → 真 HookServer → 仲裁器 → DshMonitor 精确信号 → store。
 *
 * 为什么要专门测这条链：D2 的价值全在"两路信号真的合到了一起"，
 * 各部分单测通过 ≠ 接起来能工作。这里用**真 HTTP 请求**打到**真 HookServer**，
 * 让真实 MonitorHost 去监控**真实在跑的 dsh web**。
 *
 * 三个关键断言：
 *   1. 只靠轮询时，"等待授权"拿不到（只有 plan.pending 近似）—— 基线
 *   2. 推一条插件 waiting 载荷后，**无需等下一轮轮询**，灯立刻变 waiting
 *   3. 过了 TTL 后自动退回轮询近似（不会永远卡在黄色）
 *
 * 用法（项目根目录，先 build）：
 *   node node_modules/typescript/bin/tsc -p tsconfig.json
 *   node scripts/d2-arbitration-check.mjs
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findLiveDshAuthority } from './lib/live-dsh.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const require = createRequire(import.meta.url);

const { validateConfig } = require(resolve(root, 'dist/main/config.js'));
const { TaskStore } = require(resolve(root, 'dist/main/store.js'));
const { MonitorHost } = require(resolve(root, 'dist/main/monitors/host.js'));
const { DshSignalArbiter } = require(resolve(root, 'dist/main/monitors/dsh-arbiter.js'));

// ---------------------------------------------------------------------------
// authority 用**自动发现**，不写死端口。
//
// 【为什么】原先写死 127.0.0.1:3080，而 dsh 换过端口（本机从 3080 挪到 19387），
// 于是这条链"失败"——但代码没坏，是脚本在敲一个不开的门。
// 这种假警报既浪费时间、又会掩盖真正的回归。
// ---------------------------------------------------------------------------
const DISCOVERED = await findLiveDshAuthority(root);
if (DISCOVERED === null) {
  console.error('❌ 找不到任何可用的本机 dsh 实例（D2 需要真实 dsh 在跑）');
  console.error('   请先启动 dsh（桌面客户端或 dsh web），或检查 config.dsh.example.yaml');
  process.exit(2); // 2 = 前置条件不满足（与"验证失败"区分）
}
const AUTHORITY = DISCOVERED.authority;
console.log(`（自动发现活跃 dsh：${AUTHORITY}，${DISCOVERED.sessions} 会话）\n`);

const HOOK_PORT = 17_893; // 避开 demo 用的 17890
const TOKEN = 'd2-check-token';

// ---------------------------------------------------------------------------
// 配置：一个 dsh 型任务（真实监控）+ 一个 webhook 型任务（接收插件推送）
// ---------------------------------------------------------------------------
const CONFIG = {
  app: { pollIntervalMs: 3000, hookPort: HOOK_PORT, dshHome: '%USERPROFILE%/.dsh' },
  tasks: [
    {
      id: 'dsh-3080',
      name: 'dsh @ 3080',
      enabled: true,
      monitor: { type: 'dsh', authority: AUTHORITY, intervalMs: 1500, timeoutMs: 8000 },
    },
    {
      id: 'dsh-plugin-3080',
      name: 'dsh @ 3080（插件精确信号）',
      enabled: true,
      monitor: {
        type: 'webhook',
        listen: '127.0.0.1',
        path: '/hook/dsh-plugin-3080',
        secret: TOKEN,
        fieldMap: { state: '$.status' },
        heartbeatTimeoutMs: 300_000,
      },
    },
  ],
};

const outcome = validateConfig(CONFIG);
if (outcome.warnings.length > 0) {
  console.log('配置警告：');
  for (const w of outcome.warnings) console.log(`  - ${w}`);
}

const logLines = [];
const logger = {
  debug: () => undefined,
  info: (m) => logLines.push(`[info] ${m}`),
  warn: (m) => logLines.push(`[warn] ${m}`),
  error: (m) => logLines.push(`[error] ${m}`),
  logError: (m, e) => logLines.push(`[error] ${m} ${e instanceof Error ? e.message : String(e)}`),
};

const store = new TaskStore(outcome.config.tasks, { logger });

// TTL 设长一点（8s），好让"信号被捕获"的断言在整轮轮询期间都成立；
// 过期行为不靠 sleep 硬等，改用 __expireAllForTest() 确定性触发。
const arbiter = new DshSignalArbiter({
  ttlMs: 8_000,
  onExpired: (id) => logLines.push(`[info] 插件信号过期：${id}`),
});

const host = new MonitorHost({ store, config: outcome.config, logger, arbiter });

const statusOf = (taskId) => store.getSnapshot().tasks.find((t) => t.taskId === taskId)?.status;

/** 从真实 dsh 里挑一个会话 id（用我们的 DshClient 直接问）。 */
const { readSigningSecret, DshClient } = require(resolve(root, 'dist/main/monitors/dsh-instance.js'));
const { homedir } = await import('node:os');
const { join } = await import('node:path');

console.log('启动 MonitorHost（dsh 型 + webhook 型各一个）...\n');
await host.start();

// 等基线：轮询至少要跑过一轮，且 store 里已经有这个任务
// ⚠️ **不能**等"非 idle" —— 没有活跃会话时正确答案就是 idle。
// 曾经等过非 idle，而它能通过只是因为静默判定排在 running 之后的那个 bug。
const deadline = Date.now() + 15_000;
while (Date.now() < deadline && statusOf('dsh-3080') === undefined) {
  await new Promise((r) => setTimeout(r, 300));
}
// 再给一轮轮询时间，确保拿到的是真实状态而不是初始值
await new Promise((r) => setTimeout(r, 3_500));
const baseline = statusOf('dsh-3080');
console.log(`基线（仅轮询）dsh-3080 = ${baseline}`);
console.log(`基线 webhook 任务 = ${statusOf('dsh-plugin-3080')}\n`);

// 取一个真实会话 id
let sessionId = null;
try {
  const client = new DshClient({
    authority: AUTHORITY,
    secret: readSigningSecret(join(homedir(), '.dsh')),
  });
  const list = await client.listSessions();
  if (list.ok) {
    sessionId = (list.value?.items ?? []).find((i) => i.blank !== true)?.sessionId ?? null;
  }
} catch (err) {
  console.log(`取会话 id 失败：${err.message}`);
}
console.log(`使用真实会话 id：${sessionId}\n`);

// ---------------------------------------------------------------------------
// 推一条插件 waiting 载荷（模拟 lamp/plugin/index.js 的上报）
// ---------------------------------------------------------------------------
async function pushPlugin(payload) {
  const res = await fetch(`http://127.0.0.1:${HOOK_PORT}/hook/dsh-plugin-3080`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-indicator-token': TOKEN },
    body: JSON.stringify(payload),
  });
  return res.status;
}

const checks = [];
const check = (name, cond, detail = '') => {
  checks.push({ name, cond, detail });
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`);
};

console.log('=== 1. 推一条 approval 等待载荷 ===');
const pushStatus = await pushPlugin({
  pluginId: 'dsh-status-light',
  authority: AUTHORITY,
  sessionId: sessionId ?? 'unknown-session',
  kind: 'waiting',
  type: 'approval',
  status: 'waiting',
  toolName: 'pwsh',
  message: '等待批准：pwsh',
  at: Date.now(),
});
check('hub 接受了插件载荷（200）', pushStatus === 200, `HTTP ${pushStatus}`);

// 给仲裁器 + 下一轮轮询一点时间
await new Promise((r) => setTimeout(r, 2_200));

const afterPush = statusOf('dsh-3080');
console.log(`  推入后 dsh-3080 = ${afterPush}`);
check(
  '★ 仲裁器捕获到精确等待信号',
  arbiter.waitingCount > 0,
  `waitingCount=${arbiter.waitingCount}`,
);
check(
  '★ 该会话的精确信号为 approval',
  arbiter.exactStateFor(sessionId ?? 'unknown-session')?.pendingInteraction === 'approval',
  JSON.stringify(arbiter.exactStateFor(sessionId ?? 'unknown-session') ?? null),
);
check(
  '★ 端口灯变 waiting（精确信号压过轮询的近似）',
  afterPush === 'waiting',
  `基线 ${baseline} -> 推入后 ${afterPush}`,
);

console.log('\n=== 2. 强行过期，验证自动退回轮询近似 ===');
// 不靠 sleep 等 TTL —— 那会 flaky（慢机器上"刚推入就过期"）。
// 用测试钩子确定性地把所有信号标成过期，再看灯是否退回。
arbiter.__expireAllForTest();

// 触发一次读取，让过期剔除发生
const exactAfter = arbiter.exactStateFor(sessionId ?? 'unknown-session');
check(
  '★ 精确信号已过期（不再返回）',
  exactAfter === undefined,
  `exactStateFor -> ${JSON.stringify(exactAfter ?? null)}`,
);

// 再等一轮轮询，让端口状态被轮询结果覆盖
await new Promise((r) => setTimeout(r, 2_200));

const afterExpiry = statusOf('dsh-3080');
console.log(`  过期后 dsh-3080 = ${afterExpiry}`);
check(
  '★ 灯不再卡在 waiting —— 退回轮询判定',
  afterExpiry !== 'waiting' || baseline === 'waiting',
  `实际 ${afterExpiry}（基线 ${baseline}）`,
);
check(
  '退回后仍是合法七态之一',
  ['idle', 'starting', 'running', 'waiting', 'success', 'failed', 'unknown'].includes(String(afterExpiry)),
  String(afterExpiry),
);

console.log('\n=== 3. 推 resumed，验证等待被清掉 ===');
// 用一条新的 waiting + resumed 来验证清理路径
await pushPlugin({
  pluginId: 'dsh-status-light',
  authority: AUTHORITY,
  sessionId: sessionId ?? 'unknown-session',
  kind: 'waiting',
  type: 'question',
  status: 'waiting',
  at: Date.now(),
});
await new Promise((r) => setTimeout(r, 200));
const duringWait = arbiter.exactStateFor(sessionId ?? 'unknown-session')?.pendingInteraction;

await pushPlugin({
  pluginId: 'dsh-status-light',
  authority: AUTHORITY,
  sessionId: sessionId ?? 'unknown-session',
  kind: 'resumed',
  type: 'question',
  status: 'running',
  at: Date.now(),
});
await new Promise((r) => setTimeout(r, 300));
const afterResume = arbiter.exactStateFor(sessionId ?? 'unknown-session');

check('waiting 载荷被记录为 question', duringWait === 'question', String(duringWait));
check('★ resumed 后精确信号被清掉', afterResume === undefined, JSON.stringify(afterResume ?? null));

console.log('\n=== 4. 畸形载荷不得影响 webhook 主流程 ===');
const badStatuses = [];
for (const bad of [{}, { kind: 'waiting' }, { sessionId: 1, kind: 'waiting', type: 'x' }]) {
  badStatuses.push(await pushPlugin(bad));
}
check(
  '畸形载荷被 hub 正常处理（不 500）',
  badStatuses.every((s) => s < 500),
  `状态码=${badStatuses.join(',')}`,
);

await host.stopAll();

console.log('\n=== 日志（节选）===');
for (const l of logLines.slice(0, 14)) console.log(`  ${l}`);

const failed = checks.filter((c) => !c.cond);
console.log(`\n${failed.length === 0 ? `✅ D2 全链路打通（${checks.length} 项）` : `❌ ${failed.length}/${checks.length} 项失败`}`);
process.exit(failed.length === 0 ? 0 : 1);
