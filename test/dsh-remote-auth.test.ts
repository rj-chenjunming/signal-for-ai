/**
 * D5 远端密钥来源测试。
 *
 * 用**注入的执行器**而不是真跑 SSH：真 SSH 受网络/免密配置影响，
 * 放进单测必然 flaky。真链路另有 `scripts/d5-ssh-probe.mjs` 负责验证
 * （那里实测已通：远端密钥 -> 为 13080 签 cookie -> HTTP 200）。
 *
 * 这里锁死的是**行为契约**：
 *   - 缓存生效（不能每次轮询都起一个 ssh 进程）
 *   - 失败不写缓存（一次网络抖动不该锁死 30 分钟）
 *   - 超时/非零退出/解析失败都能被区分并给出可读原因
 *   - 任何情况都不抛错（异常要被收敛成 {ok:false}）
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { SshCredentialsSource } from '../src/main/monitors/dsh-remote-auth';
import { parseSigningSecret } from '../src/main/monitors/dsh-instance';

/** 造一段与远端 credentials 同形的文本（实测远端是 293 字节，结构与本机一致）。 */
function credentialsText(secretB64: string): string {
  return [
    'version: 1',
    'refs:',
    '  DEEPSEEK_API_KEY: sk-remote-fake',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    `      secret: ${secretB64}`,
    '',
  ].join('\n');
}

/** 注入执行器的签名（与 SshCredentialsSource 的 exec 选项一致）。 */
type ExecFn = (
  file: string,
  args: readonly string[],
) => Promise<{ ok: true; stdout: string } | { ok: false; reason: string }>;

/**
 * 可被断言的假执行器。
 *
 * 显式声明签名（而不是 `vi.fn(async () => …)`）——后者会被推断成"零参数"，
 * 于是 `calls[0][1]` 在类型上不存在，只能靠 as 硬转。
 * 明确签名后，参数就能被真实读取与断言。
 */
function makeExec(
  impl: ExecFn = async () => ({ ok: true, stdout: credentialsText(SECRET_B64) }),
): { exec: ExecFn; calls: { file: string; args: readonly string[] }[] } {
  const calls: { file: string; args: readonly string[] }[] = [];
  const exec: ExecFn = async (file, args) => {
    calls.push({ file, args });
    return impl(file, args);
  };
  return { exec, calls };
}

const SECRET_B64 = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8')
  .toString('base64')
  .replace(/\+/gu, '-')
  .replace(/\//gu, '_')
  .replace(/=+$/u, '');

const HOST = 'user@10.0.0.1';

describe('SshCredentialsSource —— 正常路径', () => {
  it('取回并解析出 32 字节密钥', async () => {
    const { exec, calls } = makeExec();
    const src = new SshCredentialsSource({ sshHost: HOST, exec });

    const r = await src.get();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.secret.byteLength).toBe(32);
    expect(calls).toHaveLength(1);
  });

  it('ssh 参数里带 BatchMode（绝不允许交互式提问卡住进程）', async () => {
    const { exec, calls } = makeExec();
    const src = new SshCredentialsSource({ sshHost: HOST, exec });
    await src.get();

    const args = calls[0]?.args ?? [];
    expect(calls[0]?.file).toBe('ssh');
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('ConnectTimeout=8');
    expect(args).toContain(HOST);
    // 最后一条是远端命令
    expect(String(args.at(-1))).toContain('credentials.yaml');
  });

  it('extraArgs 被透传（支持 -F 配置 / 非标准端口）', async () => {
    const { exec, calls } = makeExec();
    const src = new SshCredentialsSource({
      sshHost: HOST,
      exec,
      extraArgs: ['-F', 'D:\\Code\\ssh\\ssh_config', '-p', '2222'],
    });
    await src.get();

    const args = calls[0]?.args ?? [];
    expect(args).toContain('-F');
    expect(args).toContain('D:\\Code\\ssh\\ssh_config');
    expect(args).toContain('2222');
  });

  it('自定义远端路径被使用', async () => {
    const { exec, calls } = makeExec();
    const src = new SshCredentialsSource({ sshHost: HOST, exec, remotePath: '/opt/dsh/.credentials.yaml' });
    await src.get();

    expect(String(calls[0]?.args.at(-1))).toContain('/opt/dsh/.credentials.yaml');
  });
});

describe('★ 缓存 —— 不能每次轮询都跑 SSH', () => {
  it('TTL 内重复调用只跑一次 ssh', async () => {
    const { exec, calls } = makeExec();
    const src = new SshCredentialsSource({ sshHost: HOST, exec, cacheTtlMs: 60_000 });

    const t = 1_800_000_000_000;
    await src.get(t);
    await src.get(t + 1_000);
    await src.get(t + 59_999);

    expect(calls).toHaveLength(1);
  });

  it('超过 TTL 后会重新取（密钥可能被轮换）', async () => {
    const { exec, calls } = makeExec();
    const src = new SshCredentialsSource({ sshHost: HOST, exec, cacheTtlMs: 1_000 });

    const t = 1_800_000_000_000;
    await src.get(t);
    await src.get(t + 1_001);

    expect(calls).toHaveLength(2);
  });

  it('invalidate() 强制下次重取', async () => {
    const { exec, calls } = makeExec();
    const src = new SshCredentialsSource({ sshHost: HOST, exec, cacheTtlMs: 60_000 });

    const t = 1_800_000_000_000;
    await src.get(t);
    src.invalidate();
    await src.get(t + 1);

    expect(calls).toHaveLength(2);
  });

  it('★ 失败**不写缓存** —— 一次网络抖动不该锁死 30 分钟', async () => {
    let n = 0;
    const { exec, calls } = makeExec(async () => {
      n += 1;
      return n === 1
        ? { ok: false, reason: 'SSH 超时（>20000ms）' }
        : { ok: true, stdout: credentialsText(SECRET_B64) };
    });

    const src = new SshCredentialsSource({ sshHost: HOST, exec, cacheTtlMs: 60_000 });

    const first = await src.get();
    expect(first.ok).toBe(false);

    const second = await src.get();
    expect(second.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

describe('失败路径 —— 都要给出可读原因且不抛错', () => {
  it('SSH 超时', async () => {
    const src = new SshCredentialsSource({
      sshHost: HOST,
      exec: async () => ({ ok: false as const, reason: 'SSH 超时（>20000ms）' }),
    });
    const r = await src.get();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/超时/u);
  });

  it('SSH 非零退出（带 stderr 摘要）', async () => {
    const src = new SshCredentialsSource({
      sshHost: HOST,
      exec: async () => ({ ok: false as const, reason: 'SSH 失败（exit=255）：Permission denied (publickey)' }),
    });
    const r = await src.get();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('Permission denied');
  });

  it('远端文件为空', async () => {
    const src = new SshCredentialsSource({
      sshHost: HOST,
      exec: async () => ({ ok: true as const, stdout: '' }),
    });
    const r = await src.get();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/为空/u);
  });

  it('远端返回的不是 credentials（如 shell 报错文本）', async () => {
    const src = new SshCredentialsSource({
      sshHost: HOST,
      exec: async () => ({ ok: true as const, stdout: 'cat: /home/u/.dsh/.credentials.yaml: No such file\n' }),
    });
    const r = await src.get();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/解析失败/u);
  });

  it('远端 secret 长度不对（解析器会明确报长度异常）', async () => {
    const short = Buffer.from('tooshort', 'utf8').toString('base64');
    const src = new SshCredentialsSource({
      sshHost: HOST,
      exec: async () => ({ ok: true as const, stdout: credentialsText(short) }),
    });
    const r = await src.get();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/长度异常/u);
  });

  it('执行器抛异常也被收敛成 {ok:false}，不扩散', async () => {
    const src = new SshCredentialsSource({
      sshHost: HOST,
      exec: async () => {
        throw new Error('spawn ssh ENOENT');
      },
    });
    const r = await src.get();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('ENOENT');
  });

  it('describe 带上主机名（日志里能看出是哪个远端）', () => {
    const src = new SshCredentialsSource({ sshHost: 'someone@10.9.9.9' });
    expect(src.describe).toBe('ssh:someone@10.9.9.9');
  });

  it('onDebug 在成功取回后被调用（便于记日志）', async () => {
    const onDebug = vi.fn();
    const src = new SshCredentialsSource({
      sshHost: HOST,
      onDebug,
      exec: async () => ({ ok: true as const, stdout: credentialsText(SECRET_B64) }),
    });
    await src.get();
    expect(onDebug).toHaveBeenCalledTimes(1);
    expect(String(onDebug.mock.calls[0]?.[0])).toContain('字节');
  });
});

describe('与本机解析器的互操作（远端文件同格式）', () => {
  it('本机 ~/.dsh/.credentials.yaml 能被同一个解析器读出（证明格式一致）', () => {
    // 这条保证：远端取回来的文本可以直接喂给本机那套 parseSigningSecret，
    // 不需要两套解析逻辑（dsh-remote-auth.ts 复用的正是它）。
    let text: string;
    try {
      text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8');
    } catch {
      return; // 环境没有该文件时跳过
    }
    const secret = parseSigningSecret(text);
    expect(secret.byteLength).toBe(32);
  });
});
