/**
 * D5 探测：能否非交互 SSH 到隧道主机、取回远端 dsh 的 browser-session 密钥？
 *
 * 上一轮用 PowerShell 直接跑 ssh 挂起超过 5 分钟无返回，只能中止。
 * 这次换 node:child_process + 硬 timeout —— 子进程超时会被真正杀掉，
 * 不会像 PowerShell 那样把整个调用挂住。
 *
 * 依次尝试多条 ssh 调用方式，把"哪条能通"明确记录出来：
 *   1. 裸 ssh（默认配置）
 *   2. 带 -F 的现有工作配置（项目里那几条隧道用的就是它）
 *   3. 带 -i 显式密钥
 * 每一步都有硬超时，失败即继续，绝不停在那里。
 *
 * 用法：node scripts/d5-ssh-probe.mjs
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

import { localValues } from './lib/local-config.mjs';

// 真实 SSH 主机只在本地私有配置里（仓库保留占位符）。
const HOST = process.argv[2] ?? localValues().sshHost ?? 'user@your-host';
const TIMEOUT_MS = 12_000;

/** 跑一条命令，硬超时；返回 {ok, code, stdout, stderr, timedOut, ms}。 */
function run(file, args, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const ms = Date.now() - t0;
        if (err === null) {
          resolve({ ok: true, code: 0, stdout: stdout ?? '', stderr: stderr ?? '', timedOut: false, ms });
          return;
        }
        // execFile 超时时 err.killed 为 true 且 signal 有值
        const timedOut = err.killed === true || err.signal !== null;
        resolve({
          ok: false,
          code: typeof err.code === 'number' ? err.code : -1,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          timedOut,
          ms,
          message: err.message,
        });
      },
    );
    // 双保险：即使 execFile 的 timeout 没生效，也在外部再杀一次
    const guard = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }, timeoutMs + 2_000);
    child.on('exit', () => clearTimeout(guard));
  });
}

const REMOTE_CMD = 'echo D5_OK; hostname; ls -1 ~/.dsh/.credentials.yaml 2>&1';

const attempts = [
  {
    name: '裸 ssh + BatchMode',
    file: 'ssh',
    args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', HOST, REMOTE_CMD],
  },
];

// 已知工作配置（现有隧道用的就是它）
const cfgPath = 'D:\\Code\\ssh\\ssh_config';
if (existsSync(cfgPath)) {
  attempts.push({
    name: `带 -F ${cfgPath}`,
    file: 'ssh',
    args: ['-F', cfgPath, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', HOST, REMOTE_CMD],
  });
}

const keyPath = `${process.env.USERPROFILE}\\.ssh\\id_rsa`;
if (existsSync(keyPath)) {
  attempts.push({
    name: '带 -i id_rsa',
    file: 'ssh',
    args: [
      '-i', keyPath,
      '-o', 'BatchMode=yes',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'ConnectTimeout=8',
      '-o', 'StrictHostKeyChecking=accept-new',
      HOST,
      REMOTE_CMD,
    ],
  });
}

console.log(`探测目标：${HOST}（每次硬超时 ${TIMEOUT_MS}ms）\n`);

let winner = null;
for (const a of attempts) {
  process.stdout.write(`--- ${a.name} ... `);
  const r = await run(a.file, a.args);
  if (r.ok) {
    console.log(`✅ 通（${r.ms}ms）`);
    console.log(`    stdout: ${r.stdout.trim().split('\n').join(' | ')}`);
    winner = { attempt: a, result: r };
    break;
  }
  const why = r.timedOut ? `⏱ 超时（${r.ms}ms）` : `✗ 退出码 ${r.code}（${r.ms}ms）`;
  console.log(why);
  const errLine = (r.stderr || r.message || '').trim().split('\n')[0];
  if (errLine) console.log(`    stderr: ${errLine.slice(0, 200)}`);
}

console.log('');
if (winner === null) {
  console.log('❌ 三条路都不通 —— D5 的 SSH 取密钥在此环境下不可行');
  process.exit(1);
}

// 拿到了通路，接着真去取密钥（这次要把 credentials 读回来）
console.log('=== 用通的那条路取远端 credentials ===');
const fetchArgs = winner.attempt.args.map((x) => (x === REMOTE_CMD ? 'cat ~/.dsh/.credentials.yaml' : x));
const fetched = await run('ssh', fetchArgs, 15_000);

if (!fetched.ok) {
  console.log(`❌ 取 credentials 失败：${fetched.timedOut ? '超时' : `退出码 ${fetched.code}`}`);
  console.log(`   ${(fetched.stderr || '').trim().split('\n')[0] ?? ''}`);
  process.exit(1);
}

const text = fetched.stdout;
console.log(`✅ 取回 ${text.length} 字节`);

// 用与主程序相同的解析器验证它确实可用
const { parseSigningSecret, signCookie } = await import(
  `file:///${process.cwd().replace(/\\/gu, '/')}/dist/main/monitors/dsh-instance.js`
).catch(() => ({ parseSigningSecret: null, signCookie: null }));

if (parseSigningSecret === null) {
  console.log('⚠️ 无法加载 dist 里的解析器（先 build），只做结构性检查');
  const at = text.indexOf('client-connection/browser-session');
  console.log(`   含 browser-session 记录：${at !== -1}`);
  process.exit(at !== -1 ? 0 : 1);
}

try {
  const secret = parseSigningSecret(text);
  console.log(`✅ 远端密钥解析成功：${secret.byteLength} 字节`);

  // 关键验证：用**远端**密钥为隧道端口签 cookie，看能否通过 401
  const cookie = signCookie('127.0.0.1:13080', secret);
  console.log(`   为 127.0.0.1:13080 签了 cookie（name=${cookie.name.slice(0, 26)}…）`);

  const res = await fetch('http://127.0.0.1:13080/', {
    method: 'GET',
    headers: { accept: 'text/html', cookie: cookie.header },
    redirect: 'manual',
    signal: AbortSignal.timeout(8_000),
  });
  console.log(`   GET / -> HTTP ${res.status}`);
  if (res.status === 200) {
    console.log('\n✅✅ D5 打通：用远端密钥成功认证隧道实例 13080');
    process.exit(0);
  }
  console.log(`\n⚠️ 仍非 200（${res.status}）—— 见上方分析`);
  process.exit(1);
} catch (err) {
  console.log(`❌ 解析远端密钥失败：${err.message}`);
  process.exit(1);
}
