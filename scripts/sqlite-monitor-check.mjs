/**
 * 全链路验证 `sqlite` 型监控：用真实的 buildQueryScript + 系统 node
 * 去查真实的 workbuddy.db，再用真实的 deriveSqliteVerdict 判定。
 *
 * 为什么必须跑真的：SQL 是字符串里拼出来的，只看类型检查完全不能证明它
 * 在真库上能跑（列名拼错、SQLite 函数用错都会在运行时才炸）。
 *
 * 用法（先 build）：
 *   node node_modules/typescript/bin/tsc -p tsconfig.json
 *   node scripts/sqlite-monitor-check.mjs [db 路径]
 *
 * 库路径来源（优先级）：命令行参数 > 环境变量 LAMP_WORKBUDDY_DB >
 * 本地私有配置 config.local.yaml（gitignored）> 占位符默认值。
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import { localValues } from './lib/local-config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const require = createRequire(import.meta.url);

const { buildQueryScript, deriveSqliteVerdict, resolveSystemNode } = require(
  resolve(root, 'dist/main/monitors/sqlite.js'),
);

// 真实库路径只在本地私有配置里；仓库里是占位符（避免泄露本机目录结构）。
const DB =
  process.argv[2] ?? localValues().workbuddyDb ?? 'D:/your-appdata/.workbuddy/workbuddy.db';
const checks = [];
const check = (name, cond, detail = '') => {
  checks.push({ name, cond, detail });
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`);
};

console.log('=== 1. 前提检查 ===');
check('workbuddy.db 存在', existsSync(DB), DB);
const nodeBin = resolveSystemNode();
check('找到了系统 node', typeof nodeBin === 'string' && nodeBin.length > 0, nodeBin);

console.log('\n=== 2. 用真实脚本查询真库 ===');
const script = buildQueryScript(DB, 'working', 120_000);
console.log(`  脚本长度 ${script.length} 字符`);

const { execFileSync } = await import('node:child_process');
let raw;
try {
  raw = execFileSync(nodeBin, ['--no-warnings', '-e', script], {
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  });
  check('查询成功返回', true, raw.trim().slice(0, 120));
} catch (err) {
  check('查询成功返回', false, err.message);
  console.log('\n❌ 查询失败，后续断言跳过');
  process.exit(1);
}

let row;
try {
  row = JSON.parse(raw.trim());
  check('输出是合法 JSON', true);
} catch {
  check('输出是合法 JSON', false, raw.slice(0, 200));
  process.exit(1);
}

console.log(`\n  解析结果: ${JSON.stringify(row)}`);
check('含全部五个字段', ['activeCount', 'freshActiveCount', 'lastDoneAt', 'totalCount', 'lastActivityAt'].every((k) => k in row));
check('totalCount 是正数（确实读到了 sessions 表）', Number(row.totalCount) > 0, `totalCount=${row.totalCount}`);
check(
  'activeCount ≥ freshActiveCount（新鲜的是活跃的子集）',
  Number(row.activeCount) >= Number(row.freshActiveCount),
  `active=${row.activeCount} fresh=${row.freshActiveCount}`,
);
check(
  'lastDoneAt 是有效数字（完成档能正常工作）',
  Number.isFinite(Number(row.lastDoneAt)),
  `lastDone=${row.lastDoneAt}`,
);

console.log('\n=== 2b. ★ 确认水位：点掉之后同一个完成不再亮绿灯（真库数据）===');
{
  // 用真库读到的 lastDoneAt 当水位，演示闸门行为
  const done = Number(row.lastDoneAt);
  if (done > 0) {
    const fresh = deriveSqliteVerdict({ ...row, freshActiveCount: 0 }, true, 0);
    const acked = deriveSqliteVerdict({ ...row, freshActiveCount: 0 }, true, done);
    const newer = deriveSqliteVerdict({ ...row, freshActiveCount: 0 }, true, done - 1);

    console.log(`  真库最近完成时刻 = ${done}（${new Date(done).toISOString()}）`);
    console.log(`  未确认      -> ${fresh.status}`);
    console.log(`  已确认同一完成 -> ${acked.status}`);
    console.log(`  确认水位更早   -> ${newer.status}`);

    check('★ 未确认的完成 -> success（绿）', fresh.status === 'success', fresh.status);
    check('★★ 已确认同一完成 -> idle（绿灯不复亮）', acked.status === 'idle', acked.status);
    check('★ 有更新的完成 -> 再次 success', newer.status === 'success', newer.status);
    check('★ success 带 completionAt（闸门靠它）', fresh.completionAt === done, String(fresh.completionAt));
  } else {
    console.log('  （真库当前没有已完成会话，跳过该组断言）');
  }
}

// running 优先级：有新鲜活跃时不该被完成档抢走
{
  const v = deriveSqliteVerdict(
    { ...row, freshActiveCount: 1, lastDoneAt: Date.now() },
    true,
    0,
  );
  check('★ running 优先于 success（刚跑完又开新任务应显示蓝）', v.status === 'running', `实际 ${v.status}`);
}

console.log('\n=== 3. 判定逻辑（喂真实数据）===');
const cases = [
  { label: '进程不在', row: { ...row }, alive: false },
  { label: '进程在 + 真实数据', row: { ...row }, alive: true },
  {
    label: '进程在 + 有新鲜活跃会话',
    row: { ...row, activeCount: 2, freshActiveCount: 2, lastDoneAt: 0, lastActivityAt: Date.now() },
    alive: true,
  },
  {
    label: '进程在 + 刚完成（完成提醒）',
    row: { ...row, activeCount: 0, freshActiveCount: 0, lastDoneAt: 1 },
    alive: true,
  },
  {
    label: '进程在 + 只有陈旧 working（实测的遗留场景）',
    row: { ...row, activeCount: 2, freshActiveCount: 0, lastDoneAt: 0, lastActivityAt: Date.now() - 72_000_000 },
    alive: true,
  },
  {
    label: '进程在 + 完全没有活跃会话',
    row: { ...row, activeCount: 0, freshActiveCount: 0, lastDoneAt: 0, lastActivityAt: 0 },
    alive: true,
  },
  { label: '未配闸门（undefined）', row: { activeCount: 0, freshActiveCount: 0, lastDoneAt: 0, totalCount: 1, lastActivityAt: 0 }, alive: undefined },
];

let bad = 0;
for (const c of cases) {
  const v = deriveSqliteVerdict(c.row, c.alive);
  console.log(`  ${c.label}:`);
  console.log(`     -> status=${v.status} hidden=${v.hidden}  "${v.message}"`);
  if (c.alive === false && (v.hidden !== true || v.status !== 'idle')) {
    console.log('     ❌ 进程不在时应当 hidden');
    bad += 1;
  }
  if (c.alive !== false && v.hidden === true) {
    console.log('     ❌ 不该 hidden');
    bad += 1;
  }
}
check('四种语义分支都符合预期（运行/完成/空闲/隐藏）', bad === 0, bad === 0 ? '' : `${bad} 处分歧`);

console.log('\n=== 4. 关键：陈旧 working 不能被判成 running ===');
const stale = deriveSqliteVerdict(
  { activeCount: 2, freshActiveCount: 0, totalCount: 56, lastActivityAt: Date.now() - 72_000_000 },
  true,
);
check(
  '★ 有陈旧 working 记录但无新鲜活动 -> idle（不是 running）',
  stale.status === 'idle',
  `实际 ${stale.status}`,
);
check(
  '并说明"状态陈旧"，而不是假装没这回事',
  /陈旧/u.test(stale.message),
  stale.message,
);

console.log(`\n${checks.every((c) => c.cond) ? `✅ sqlite 监控全链路通过（${checks.length} 项）` : '❌ 有失败项'}`);
process.exit(checks.every((c) => c.cond) ? 0 : 1);
