/**
 * 把 `extension/` 打包成签名版 `.crx`。
 *
 * 【为什么用 Chrome 自己的 --pack-extension，而不是自己拼 CRX3】
 * CRX3 = `"Cr24"` + 版本号 + protobuf 头（含 RSA 签名）+ zip。签名覆盖
 * `"CRX3 SignedData\0" + 长度 + signed_header_data + 归档长度 + 归档` 这段
 * 精确字节序列，自己实现很容易在长度字段或字节序上出错 ——
 * 而错一个字节，Chrome 就只会说"文件损坏"。交给 Chrome 打包最稳。
 *
 * 【密钥与扩展 ID】
 * 首次运行会生成 `extension/crx/<name>.pem`（**私钥，已在 .gitignore 中**）。
 * Chrome 的扩展 ID = `SHA256(公钥 DER)` 前 16 字节，每个半字节映射到 a–p。
 * 之后复用同一把密钥，扩展 ID 就不变 —— 这点很重要：换密钥 = 换 ID，
 * 用户之前授予的权限/站点访问会全部重置。
 *
 * 用法：node scripts/pack-extension.mjs
 */

import { createHash, createPublicKey } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const EXT_DIR = join(root, 'extension');
const OUT_DIR = join(EXT_DIR, 'crx');
const NAME = 'ai-task-indicator-tab-bridge';
const CRX_PATH = join(OUT_DIR, `${NAME}.crx`);
const KEY_PATH = join(OUT_DIR, `${NAME}.pem`);

/** 打包时需要排除的条目（输出目录自身与说明文档不该进包）。 */
const EXCLUDE = new Set(['crx', 'README.md']);

/** 定位 Chrome。 */
function resolveChrome() {
  const candidates = [
    process.env['CHROME_PATH'],
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env['LOCALAPPDATA']
      ? join(process.env['LOCALAPPDATA'], 'Google', 'Chrome', 'Application', 'chrome.exe')
      : null,
  ].filter((p) => typeof p === 'string' && p.length > 0);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** 由私钥算出 Chrome 扩展 ID。 */
function extensionIdFromKey(pemPath) {
  const publicDer = createPublicKey(readFileSync(pemPath, 'utf8')).export({
    type: 'spki',
    format: 'der',
  });
  return createHash('sha256')
    .update(publicDer)
    .digest()
    .subarray(0, 16)
    .toString('hex')
    .split('')
    .map((nibble) => String.fromCharCode(97 + parseInt(nibble, 16)))
    .join('');
}

/** 校验产物确实是 CRX3，且尾部是可解析的 zip。 */
function verifyCrx(crxPath) {
  const buf = readFileSync(crxPath);
  const magic = buf.subarray(0, 4).toString('ascii');
  const version = buf.readUInt32LE(4);
  const headerLength = buf.readUInt32LE(8);
  const zipStart = 12 + headerLength;
  const zipMagic = buf.subarray(zipStart, zipStart + 4).toString('hex');
  return {
    magic,
    version,
    headerLength,
    zipStart,
    zipMagic,
    ok: magic === 'Cr24' && version === 3 && zipMagic === '504b0304',
  };
}

/* ------------------------------------------------------------------ main -- */

const chrome = resolveChrome();
if (!chrome) {
  console.error('❌ 找不到 chrome.exe。可用环境变量 CHROME_PATH 指定。');
  process.exit(1);
}
console.log(`Chrome: ${chrome}`);

// 1) 把扩展源码复制到临时目录（Chrome 要求被打包目录里没有输出物）
const stage = join(process.env['TEMP'] ?? root, 'lamp-ext-pack');
rmSync(stage, { recursive: true, force: true });
const stageExt = join(stage, NAME);
mkdirSync(stageExt, { recursive: true });
for (const entry of readdirSync(EXT_DIR)) {
  if (EXCLUDE.has(entry)) continue;
  const src = join(EXT_DIR, entry);
  if (!statSync(src).isFile()) continue;
  copyFileSync(src, join(stageExt, entry));
}
console.log(`已暂存扩展源码: ${stageExt}`);

// 2) 调 Chrome 打包（有密钥就复用，保证扩展 ID 稳定）
const keyExisted = existsSync(KEY_PATH);
const args = [`--pack-extension=${stageExt}`, '--no-message-box'];
if (keyExisted) {
  args.push(`--pack-extension-key=${KEY_PATH}`);
}
console.log(`chrome ${args.join(' ')}`);
const run = spawnSync(chrome, args, { stdio: 'ignore', timeout: 60_000 });
if (run.error) {
  console.error(`❌ 调用 Chrome 失败：${run.error.message}`);
  process.exit(1);
}

const producedCrx = join(stage, `${NAME}.crx`);
const producedKey = join(stage, `${NAME}.pem`);
if (!existsSync(producedCrx)) {
  console.error('❌ Chrome 没有产出 .crx（--pack-extension 失败）');
  process.exit(1);
}

// 3) 收进 extension/crx/
mkdirSync(OUT_DIR, { recursive: true });
copyFileSync(producedCrx, CRX_PATH);
if (!keyExisted && existsSync(producedKey)) {
  copyFileSync(producedKey, KEY_PATH);
  console.log(`已生成新密钥（请妥善保管，换密钥会改变扩展 ID）: ${KEY_PATH}`);
}
rmSync(stage, { recursive: true, force: true });

// 4) 校验 + 报告
const info = verifyCrx(CRX_PATH);
console.log(`\n产物: ${CRX_PATH}`);
console.log(`大小: ${readFileSync(CRX_PATH).length} 字节`);
console.log(
  `结构: magic=${info.magic} version=${info.version} headerLen=${info.headerLength} zipMagic=${info.zipMagic} -> ${
    info.ok ? 'CRX3 OK ✅' : '异常 ❌'
  }`,
);
if (existsSync(KEY_PATH)) {
  const id = extensionIdFromKey(KEY_PATH);
  console.log(`扩展 ID: ${id}`);
  console.log(`扩展页: chrome://extensions/?id=${id}`);
}
console.log(`密钥复用: ${keyExisted ? '是（ID 未变）' : '否（本次新生成，ID 已固定）'}`);
process.exit(info.ok ? 0 : 1);
