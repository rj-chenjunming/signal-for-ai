/** 并排对比：能通的那条路 vs 得 401 的那条路。 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const require = createRequire(import.meta.url);

const AUTHORITY = '127.0.0.1:3080';
const b64url = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');

// ---------- A. 手写路径（已知能通） ----------
const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8');
const at = text.indexOf('client-connection/browser-session');
const m = /^\s*secret:\s*(\S+)\s*$/mu.exec(text.slice(at));
const secretStr = m[1];
const secretA = Buffer.from(secretStr.replaceAll('-', '+').replaceAll('_', '/'), 'base64');

const nameA = 'dsh-auth-' + b64url(createHash('sha256').update(AUTHORITY).digest());
const issuedAtA = Date.now();
const bodyA = b64url(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt: issuedAtA, expiresAt: issuedAtA + 86400000 }));
const valA = `v1.${bodyA}.${b64url(createHmac('sha256', secretA).update(bodyA).digest())}`;
const headerA = `${nameA}=${valA}`;

// ---------- B. dist 里的 DshClient ----------
const dsh = require(resolve(root, 'dist/main/monitors/dsh-instance.js'));
const secretB = dsh.readSigningSecret(join(homedir(), '.dsh'));
const ckB = dsh.signCookie(AUTHORITY, secretB);
const headerB = ckB.header;

console.log('secretA === secretB :', secretA.equals(secretB));
console.log('nameA === nameB     :', nameA === ckB.name);
console.log('headerA len         :', headerA.length);
console.log('headerB len         :', headerB.length);

// 解出两者的 payload 比较（除时间戳）
const parse = (h) => {
  const [n, v] = h.split('=');
  const [, body, sig] = v.split('.');
  return { n, body: JSON.parse(Buffer.from(body.replace(/-/gu, '+').replace(/_/gu, '/'), 'base64').toString('utf8')), sig, bodyRaw: body };
};
const pa = parse(headerA);
const pb = parse(headerB);
console.log('\npayloadA:', JSON.stringify(pa.body));
console.log('payloadB:', JSON.stringify(pb.body));
console.log('authority 相同:', pa.body.authority === pb.body.authority);
console.log('sig 相同（同秒内签发则相同）:', pa.sig === pb.sig);

// ---------- 实测两条路 ----------
console.log('\n--- A: 手写 cookie，POST /api/session/list ---');
const rpcIdA = randomUUID();
const resA = await fetch(`http://${AUTHORITY}/api/session/list`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: headerA },
  body: JSON.stringify({ type: 'client-request', rpcId: rpcIdA, method: 'session/list', payload: { args: { _request: {} } } }),
  signal: AbortSignal.timeout(8000),
});
const txtA = await resA.text();
console.log(`  HTTP ${resA.status}  ${txtA.slice(0, 120)}`);

console.log('\n--- B: DshClient.listSessions() ---');
const client = new dsh.DshClient({ authority: AUTHORITY, secret: secretB });
const rB = await client.listSessions();
console.log(`  ok=${rB.ok} ${rB.ok ? 'items=' + (rB.value?.items?.length ?? 0) : rB.code + ' / ' + rB.message}`);

console.log('\n--- C: 用 DshClient 的 cookie 手写 POST ---');
const rpcIdC = randomUUID();
const resC = await fetch(`http://${AUTHORITY}/api/session/list`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: headerB },
  body: JSON.stringify({ type: 'client-request', rpcId: rpcIdC, method: 'session/list', payload: { args: { _request: {} } } }),
  signal: AbortSignal.timeout(8000),
});
const txtC = await resC.text();
console.log(`  HTTP ${resC.status}  ${txtC.slice(0, 160)}`);
