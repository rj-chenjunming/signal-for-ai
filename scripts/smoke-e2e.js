/**
 * 端到端冒烟：不依赖 Electron，直接驱动真实组件跑通核心链路。
 *
 * 用法：node scripts/smoke-e2e.js
 * 覆盖：配置加载 → 状态仓库 → log 监控（真实文件）→ webhook（真实 HTTP）→ glob → 规则引擎
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseConfigText } = require('../dist/main/config.js');
const { TaskStore } = require('../dist/main/store.js');
const { LogMonitor } = require('../dist/main/monitors/logfile.js');
const { WebhookMonitor } = require('../dist/main/monitors/webhook.js');
const { compileRules, judgeStatusBatch } = require('../dist/main/monitors/pattern.js');
const { globFiles } = require('../dist/main/monitors/log-tail.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function check(label, ok, extra = '') {
  const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${mark} ${label}${extra ? ' → ' + extra : ''}`);
  if (!ok) failures += 1;
}

async function step1_config() {
  console.log('\n[1/5] 配置加载（真实读取 config.demo.yaml）');
  const p = path.join(__dirname, '..', 'config.demo.yaml');
  const out = parseConfigText(fs.readFileSync(p, 'utf8'));
  check('配置解析零警告', out.warnings.length === 0, out.warnings.join('; ') || '无');
  check(
    '三个任务已启用',
    out.config.tasks.length === 3 && out.config.tasks.every((t) => t.enabled),
    out.config.tasks.map((t) => `${t.id}[${t.monitor.type}]`).join(' '),
  );
  return out.config;
}

async function step2_store() {
  console.log('\n[2/5] 状态仓库（真实状态机）');
  const store = new TaskStore([
    { id: 's', name: 'S', enabled: true, monitor: { type: 'webhook', listen: '127.0.0.1', path: '/hook/s' } },
  ]);
  store.apply('s', { status: 'running', isSignal: true });
  check('running 生效', store.getSnapshot().tasks[0].status === 'running');

  // 这条正是修复过的假绿灯场景
  const rules = compileRules([
    { state: 'failed', match: '(error|fatal)' },
    { state: 'waiting', match: '(permission request)' },
    { state: 'success', match: '(task complete)' },
  ]);
  const judged = judgeStatusBatch(['permission request: allow?', 'task complete'], rules);
  check('授权+完成同批次判为success', judged.status === 'success', judged.status);

  store.apply('s', { status: 'waiting', isSignal: true });
  const ch = store.apply('s', { status: 'success', isSignal: true });
  check('waiting → success 不被拒绝（灯卡死修复）', ch !== null, store.getSnapshot().tasks[0].status);

  store.apply('s', { status: 'running', isSignal: true });
  store.apply('s', { status: 'failed', isSignal: true });
  check('聚合态为 failed', store.getSnapshot().aggregate === 'failed', store.getSnapshot().aggregate);
}

async function step3_glob() {
  console.log('\n[3/5] glob 路径匹配（真实文件系统）');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ati-smoke-'));
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  const files = [
    path.join(dir, 'root.log'),
    path.join(dir, 'a', 'one.log'),
    path.join(dir, 'a', 'b', 'two.log'),
    path.join(dir, 'a', 'skip.txt'),
  ];
  for (const f of files) fs.writeFileSync(f, 'x');

  check('**/*.log 递归任意深度', globFiles(path.join(dir, '**', '*.log')).length === 3);
  check('** 零层匹配 root.log', globFiles(path.join(dir, '**', '*.log')).includes(files[0]));
  check('*.log 只当前层', globFiles(path.join(dir, '*.log')).length === 1);
  check('字面量文件路径可用', globFiles(files[0]).length === 1);
  check('不存在的路径返回空', globFiles(path.join(dir, 'nope.log')).length === 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

async function step4_logMonitor() {
  console.log('\n[4/5] log 监控器（真实文件 + 真实轮询）');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ati-log-'));
  const logFile = path.join(dir, 'run.log');
  fs.writeFileSync(logFile, '', 'utf8');

  const RULES = [
    { state: 'failed', match: '(error|fatal)' },
    { state: 'waiting', match: '(permission request)' },
    { state: 'success', match: '(task complete)' },
    { state: 'running', match: '(step [0-9]+)' },
  ];
  const task = {
    id: 'log1',
    name: 'Log1',
    enabled: true,
    monitor: {
      type: 'log',
      paths: [logFile],
      rules: RULES,
      idleAfterSilenceMs: 999999,
      staleTimeoutMs: 999999,
    },
  };
  const seen = [];
  const mon = new LogMonitor(
    {
      task,
      sink: (_id, ev) => {
        if (ev.kind === 'status') seen.push(ev.status);
      },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, logError: () => {} },
      rules: compileRules(RULES),
      timeouts: { startTimeoutMs: 999999, staleTimeoutMs: 999999, waitingTimeoutMs: 999999 },
    },
    { pollIntervalMs: 30 },
  );

  await mon.start();
  await sleep(120);
  seen.length = 0;

  fs.appendFileSync(logFile, 'step 1 running\n', 'utf8');
  await sleep(140);
  check('追加 running 日志 → 上报 running', seen.includes('running'), seen.join(','));

  seen.length = 0;
  fs.appendFileSync(logFile, 'error: boom\n', 'utf8');
  await sleep(140);
  check('追加 error 日志 → 上报 failed', seen.includes('failed'), seen.join(','));

  seen.length = 0;
  fs.appendFileSync(logFile, 'error: again\n', 'utf8');
  await sleep(140);
  check('重复 failed 被去重', seen.filter((s) => s === 'failed').length <= 1, seen.join(','));

  await mon.stop();
  fs.rmSync(dir, { recursive: true, force: true });
}

async function step5_webhook() {
  console.log('\n[5/5] webhook 监控器（真实起 HTTP 服务 + 真实请求）');
  const TOKEN = 'smoke-token-xyz';
  const PORT = 17899;
  const task = {
    id: 'wh1',
    name: 'WH1',
    enabled: true,
    monitor: { type: 'webhook', listen: '127.0.0.1', path: '/hook/wh1', secret: TOKEN },
  };
  const store = new TaskStore([task]);

  // 契约（见 src/main/monitors/webhook.ts 与 hook-server.ts）：
  //   HookServer 负责「只 listen 一个端口」，各 WebhookMonitor 通过
  //   registerTask 把自己的 taskId + token 注册进去。
  //   HookServerHandlers 里收到回调后再交回对应的 monitor 处理。
  // 契约（见 src/main/monitors/hook-server.ts 的 HookServerHandlers）：
  //   onHook(req) 返回 HookOutcome —— ok=false 会被转成 4xx，
  //   httpStatus 可指定状态码，业务侧要自己校验 status 合法性。
  //   getSnapshot() 提供只读快照（对应 GET /api/tasks）。
  const { isTaskStatus } = require('../dist/shared/types.js');
  const { HookServer } = require('../dist/main/monitors/hook-server.js');

  const server = new HookServer(PORT, {
    log: () => {},
    getSnapshot: () => store.getSnapshot(),
    onHook: (req) => {
      // fieldMap 默认从 $.status 取值
      const raw = req.body.status;
      if (!isTaskStatus(raw)) {
        return { ok: false, error: `非法状态: ${String(raw)}`, httpStatus: 400 };
      }
      store.apply(req.taskId, {
        status: raw,
        message: typeof req.body.message === 'string' ? req.body.message : undefined,
        isSignal: true,
      });
      return { ok: true, taskStatus: raw };
    },
  });
  const mon = new WebhookMonitor(
    {
      task,
      sink: () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, logError: () => {} },
      rules: compileRules([]),
      timeouts: { startTimeoutMs: 999999, staleTimeoutMs: 999999, waitingTimeoutMs: 999999 },
    },
    server,
  );

  try {
    await server.start();
    await mon.start();
  } catch (e) {
    check('webhook 服务启动', false, e.message);
    return;
  }
  await sleep(250);

  const post = async (body, token) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/hook/wh1`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-indicator-token': token === undefined ? TOKEN : token,
      },
      body: JSON.stringify(body),
    });
    return r.status;
  };

  check('合法 running → 200', (await post({ status: 'running', message: '开始' })) === 200);
  await sleep(60);
  check('状态已写入 store', store.getSnapshot().tasks[0].status === 'running', store.getSnapshot().tasks[0].status);

  check('合法 failed → 200', (await post({ status: 'failed', message: '崩了' })) === 200);
  await sleep(60);
  check('聚合态转 failed', store.getSnapshot().aggregate === 'failed', store.getSnapshot().aggregate);

  check('非法 status → 400', (await post({ status: '不存在的状态' })) === 400);
  check('缺 token → 401', (await post({ status: 'running' }, '')) === 401);
  check('错 token → 401', (await post({ status: 'running' }, 'wrong') ) === 401);
  check('未注册任务 → 404', await fetch(`http://127.0.0.1:${PORT}/hook/nope`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-indicator-token': TOKEN },
    body: JSON.stringify({ status: 'running' }),
  }).then((r) => r.status) === 404);

  await mon.stop();
}

(async () => {
  console.log('='.repeat(62));
  console.log(' AI 任务状态指示灯 · 端到端冒烟测试（无 Electron 依赖）');
  console.log('='.repeat(62));
  const t0 = Date.now();
  try {
    const cfg = await step1_config();
    void cfg;
    await step2_store();
    await step3_glob();
    await step4_logMonitor();
    await step5_webhook();
  } catch (e) {
    console.error('\n\x1b[31m冒烟测试异常中断:\x1b[0m', e);
    failures += 1;
  }
  const ms = Date.now() - t0;
  console.log('\n' + '='.repeat(62));
  if (failures === 0) {
    console.log(`\x1b[32m全部通过\x1b[0m（${ms}ms）`);
  } else {
    console.log(`\x1b[31m${failures} 项失败\x1b[0m（${ms}ms）`);
  }
  console.log('='.repeat(62));
  process.exit(failures === 0 ? 0 : 1);
})();