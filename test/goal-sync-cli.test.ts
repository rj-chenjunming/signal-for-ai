/**
 * SPEC-027 / AC-01、AC-09：goal-sync CLI 的写入与参数校验。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const scriptPath = path.join(process.cwd(), 'scripts', 'goal-sync.mjs');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiti-goal-sync-'));
  tempDirs.push(dir);
  return dir;
}

function run(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('goal-sync CLI', () => {
  it('写入一行合法 JSON（默认 progress）', () => {
    const dir = tempDir();
    const inbox = path.join(dir, 'goal-inbox.jsonl');
    const result = run(['--goal', 'AI信号灯软件开发', '--text', '  SPEC-026 完成  ', '--inbox', inbox]);
    expect(result.status).toBe(0);
    expect(String(result.stdout)).toContain('goal-inbox.jsonl');

    const line = JSON.parse(fs.readFileSync(inbox, 'utf8').trim()) as Record<string, unknown>;
    expect(line).toEqual({
      goal: 'AI信号灯软件开发',
      kind: 'progress',
      text: 'SPEC-026 完成',
    });
  });

  it('支持 --kind issue', () => {
    const dir = tempDir();
    const inbox = path.join(dir, 'goal-inbox.jsonl');
    expect(run(['--goal', 'AI信号灯软件开发', '--text', '问题', '--kind', 'issue', '--inbox', inbox]).status).toBe(0);
    const line = JSON.parse(fs.readFileSync(inbox, 'utf8').trim()) as Record<string, unknown>;
    expect(line['kind']).toBe('issue');
  });

  it('缺 --text、非法 --kind、超长文本都拒绝且不写文件', () => {
    const dir = tempDir();
    const inbox = path.join(dir, 'goal-inbox.jsonl');
    const missingText = run(['--goal', 'AI信号灯软件开发', '--inbox', inbox]);
    expect(missingText.status).not.toBe(0);
    expect(fs.existsSync(inbox)).toBe(false);

    expect(run(['--goal', 'AI信号灯软件开发', '--text', 'x', '--kind', 'done', '--inbox', inbox]).status).not.toBe(0);
    expect(fs.existsSync(inbox)).toBe(false);

    expect(run(['--goal', 'AI信号灯软件开发', '--text', 'x'.repeat(501), '--inbox', inbox]).status).not.toBe(0);
    expect(fs.existsSync(inbox)).toBe(false);
  });

  it('--help 输出用法并以 0 退出', () => {
    const result = run(['--help']);
    expect(result.status).toBe(0);
    expect(String(result.stdout)).toContain('用法');
  });
});
