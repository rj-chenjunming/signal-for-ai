import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lamp-hook-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
function run(input: unknown, eventFile = join(dir, 'events.jsonl')) {
  const result = spawnSync(process.execPath, [resolve('scripts/codex-status-hook.mjs'), '--events', eventFile], {
    input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 5000, windowsHide: true,
  });
  if (result.error) throw result.error;
  return { result, eventFile };
}
const sample = (hook_event_name: string, extra = {}) => ({ hook_event_name, session_id: 'session-a', turn_id: 'turn-a', tool_name: 'Bash', tool_input: { command: 'private command', description: 'private reason' }, ...extra });
const records = (file: string) => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];

describe('SPEC-011 Codex Hook privacy and neutrality', () => {
  it('只发布脱敏审批状态，stdout 不批准/拒绝且没有正文', () => {
    const { result, eventFile } = run(sample('PermissionRequest', { prompt: 'private prompt', tool_response: 'private output' }));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
    const raw = existsSync(eventFile) ? readFileSync(eventFile, 'utf8') : '';
    expect(raw).not.toMatch(/private|command|description|prompt|output/);
    expect(records(eventFile)[0]).toMatchObject({ version: 1, event: 'approval_requested', sessionId: 'session-a', turnId: 'turn-a' });
    expect(records(eventFile)[0].toolKey).toMatch(/^[a-f0-9]{64}$/);
  });
  it('审批理由变化不影响同一 Bash 工具返回的匹配摘要', () => {
    const file = join(dir, 'events.jsonl');
    run(sample('PermissionRequest'), file);
    const { result } = run(sample('PostToolUse', { tool_input: { command: 'private command' }, tool_use_id: 'call-a' }), file);
    expect(result.status).toBe(0);
    const rows = records(file);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ event: 'tool_returned', toolKey: rows[0].toolKey });
  });
  it.each(['Stop', 'Interrupt', 'SessionEnd', 'UserPromptSubmit'])('%s 输出中立的清理事件', hook => {
    const { result, eventFile } = run(sample(hook));
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toEqual({});
    expect(records(eventFile)[0]).toMatchObject({ event: 'clear', sessionId: 'session-a' });
  });
  it.each(['{broken', JSON.stringify({ hook_event_name: 'Unknown', session_id: 'a' })])('坏/未知输入不会阻断 Codex', input => {
    const { result } = run(input);
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toEqual({});
    expect(result.stderr).not.toMatch(/private|command/);
  });
  it('事件文件不可写时仍中立返回，不输出输入', () => {
    const { result } = run(sample('PermissionRequest'), join(dir, 'missing', 'events.jsonl'));
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toEqual({});
    expect(result.stderr).not.toContain('private');
  });
});
