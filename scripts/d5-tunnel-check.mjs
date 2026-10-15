/**
 * D5 全链路实测：DshMonitor 监控 **SSH 隧道实例**（127.0.0.1:13080）。
 *
 * 这条链验证的是「本机密钥 -> 401 -> 自动走 SSH 取远端密钥 -> 重试 -> 拿到状态」。
 * 每一环都是真的：
 *   - 真 DshMonitor
 *   - 真 ~/.dsh/.credentials.yaml（本机密钥，对隧道实例**必然不适用**）
 *   - 真 ssh 子进程（硬超时）
 *   - 真远端 ~/.dsh/.credentials.yaml
 *   - 真 HTTP 打到隧道端口
 *
 * 为什么值得单独跑：D5 的价值全在"本机密钥不适用时能自动换密钥"，
 * 各部分单测通过 ≠ 接起来能工作。
 *
 * 用法（项目根目录，先 build）：
 *   node node_modules/typescript/bin/tsc -p tsconfig.json
 *   node scripts/d5-tunnel-check.mjs
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { localValues } from './lib/local-config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const require = createRequire(import.meta.url);

const { DshMonitor, LocalCredentialsSource } = require(resolve(root, 'dist/main/monitors/dsh.js'));
const { SshCredentialsSource } = require(resolve(root, 'dist/main/monitors/dsh-remote-auth.js'));

const TUNNEL = process.argv[2] ?? '127.0.0.1:13080';
// 真实 SSH 主机只在本地私有配置里（仓库保留占位符，避免泄露主机名）。
const SSH_HOST = process.argv[3] ?? localValues().sshHost ?? 'user@your-host';

const logLines = [];
const logger = {
  debug: () => undefined,
  info: (m) => logLines.push(`[info] ${m}`),
  warn: (m) => logLines.push(`[warn] ${m}`),
  error: (m) => logLines.push(`[error] ${m}`),
  logError: (m, e) => logLines.push(`[error] ${m} ${e instanceof Error ? e.message : String(e)}`),
};

const recording = [];
const ctx = {
  task: {
    id: 'dsh-tunnel',
    name: `dsh ${TUNNEL}（隧道）`,
    enabled: true,
    monitor: {
      type: 'dsh',
      authority: TUNNEL,
      sshHost: SSH_HOST,
      intervalMs: 60_000, // 只用 pollOnce，不靠定时器
      timeoutMs: 10_000,
    },
  },
  sink: (_id, ev) => recording.push(ev),
  logger,
  rules: { rules: [], errors: [] },
  timeouts: { startTimeoutMs: 10_000, staleTimeoutMs: 60_000, waitingTimeoutMs: 1_800_000 },
};

const checks = [];
const check = (name, cond, detail = '') => {
  checks.push({ name, cond, detail });
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`);
};

// ---------------------------------------------------------------------------
// 复刻 host.ts 的接线：LocalCredentialsSource + SSH 兜底
// ---------------------------------------------------------------------------
const remote = new SshCredentialsSource({ sshHost: SSH_HOST, onDebug: (m) => logger.info(m) });

const localSource = new LocalCredentialsSource(
  `${process.env.USERPROFILE}\\.dsh`,
  async () => {
    const result = await remote.get();
    if (!result.ok) {
      throw new Error(`SSH 取远端密钥失败（${remote.describe}）：${result.reason}`);
    }
    return result.secret;
  },
);

const monitor = new DshMonitor(ctx, { secretSources: [localSource] });

console.log(`监控隧道实例 ${TUNNEL}，远端凭据来源 ${SSH_HOST}\n`);
console.log('=== 第一轮：本机密钥必然 401，应触发远端兜底 ===');

const first = await monitor.pollOnce();
console.log(`  第一轮结果：ok=${first.ok} code=${first.errorCode ?? '-'} status=${first.status ?? '-'}`);
check('第一轮确实以认证失败告终（本机密钥对隧道不适用）', first.ok === false, String(first.errorCode));
check(
  '失败类型是 auth/unauthorized（不是网络/协议错）',
  first.errorCode === 'auth/unauthorized' || first.errorCode === 'credentials/missing',
  String(first.errorCode),
);

console.log('\n=== 第二轮：应已换成远端密钥并成功 ===');
// 第一轮 401 后 invalidateCredentials 已把 client 置空、来源缓存清掉，
// 第二轮 ensureClient 会走 fetchRemoteSecret -> ssh -> 远端密钥。
const second = await monitor.pollOnce();
console.log(`  第二轮结果：ok=${second.ok} code=${second.errorCode ?? '-'} status=${second.status ?? '-'} 会话数=${second.sessionCount ?? '-'}`);
check('第二轮成功（远端密钥生效）', second.ok === true, second.ok ? '' : `${second.errorCode}：${second.errorCode}`);
check('拿到了会话数', typeof second.sessionCount === 'number' && second.sessionCount > 0, String(second.sessionCount));
check(
  '聚合态是合法七态之一',
  ['idle', 'starting', 'running', 'waiting', 'success', 'failed', 'unknown'].includes(String(second.status)),
  String(second.status),
);

console.log('\n=== 第三轮：缓存生效，不该再跑 ssh ===');
const before = logLines.filter((l) => l.includes('已从')).length;
const third = await monitor.pollOnce();
const after = logLines.filter((l) => l.includes('已从')).length;
check('第三轮仍然成功（用的是缓存的密钥）', third.ok === true, String(third.errorCode ?? ''));
check('缓存生效：没有第二次 SSH 取密钥', after === before, `取密钥日志次数 ${before} -> ${after}`);

await monitor.stop();

console.log('\n=== 日志 ===');
for (const l of logLines) console.log(`  ${l}`);

console.log('\n=== 上报的状态 ===');
for (const ev of recording) {
  if (ev.kind === 'status') console.log(`  status=${ev.status}  ${ev.message ?? ''}`);
}

const failed = checks.filter((c) => !c.cond);
console.log(`\n${failed.length === 0 ? `✅ D5 全链路打通（${checks.length} 项）` : `❌ ${failed.length}/${checks.length} 项失败`}`);

// ⚠️ 用 `process.exitCode` 而不是 `process.exit()` 立刻强杀。
//
// 【为什么】原来直接 `process.exit(...)`，在 Windows 上**间歇性**崩溃：
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
//   exit code = -1073740791（0xC0000409，STATUS_STACK_BUFFER_OVERRUN）
// 实测同一份代码连跑三次：崩、过、过 —— **断言本身全绿**（✅ 已经打印出来了），
// 崩的是退出那一步：SSH 子进程的句柄还在关就被强杀了。
//
// 设 `exitCode` 让 Node 自然排空事件循环再退出，避开这个竞态；
// 万一还有句柄不释放（SSH 偶发），下面的兜底定时器负责强制收尾，
// 保证脚本不会挂住。`unref()` 让这个定时器本身不阻止自然退出。
process.exitCode = failed.length === 0 ? 0 : 1;
const forceExit = setTimeout(() => process.exit(process.exitCode ?? 1), 3000);
forceExit.unref();
