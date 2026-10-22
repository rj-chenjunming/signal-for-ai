#!/usr/bin/env node
/**
 * SPEC-027：把一条目标进展写入应用收件箱。
 *
 * 用法：
 *   node scripts/goal-sync.mjs --goal "AI信号灯软件开发" --text "SPEC-026 完成"
 *   node scripts/goal-sync.mjs --goal-id <uuid> --kind issue --text "真机发现问题"
 *
 * 应用运行中约 1 秒内导入；应用未运行时会保留，下次启动导入。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const MAX_TEXT = 500;

function usage() {
  console.log(`用法：
  node scripts/goal-sync.mjs --goal "目标标题" --text "进展内容" [--kind progress|issue] [--inbox <path>]
  node scripts/goal-sync.mjs --goal-id <uuid> --text "进展内容" [--kind progress|issue]

说明：
  --goal      按目标标题匹配（同名目标不唯一时请改用 --goal-id）
  --goal-id   按目标 id 精确匹配
  --text      1–${MAX_TEXT} 个字符；首尾空白会被去掉
  --kind      默认 progress，可选 issue
  --inbox     覆盖收件箱路径（默认 %APPDATA%/ai-task-indicator/goal-inbox.jsonl）
  --help      显示本帮助`);
}

function defaultInboxPath() {
  if (process.env.AI_INDICATOR_INBOX) {
    return process.env.AI_INDICATOR_INBOX;
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'ai-task-indicator', 'goal-inbox.jsonl');
  }
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configHome, 'ai-task-indicator', 'goal-inbox.jsonl');
}

function fail(message) {
  console.error(`goal-sync: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { goal: '', goalId: '', text: '', kind: 'progress', inbox: '', help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) {
        fail(`参数 ${arg} 缺少值`);
      }
      index += 1;
      return value;
    };
    switch (arg) {
      case '--goal':
        options.goal = next();
        break;
      case '--goal-id':
        options.goalId = next();
        break;
      case '--text':
        options.text = next();
        break;
      case '--kind':
        options.kind = next();
        break;
      case '--inbox':
        options.inbox = next();
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        fail(`未知参数：${arg}（--help 查看用法）`);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  usage();
  process.exit(0);
}

const goal = options.goal.trim();
const goalId = options.goalId.trim();
const text = options.text.trim();
if (!goal && !goalId) {
  fail('必须提供 --goal 或 --goal-id');
}
if (text.length === 0 || text.length > MAX_TEXT) {
  fail(`--text 需为 1–${MAX_TEXT} 个字符`);
}
if (options.kind !== 'progress' && options.kind !== 'issue') {
  fail('--kind 只能是 progress 或 issue');
}

const inbox = options.inbox || defaultInboxPath();
const record = goalId
  ? { goalId, kind: options.kind, text }
  : { goal, kind: options.kind, text };

try {
  mkdirSync(dirname(inbox), { recursive: true });
  appendFileSync(inbox, `${JSON.stringify(record)}\n`, 'utf8');
} catch (error) {
  fail(`写入收件箱失败：${error.message}`);
}

console.log(`已写入 ${inbox}`);
console.log('应用运行中会在约 1 秒内导入；未运行则下次启动导入。');
