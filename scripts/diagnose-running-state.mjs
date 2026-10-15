/**
 * 诊断：为什么"执行完了还显示运行中"？
 *
 * 直接问 dsh 要 session/list 的原始投影字段，逐个会话看
 * running / plan.pending / subagentCatalog / updatedAt，
 * 以及我们的 deriveFromListItem 会把它判成什么。
 *
 * 这样才能分清是「dsh 真的还认为在跑」还是「我们的判定有偏差」。
 *
 * 用法：node scripts/diagnose-running-state.mjs [authority]
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const require = createRequire(import.meta.url);

const { readSigningSecret, DshClient, deriveFromListItem } = require(
  resolve(root, 'dist/main/monitors/dsh-instance.js'),
);

const authority = process.argv[2] ?? '127.0.0.1:3080';
const now = Date.now();

const client = new DshClient({
  authority,
  secret: readSigningSecret(join(homedir(), '.dsh')),
  timeoutMs: 10_000,
});

console.log(`=== 查询 ${authority} 的 session/list ===\n`);
const res = await client.listSessions();
if (!res.ok) {
  console.error(`查询失败：${JSON.stringify(res.error)}`);
  process.exit(1);
}

const items = (res.value?.items ?? []).filter((i) => i.blank !== true);
console.log(`共 ${items.length} 个非空白会话\n`);

const byStatus = {};
const rows = [];
for (const it of items) {
  const v = it.projections?.values;
  const unsettled = (v?.subagentCatalog ?? []).filter((s) => s.settledAt === undefined).length;
  const derived = deriveFromListItem(it, now, { allowPlanPendingHeuristic: true });
  byStatus[derived] = (byStatus[derived] ?? 0) + 1;

  const ageMs = typeof it.updatedAt === 'number' ? now - it.updatedAt : undefined;
  rows.push({
    id: String(it.sessionId ?? '').slice(0, 16),
    running: it.running,
    agentAvailable: it.agentAvailable,
    planPending: v?.plan?.pending,
    subagents: unsettled,
    ageSec: ageMs === undefined ? '?' : Math.round(ageMs / 1000),
    derived,
  });
}

console.log('sessionId         running  agentAvail  plan.pending  未结算子代理   静默(s)   判定');
for (const r of rows) {
  console.log(
    `${r.id.padEnd(17)} ${String(r.running).padEnd(8)} ${String(r.agentAvailable).padEnd(11)} ` +
      `${String(r.planPending).padEnd(13)} ${String(r.subagents).padEnd(13)} ` +
      `${String(r.ageSec).padEnd(9)} ${r.derived}`,
  );
}

console.log('\n=== 判定分布 ===');
for (const [k, n] of Object.entries(byStatus)) console.log(`  ${k.padEnd(9)} ${n}`);

const runningOnes = rows.filter((r) => r.derived === 'running');
console.log(`\n=== 被判为 running 的会话（共 ${runningOnes.length} 个）===`);
for (const r of runningOnes) {
  console.log(
    `  ${r.id}  running=${r.running} agentAvailable=${r.agentAvailable} ` +
      `未结算子代理=${r.subagents} 静默=${r.ageSec}s`,
  );
  if (r.subagents > 0) {
    console.log('     ^ 原因：有未结算(resolved 缺失 settledAt)的子代理');
  } else if (r.running === true) {
    console.log('     ^ 原因：dsh 自报 running=true');
  }
}

console.log('\n=== 参考：判定阈值 ===');
const { DEFAULT_STATE_TIMEOUT } = require(resolve(root, 'dist/shared/constants.js'));
console.log(`  DEFAULT_STATE_TIMEOUT = ${JSON.stringify(DEFAULT_STATE_TIMEOUT)}`);
