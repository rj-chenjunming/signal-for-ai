/**
 * 把「决策台账 + 逐轮开发记录」从工作区根 `docs/` 同步进本仓库，并**自动脱敏**。
 *
 * ============================================================================
 * 【为什么需要这个脚本】
 * ============================================================================
 * 这些文档的**主编辑位置在仓库之外** —— 工作区根 `docs/`（因为 dsh 侧与灯应用
 * 共用一个工作区），而仓库里需要一份可发布的副本。手工拷贝 + 手工脱敏既啰嗦、
 * 又容易漏掉某处个人取值，所以固化成一条命令。
 *
 * ============================================================================
 * 【★ 这个脚本自身绝不包含任何真实取值】
 * ============================================================================
 * 这是本文件最容易被写错的地方：脱敏规则天然要写"把 X 换成 Y"，如果 X 直接
 * 写成字面量，那就等于**把要藏起来的东西原样写进了仓库**。
 * （第一版就是把真实主机名直接写在规则表里，靠一次提交前扫描才发现。）
 *
 * 所以规则是**推导**出来的，不是写死的：
 *   - 从 `config.local.yaml`（gitignored）取 sshHost / 数据库路径 / agent 工作目录；
 *   - 从 `os.homedir()` 取本机用户目录；
 *   - 需要额外项（例如组织 scope）时，放进 `scripts/sanitize-rules.local.json`
 *     （同样 gitignored）。
 *
 * ============================================================================
 * 【三道校验】
 * ============================================================================
 *   1. **台账编号完整性** —— 1..N 无缺号、无重复（台账的既有约定）；
 *   2. **残留扫描** —— 用**通用**模式（Windows 用户路径 / POSIX home / 私网 IP /
 *      凭据特征）兜"规则没覆盖到的新个人取值"；命中即非零退出；
 *   3. **差异报告** —— `--check` 下有差异即非零退出，可挂 CI。
 *
 * ============================================================================
 * 【用法】
 * ============================================================================
 *   node scripts/sync-docs.mjs              # 从默认源 ../docs 同步进仓库
 *   node scripts/sync-docs.mjs <源目录>      # 指定源目录
 *   node scripts/sync-docs.mjs --check      # 只检查是否已同步，不写任何文件
 *
 * 源目录不存在时**退出码 2**（前置不满足），与"校验失败（1）"区分 ——
 * clone 下来的人没有 `../docs` 是正常情况，不该看起来像脚本坏了。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { localValues } from './lib/local-config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');
const TARGET_DIR = join(REPO_ROOT, 'docs');
/** 默认源：工作区根 docs/（本仓库的上一级）。 */
const DEFAULT_SOURCE = resolve(REPO_ROOT, '..', 'docs');
/** 可选的额外规则（gitignored）：{ "replace": [["from","to"]], "scan": ["regex"] } */
const EXTRA_RULES_FILE = join(here, 'sanitize-rules.local.json');

/**
 * 推导脱敏规则 —— **真实取值只来自本机，不写死在本文件里**。
 *
 * 返回按"待替换串长度降序"排好，避免短规则先把长路径切碎
 * （例如"数据根目录"这条若先于"数据根目录下的库文件"生效，长路径就被切坏了）。
 */
function deriveRules() {
  const { sshHost, workbuddyDb, agentCwd } = localValues();
  const pairs = [];
  const add = (from, to) => {
    if (typeof from === 'string' && from.length >= 3) pairs.push([from, to]);
  };
  const bothSlashes = (p, to) => {
    add(p, to);
    add(p.replace(/\//g, '\\'), to.replace(/\//g, '\\'));
  };

  // ① agent 工作目录
  if (agentCwd) bothSlashes(agentCwd, 'D:/your-project');

  // ② WorkBuddy 数据目录：库文件本身 + 它的上级目录（覆盖 logs 等变体）
  if (workbuddyDb) {
    const db = workbuddyDb.replace(/\\/g, '/');
    bothSlashes(db, 'D:/your-appdata/.workbuddy/workbuddy.db');
    const dataRoot = db.replace(/\/\.workbuddy\/.*$/, '');
    if (dataRoot && dataRoot !== db) bothSlashes(dataRoot, 'D:/your-appdata');
  }

  // ③ SSH 隧道主机：整串、用户名、主机名各自都要换掉
  if (sshHost) {
    add(sshHost, 'user@your-host');
    const [user, host] = sshHost.split('@');
    if (user && user.length >= 3) add(user, 'your-user');
    if (host && host.length >= 3) add(host, 'your-host');
  }

  // ④ 本机用户目录（C:\Users\<name>）
  const home = homedir();
  if (home) bothSlashes(home, '%USERPROFILE%');

  // ⑤ 额外规则（gitignored）：例如组织 scope
  let extraScan = [];
  if (existsSync(EXTRA_RULES_FILE)) {
    try {
      const extra = JSON.parse(readFileSync(EXTRA_RULES_FILE, 'utf8'));
      for (const [from, to] of extra?.replace ?? []) add(from, to);
      if (Array.isArray(extra?.scan)) extraScan = extra.scan;
    } catch (err) {
      console.warn(`⚠ 额外规则文件解析失败（已忽略）：${err.message}`);
    }
  }

  // 长的先替换
  pairs.sort((a, b) => b[0].length - a[0].length);
  return { pairs, extraScan };
}

/**
 * 残留扫描用的**通用**模式 —— 刻意不包含任何具体取值，
 * 用来兜"规则没覆盖到的新个人取值"。
 */
const GENERIC_SCAN_PATTERNS = [
  // Windows 用户目录：X:\Users\<someone>
  // 要求用户名以字母数字开头 —— 否则会误报文档里的举例写法 `C:\Users\...`
  String.raw`[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9][^\\/\s"'\`]*`,
  // POSIX 家目录：/home/<someone>/ 或 /Users/<someone>/
  // 排除占位符本身（`your-user` / `user` / `example`），否则会误报脱敏后的产物
  String.raw`/(?:home|Users)/(?!your[-_]|user\b|username\b|example\b)[A-Za-z0-9._-]+/`,
  // 私网 IPv4（10/8、172.16/12、192.168/16）—— 隧道主机通常是这类地址
  String.raw`\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b`,
  // 凭据特征
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY`,
  String.raw`\bghp_[A-Za-z0-9]{20,}`,
  String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`,
];

/** 只同步这两类（`probe-report-*.md` 是 dsh 侧探针报告，不属于本仓库）。 */
function isSyncable(name) {
  return name === 'design-decisions.md' || /^round.*\.md$/.test(name);
}

function sanitize(text, pairs) {
  let out = text;
  for (const [from, to] of pairs) {
    out = out.split(from).join(to);
  }
  return out;
}

/** 台账编号统计：缺号 / 重复。 */
function ledgerStats(text) {
  const nums = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\|\s*(\d+)\s*\|/.exec(line);
    if (m) nums.push(Number(m[1]));
  }
  nums.sort((a, b) => a - b);
  const max = nums.length > 0 ? nums[nums.length - 1] : 0;
  const seen = new Set();
  const dups = [];
  for (const n of nums) {
    if (seen.has(n)) dups.push(n);
    else seen.add(n);
  }
  const missing = [];
  for (let i = 1; i <= max; i++) {
    if (!seen.has(i)) missing.push(i);
  }
  return { count: nums.length, max, missing, dups };
}

/** 扫描文本里的个人信息残留，返回 `行号: 片段`。 */
function findResiduals(text, patterns) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (const pattern of patterns) {
    let re;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      continue;
    }
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) hits.push(`L${i + 1}: ${lines[i].trim().slice(0, 120)}`);
    }
  }
  return hits;
}

/* ------------------------------------------------------------------ main -- */

const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const sourceArg = argv.find((a) => !a.startsWith('--'));
const sourceDir = sourceArg ? resolve(sourceArg) : DEFAULT_SOURCE;

const { pairs, extraScan } = deriveRules();
const scanPatterns = [...GENERIC_SCAN_PATTERNS, ...extraScan];

console.log(`源目录 : ${sourceDir}`);
console.log(`目标   : ${TARGET_DIR}`);
console.log(`模式   : ${checkOnly ? '检查（不写文件）' : '同步'}`);
console.log(`脱敏规则: ${pairs.length} 条（由本机私有配置推导）＋ 残留模式 ${scanPatterns.length} 条\n`);

if (pairs.length === 0) {
  console.error('❌ 没有推导出任何脱敏规则 —— 说明既没有 config.local.yaml，也读不到本机家目录。');
  console.error('   为防止把个人取值同步进仓库，这里直接中止。');
  process.exit(2);
}

if (!existsSync(sourceDir)) {
  console.error(`❌ 源目录不存在：${sourceDir}`);
  console.error('   本仓库里的 docs/ 已是一份可发布副本，无需同步也能正常阅读。');
  console.error('   若你确实在工作区里维护这些文档，请显式传源目录：');
  console.error('     node scripts/sync-docs.mjs <你的 docs 目录>');
  process.exit(2);
}

const sources = readdirSync(sourceDir).filter(isSyncable).sort();
if (sources.length === 0) {
  console.error(`❌ 源目录里没有可同步的文档（design-decisions.md / round*.md）：${sourceDir}`);
  process.exit(2);
}

mkdirSync(TARGET_DIR, { recursive: true });

let added = 0;
let updated = 0;
let unchanged = 0;
let dirty = false;
const stats = new Map();

for (const name of sources) {
  const clean = sanitize(readFileSync(join(sourceDir, name), 'utf8'), pairs);
  stats.set(name, ledgerStats(clean));

  const targetPath = join(TARGET_DIR, name);
  const exists = existsSync(targetPath);
  const previous = exists ? readFileSync(targetPath, 'utf8') : null;

  if (previous === clean) {
    unchanged += 1;
    console.log(`  = ${name}`);
    continue;
  }
  dirty = true;
  if (checkOnly) {
    console.log(`  ! ${name}  ${exists ? '副本已过期' : '副本缺失'}`);
    continue;
  }
  writeFileSync(targetPath, clean, 'utf8');
  if (exists) {
    updated += 1;
    console.log(`  ~ ${name}`);
  } else {
    added += 1;
    console.log(`  + ${name}`);
  }
}

const orphans = readdirSync(TARGET_DIR)
  .filter(isSyncable)
  .filter((n) => !sources.includes(n));
if (orphans.length > 0) {
  console.log('\n⚠ 仓库里存在源目录中已不存在的文档（未自动删除，请人工确认）：');
  for (const n of orphans) console.log(`    ${n}`);
}

/* ---- 校验 1：台账编号完整性 ---- */
let failed = false;
const ledger = stats.get('design-decisions.md');
if (ledger) {
  const ok = ledger.missing.length === 0 && ledger.dups.length === 0;
  console.log(
    `\n台账编号: ${ledger.count} 条（最大 #${ledger.max}）` +
      `  缺号=${ledger.missing.length ? ledger.missing.join(',') : '无'}` +
      `  重复=${ledger.dups.length ? ledger.dups.join(',') : '无'}` +
      `  ${ok ? '✅' : '❌'}`,
  );
  if (!ok) failed = true;
}

/* ---- 校验 2：脱敏残留 ---- */
console.log('\n脱敏残留扫描（通用模式 + 额外规则）:');
let residualTotal = 0;
for (const name of sources) {
  const hits = findResiduals(readFileSync(join(TARGET_DIR, name), 'utf8'), scanPatterns);
  if (hits.length > 0) {
    residualTotal += hits.length;
    console.log(`  ❌ ${name}`);
    for (const h of hits.slice(0, 3)) console.log(`      ${h}`);
  }
}
if (residualTotal === 0) {
  console.log('  ✅ 未发现残留');
} else {
  failed = true;
}

console.log(
  `\n同步结果: 新增 ${added} / 更新 ${updated} / 未变 ${unchanged}` +
    (checkOnly ? '（检查模式，未写文件）' : ''),
);

if (failed) {
  console.error('\n❌ 校验未通过');
  process.exit(1);
}
if (checkOnly && dirty) {
  console.error('\n❌ 仓库里的副本与源不一致 —— 跑一次 `node scripts/sync-docs.mjs` 同步');
  process.exit(1);
}
console.log('\n✅ 同步完成，校验通过');
