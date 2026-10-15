/**
 * 自动发现一个**真正可用**的 dsh authority。
 *
 * ============================================================================
 * 【为什么需要它 —— 已经被同一个原因绊倒两次】
 * ============================================================================
 * `d2-arbitration-check` 与 `live-dsh-check` 都把端口**写死**成 127.0.0.1:3080。
 * 而 dsh 的端口会变：
 *   - 早先本机 dsh web 在 3080
 *   - 后来 dsh 桌面客户端（DeepSeekHarnessLauncher）把本地服务放在 **19387**
 * 端口一变，这两条实测链就"失败"——但代码其实没坏，是脚本在敲一个不开的门。
 * 这种假警报会浪费排查时间，也会掩盖真正的回归。
 *
 * 所以：从**真实配置文件**里读出所有 dsh 任务，逐个探测，取第一个能通的。
 *
 * 只探测**本机**实例（没配 sshHost 的）：远端/隧道实例要走 SSH 取密钥，
 * 探测一次要几十秒，不适合放在前置发现里。
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * @param {string} root 项目根目录
 * @returns {Promise<{authority: string, sessions: number} | null>}
 */
export async function findLiveDshAuthority(root) {
  const require = createRequire(import.meta.url);
  const YAML = require('yaml');
  const { validateConfig } = require(resolve(root, 'dist/main/config.js'));
  const { DshMonitor, LocalCredentialsSource } = require(resolve(root, 'dist/main/monitors/dsh.js'));

  let candidates = [];
  try {
    const text = readFileSync(resolve(root, 'config.dsh.example.yaml'), 'utf8');
    const out = validateConfig(YAML.parse(text));
    candidates = out.config.tasks
      .filter((t) => t.monitor.type === 'dsh' && typeof t.monitor.authority === 'string')
      // 只挑本机实例（远端/隧道要 SSH，探测太慢）
      .filter((t) => t.monitor.sshHost === undefined)
      .map((t) => t.monitor.authority);
  } catch {
    candidates = [];
  }

  // 兜底候选：即使配置读不到，也试一下几个已知的本地端口
  for (const extra of ['127.0.0.1:19387', '127.0.0.1:3080']) {
    if (!candidates.includes(extra)) candidates.push(extra);
  }

  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
  const dshHome = resolve(home, '.dsh');

  for (const authority of candidates) {
    const events = [];
    const ctx = {
      task: { id: 'discover', name: 'discover', enabled: true, monitor: { type: 'dsh', authority } },
      sink: (_id, ev) => events.push(ev),
      logger: { debug() {}, info() {}, warn() {}, error() {}, logError() {} },
      rules: { waiting: [], running: [], success: [], failed: [] },
      timeouts: { startTimeoutMs: 10_000, staleTimeoutMs: 60_000, waitingTimeoutMs: 1_800_000 },
    };
    const mon = new DshMonitor(ctx, { secretSources: [new LocalCredentialsSource(dshHome)] });
    try {
      const outcome = await mon.pollOnce();
      if (outcome.ok === true) {
        // 从 message 里抠出会话数（形如 `dsh 127.0.0.1:19387：17 会话`）
        const msg = events.filter((e) => e.kind === 'status').map((e) => e.message ?? '').join(' ');
        const m = /(\d+)\s*会话/u.exec(msg);
        await mon.stop();
        return { authority, sessions: m ? Number(m[1]) : 0 };
      }
    } catch {
      /* 换下一个 */
    }
    await mon.stop();
  }

  return null;
}
