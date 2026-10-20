/** Codex command Hook. Reads stdin only; never approves, denies or returns tool content. */
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
const chunks = [];
let bytes = 0;
try {
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes <= 8 * 1024 * 1024) chunks.push(chunk);
  }
  if (bytes > 8 * 1024 * 1024) throw new Error('input limit');
  const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const index = process.argv.indexOf('--events');
  const file = index >= 0 ? process.argv[index + 1] : undefined;
  if (!object(raw) || !file || !id(raw.session_id)) throw new Error('invalid hook');
  const kinds = { PermissionRequest: 'approval_requested', PostToolUse: 'tool_returned', Stop: 'clear', Interrupt: 'clear', SessionEnd: 'clear', UserPromptSubmit: 'clear' };
  const event = Object.hasOwn(kinds, raw.hook_event_name) ? kinds[raw.hook_event_name] : undefined;
  if (!event) throw new Error('unsupported hook');
  const record = { version: 1, event, sessionId: raw.session_id, at: Date.now() };
  if (id(raw.turn_id)) record.turnId = raw.turn_id;
  if (event !== 'clear') {
    if (!id(raw.turn_id) || typeof raw.tool_name !== 'string' || !object(raw.tool_input)) throw new Error('missing tool identity');
    const toolInput = raw.tool_name === 'Bash'
      ? { command: raw.tool_input.command ?? raw.tool_input.cmd }
      : raw.tool_input;
    if (raw.tool_name === 'Bash' && typeof toolInput.command !== 'string') throw new Error('missing command');
    record.toolKey = createHash('sha256').update(JSON.stringify(canonical({ name: raw.tool_name, input: toolInput }))).digest('hex');
  } else {
    record.scope = raw.hook_event_name === 'SessionEnd' || raw.hook_event_name === 'UserPromptSubmit' ? 'session' : 'turn';
    if (record.scope === 'turn' && !record.turnId) throw new Error('missing turn identity');
  }
  // A single small append; the event file belongs to the indicator, never to Codex.
  appendFileSync(file, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
} catch {
  // Hook failures must not block a tool or leak its input via stderr.
}
process.stdout.write('{}\n');
