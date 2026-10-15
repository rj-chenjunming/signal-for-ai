/**
 * 依赖补齐脚本（仅用于开发期修复不完整的 node_modules）。
 *
 * 背景：本项目在受限沙箱中安装依赖时，npm 的 optionalDependencies 处理不完整，
 * 导致 vitest 启动时依次缺失 debug / ms / @rollup/rollup-win32-x64-msvc 等包。
 * 这个脚本从 registry 元数据递归读取依赖树，逐个下载缺失的包。
 *
 * 用法：node scripts/fix-missing-deps.mjs [包名...]
 * 不传参数时，自动从 vitest 的启动报错里推断需要哪些包。
 */
import { mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const REGISTRY = 'https://registry.npmmirror.com';

/** 把 registry 返回的 tarball URL 换成镜像地址 */
function mirrorize(url) {
  return url.replace('https://registry.npmjs.org', REGISTRY);
}

const installed = new Set();

async function fetchJson(pkg) {
  const res = await fetch(`${REGISTRY}/${pkg.replace('/', '%2f')}`);
  if (!res.ok) throw new Error(`${pkg}: HTTP ${res.status}`);
  return res.json();
}

async function install(pkg, version, depth = 0) {
  if (depth > 6) return;
  const key = `${pkg}@${version}`;
  if (installed.has(key)) return;

  const target = join('node_modules', ...pkg.split('/'));
  if (existsSync(join(target, 'package.json'))) {
    // 已存在则不再重复下载，但要继续补它的依赖
    installed.add(key);
    const meta = await fetchJson(pkg);
    const deps = { ...meta.versions[version]?.dependencies };
    for (const [d, range] of Object.entries(deps)) {
      const dv = await resolveVersion(d, range);
      if (dv) await install(d, dv, depth + 1);
    }
    return;
  }

  process.stdout.write(`${'  '.repeat(depth)}↓ ${key}\n`);
  const meta = await fetchJson(pkg);
  const info = meta.versions[version];
  if (!info) throw new Error(`${key} 版本不存在`);

  const res = await fetch(mirrorize(info.dist.tarball));
  if (!res.ok) throw new Error(`${key} 下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  const tgz = join('node_modules', `.tmp-${pkg.replace(/[/@]/g, '_')}.tgz`);
  writeFileSync(tgz, buf);
  mkdirSync(target, { recursive: true });
  execFileSync('tar', [
    '-xzf', tgz,
    '-C', target,
    '--strip-components=1',
  ], { stdio: 'pipe' });
  rmSync(tgz, { force: true });
  installed.add(key);

  for (const [d, range] of Object.entries(info.dependencies ?? {})) {
    const dv = await resolveVersion(d, range);
    if (dv) await install(d, dv, depth + 1);
  }
}

/** 把 semver range 解析成 registry 上的具体版本（够用即可，不追求完整 range 语义） */
async function resolveVersion(pkg, range) {
  if (/^\d/.test(range)) return range.replace(/^[\^~]/, '');
  try {
    const meta = await fetchJson(pkg);
    return meta['dist-tags'].latest;
  } catch {
    return null;
  }
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('用法：node scripts/fix-missing-deps.mjs <包名...>');
  process.exit(1);
}

for (const t of targets) {
  const [pkg, ver] = t.split('@');
  try {
    await install(pkg, ver ?? (await resolveVersion(pkg, '*')));
    console.log(`✓ ${t}`);
  } catch (e) {
    console.error(`✗ ${t}: ${e.message}`);
  }
}