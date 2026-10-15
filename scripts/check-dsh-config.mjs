/**
 * 一次性校验脚本：用**项目自己的校验器**验证 config.dsh.example.yaml 合法。
 *
 * 为什么值得单独跑：示例配置如果通不过自己的校验器，就等于误导用户。
 *
 * 用法（在项目根目录）：
 *   node node_modules/typescript/bin/tsc -p tsconfig.json   # 需要 dist
 *   node scripts/check-dsh-config.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const require = createRequire(import.meta.url);

const YAML = require('yaml');
const { validateConfig } = require(resolve(root, 'dist/main/config.js'));

const target = process.argv[2] ?? resolve(root, 'config.dsh.example.yaml');
const text = readFileSync(target, 'utf8');

// ⚠️ 顺序必须与 config.ts 一致：**先 parse YAML，再展开环境变量**
// （parseConfigText -> parseYaml，然后 validateConfig -> expandDeep）。
// 反过来（先展开再 parse）会把 C:\Users\... 的反斜杠塞进双引号字符串里，
// 触发 BAD_DQ_ESCAPE —— 那是脚本自己的 bug，不是配置的 bug。
const raw = YAML.parse(text);
const outcome = validateConfig(raw);

console.log(`加载 ${target}\n`);
console.log(`警告 ${outcome.warnings.length} 条：`);
for (const w of outcome.warnings) console.log(`  - ${w}`);

const cfg = outcome.config;
const dshTasks = cfg.tasks.filter((t) => t.monitor.type === 'dsh');
console.log(`\n解析出任务 ${cfg.tasks.length} 个，其中 dsh 型 ${dshTasks.length} 个：`);
for (const t of cfg.tasks) {
  const m = t.monitor;
  const extra = m.type === 'dsh' ? ` authority=${m.authority}` : ` path=${m.path ?? ''}`;
  console.log(`  ${t.id.padEnd(18)} type=${m.type.padEnd(8)} enabled=${String(t.enabled).padEnd(5)}${extra}`);
}

console.log(`\ndshHome = ${String(cfg.app.dshHome)}`);

// 断言：示例里各类监控都有代表，且关键字段正确。
// ⚠️ 任务总数刻意**不写死** —— 示例会随功能增加而加条目，
// 写死数字会让每次加示例都"测试失败"，那是噪声不是信号。
const checks = [
  ['至少解析出 4 个示例任务', cfg.tasks.length >= 4, `实际 ${cfg.tasks.length}`],
  ['其中 dsh 型 2 个', dshTasks.length === 2, `实际 ${dshTasks.length}`],
  [
    '每种监控类型都有示例（dsh / webhook / process / sqlite）',
    ['dsh', 'webhook', 'process', 'sqlite'].every((ty) =>
      cfg.tasks.some((t) => t.monitor.type === ty),
    ),
    [...new Set(cfg.tasks.map((t) => t.monitor.type))].join(', '),
  ],
  [
    'dsh-local 的 authority 指向本地客户端（19387）',
    dshTasks.some((t) => t.id === 'dsh-local' && t.monitor.authority === '127.0.0.1:19387'),
  ],
  [
    'dsh-web 的 sshHost 被保留（远端实例必须从远端取密钥）',
    // ⚠️ 刻意**不**断言具体主机名：仓库里是占位符，真实取值在 config.local.yaml。
    // 断言"是个非空字符串"才能同时容纳两种情形，且不把个人主机名固化进测试。
    dshTasks.some(
      (t) =>
        t.id === 'dsh-web' &&
        typeof t.monitor.sshHost === 'string' &&
        t.monitor.sshHost.length > 0,
    ),
    (() => {
      const t = dshTasks.find((x) => x.id === 'dsh-web');
      return `sshHost=${String(t?.monitor?.sshHost ?? '(无)')}`;
    })(),
  ],
  [
    // ★ dsh-local 必须走 processNames 过滤的窗口聚焦：
    //   本机 Chrome 里也开着 dsh 页面、标题同样含 "DeepSeek Harness"，
    //   不加过滤会切到 Chrome（而 Chrome 窗口标题只反映激活标签，等于切不过去）。
    'dsh-local 配了按进程名过滤的窗口聚焦（排除 Chrome）',
    dshTasks.some(
      (t) =>
        t.id === 'dsh-local' &&
        t.jump?.terminal?.type === 'windowTitle' &&
        t.jump.terminal.match === 'DeepSeek Harness' &&
        Array.isArray(t.jump.terminal.processNames) &&
        t.jump.terminal.processNames.includes('DeepSeek Harness'),
    ),
    (() => {
      const t = dshTasks.find((x) => x.id === 'dsh-local');
      return `match=${t?.jump?.terminal?.match ?? '(无)'} procs=${JSON.stringify(t?.jump?.terminal?.processNames ?? null)}`;
    })(),
  ],
  [
    'dsh-web 配了 openUrl 指向 13080',
    dshTasks.some((t) => t.id === 'dsh-web' && t.jump?.openUrl === 'http://127.0.0.1:13080'),
  ],
  [
    // ★ dsh-web 必须走「经浏览器扩展精确切标签」。
    // 只配 openUrl 的话语义就是"打开"，每点一次多一个标签页；
    // 而 Chrome 136+ 已堵死主浏览器上的调试端口，扩展是唯一能用**日常浏览器**的路。
    'dsh-web 经浏览器扩展精确切标签（openUrlViaExtension）',
    dshTasks.some((t) => t.id === 'dsh-web' && t.jump?.openUrlViaExtension === true),
    (() => {
      const t = dshTasks.find((x) => x.id === 'dsh-web');
      return `openUrlViaExtension=${String(t?.jump?.openUrlViaExtension)}`;
    })(),
  ],
  [
    // dsh 型默认用端口号当灯带标签，但 19387 对人不直观 —— 显式短标签更可读
    '灯带标签可读（dsh 任务都配了 shortLabel）',
    dshTasks.length > 0 && dshTasks.every((t) => typeof t.shortLabel === 'string' && t.shortLabel.length > 0),
    dshTasks.map((t) => `${t.id}=${t.shortLabel ?? '(端口号)'}`).join(', '),
  ],
  [
    'workbuddy 的 sqlite 配置被保留（含活跃判据与进程闸门）',
    cfg.tasks.some(
      (t) =>
        t.id === 'workbuddy' &&
        t.monitor.type === 'sqlite' &&
        typeof t.monitor.database === 'string' &&
        t.monitor.database.endsWith('workbuddy.db') &&
        t.monitor.activeStatus === 'working' &&
        typeof t.monitor.activeWithinMs === 'number' &&
        t.monitor.activeWithinMs > 0 &&
        // 进程闸门必须保留 —— 它是"进程不在就隐藏"那一档的唯一来源
        Array.isArray(t.monitor.requireProcess) &&
        t.monitor.requireProcess.some((m) => m.processNames.includes('WorkBuddy.exe')),
    ),
  ],
  [
    'process 型示例仍在（含 processNames + cmdlineContains 两种规则）',
    cfg.tasks.some(
      (t) =>
        t.monitor.type === 'process' &&
        t.monitor.match.some((m) => m.processNames.length > 0) &&
        t.monitor.match.some((m) => (m.cmdlineContains?.length ?? 0) > 0),
    ),
  ],
  [
    'dshHome 的 %USERPROFILE% 被展开（不含 % 号）',
    typeof cfg.app.dshHome === 'string' && !cfg.app.dshHome.includes('%'),
    String(cfg.app.dshHome),
  ],
  ['没有警告（示例应当是干净的）', outcome.warnings.length === 0, `${outcome.warnings.length} 条`],
];

console.log('');
let failed = 0;
for (const [name, cond, detail] of checks) {
  if (!cond) failed += 1;
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`);
}

console.log(`\n${failed === 0 ? '✅ 示例配置可被项目校验器接受' : `❌ ${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
