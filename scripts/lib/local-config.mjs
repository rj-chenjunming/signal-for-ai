/**
 * 本地私有取值读取器 —— 让"不入仓库的个人取值"集中在一个 gitignored 文件里。
 *
 * 【为什么需要它】
 * 这个工具最初是在一台真实机器上长出来的：SSH 隧道主机、WorkBuddy 数据库
 * 路径、agent 工作目录都是**这台机器特有的**。这些值一旦写进脚本默认值，
 * 推到公开仓库就等于泄露主机名与目录结构。
 *
 * 所以规则是：
 *   1. 仓库里的脚本**只保留占位符默认值**（`user@your-host` / `D:/your-appdata/...`）；
 *   2. 真实取值放在 `config.local.yaml`（已在 .gitignore 中）；
 *   3. 脚本运行时优先读它 —— 于是本机开发"零参数照常可用"，
 *      而 clone 下来的人拿到的是干净的占位符。
 *
 * 优先级：命令行参数 > 环境变量 > config.local.yaml > 占位符默认值。
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 本地私有配置文件（gitignored）。 */
export const LOCAL_CONFIG_FILE = resolve(root, 'config.local.yaml');

/**
 * 读取本机私有取值。
 *
 * 环境变量 `LAMP_SSH_HOST` / `LAMP_WORKBUDDY_DB` / `LAMP_AGENT_CWD` 可覆盖文件，
 * 便于临时换机器或 CI 时不改文件。
 *
 * @returns {{sshHost: string|null, workbuddyDb: string|null, agentCwd: string|null}}
 */
export function localValues() {
  const out = {
    sshHost: process.env['LAMP_SSH_HOST'] ?? null,
    workbuddyDb: process.env['LAMP_WORKBUDDY_DB'] ?? null,
    agentCwd: process.env['LAMP_AGENT_CWD'] ?? null,
  };

  if (!existsSync(LOCAL_CONFIG_FILE)) {
    return out;
  }

  try {
    const YAML = require('yaml');
    const cfg = YAML.parse(readFileSync(LOCAL_CONFIG_FILE, 'utf8'));
    const tasks = cfg?.tasks;
    if (!Array.isArray(tasks)) {
      return out;
    }
    for (const task of tasks) {
      const monitor = task?.monitor;
      const jump = task?.jump;
      if (out.sshHost === null && typeof monitor?.sshHost === 'string') {
        out.sshHost = monitor.sshHost;
      }
      if (out.workbuddyDb === null && typeof monitor?.database === 'string') {
        out.workbuddyDb = monitor.database;
      }
      if (out.agentCwd === null && typeof jump?.cwd === 'string') {
        out.agentCwd = jump.cwd;
      }
    }
  } catch {
    // 读不动就用占位符默认值 —— 这不该让校验脚本崩掉
  }

  return out;
}
