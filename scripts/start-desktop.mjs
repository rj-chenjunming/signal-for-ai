import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function treeDigest(directory) {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  function visit(relative = '') {
    for (const entry of fs.readdirSync(join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Runtime symlinks are not supported');
      if (entry.isDirectory()) { visit(name); continue; }
      if (!entry.isFile()) throw new Error('Unexpected runtime file type');
      hash.update(JSON.stringify(name));
      hash.update(String(fs.statSync(join(directory, name)).size));
      const fd = fs.openSync(join(directory, name), 'r');
      try {
        let count;
        while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
      } finally { fs.closeSync(fd); }
    }
  }
  visit();
  return hash.digest('hex');
}

function selectRuntime(root, tempDir, env, run, log) {
  const require = createRequire(join(root, 'package.json'));
  let binary, version;
  try {
    binary = require('electron');
    version = require('electron/package.json').version;
  } catch { throw new Error('Dependencies are missing. Run npm.cmd install --package-lock=false first.'); }
  if (typeof binary !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(version) || !fs.existsSync(binary)) {
    throw new Error('The installed Electron runtime is incomplete. Reinstall dependencies.');
  }
  const source = dirname(binary);
  if (fs.readFileSync(join(source, 'version'), 'utf8').trim() !== version) throw new Error('Electron version mismatch');
  const probe = (exe) => {
    try { return run(exe, ['--version'], { cwd: root, env, windowsHide: true, stdio: 'ignore', timeout: 8000 }).status === 0; }
    catch { return false; }
  };
  if (probe(binary)) return dirname(binary);
  const digest = treeDigest(source);
  const receiptPath = join(root, 'logs', 'desktop-runtime.json');
  try {
    const cached = JSON.parse(fs.readFileSync(receiptPath, 'utf8')).runtimeDir;
    const actual = fs.realpathSync(cached);
    if (dirname(actual) === fs.realpathSync(tempDir) && basename(actual).startsWith(`ai-signal-electron-${version}-`) &&
        treeDigest(actual) === digest && probe(join(actual, basename(binary)))) return actual;
  } catch { /* Missing, changed or unsafe cache: create a separate copy without overwriting it. */ }
  log('[desktop] Preparing the same Electron version in TEMP; no download or permission changes.');
  const runtimeDir = fs.mkdtempSync(join(tempDir, `ai-signal-electron-${version}-`));
  fs.cpSync(source, runtimeDir, { recursive: true, errorOnExist: true, force: false });
  if (treeDigest(runtimeDir) !== digest || !probe(join(runtimeDir, basename(binary)))) throw new Error('Electron cannot run from TEMP. See the desktop validation guide.');
  fs.mkdirSync(dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, JSON.stringify({ runtimeDir, version }));
  return runtimeDir;
}

export async function runDesktopLaunch(options = {}) {
  const { root = projectRoot, tempDir = tmpdir(), nodeVersion = process.versions.node,
    env = process.env, args = [], run = spawnSync, log = console.log, error = console.error } = options;
  try {
    const [major, minor] = nodeVersion.split('.').map(Number);
    if (!(major > 22 || major === 22 && minor >= 5)) throw new Error('Node.js 22.5 or newer is required; Node.js 24 is recommended.');
    if (args.length && (args.length !== 1 || args[0] !== '--check')) throw new Error('Supported option: --check');
    const childEnv = { ...env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const runtimeDir = selectRuntime(root, tempDir, childEnv, run, log);
    childEnv.ELECTRON_OVERRIDE_DIST_PATH = runtimeDir;
    if (args[0] === '--check') {
      log(`[desktop] Check passed. Node ${nodeVersion}; runtime: ${runtimeDir}`);
      return 0;
    }
    const config = join(root, 'config.local.yaml');
    if (!fs.existsSync(config)) {
      try { fs.copyFileSync(join(root, 'config.desktop.example.yaml'), config, fs.constants.COPYFILE_EXCL); }
      catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
    }
    if (!fs.existsSync(join(root, 'dist/main/index.js')) || !fs.existsSync(join(root, 'dist/renderer/overlay.html'))) {
      log('[desktop] Building the missing application files...');
      const built = run(childEnv.ComSpec || 'cmd.exe', ['/d', '/c', 'npm.cmd run build'],
        { cwd: root, env: childEnv, windowsHide: true, stdio: 'inherit' });
      if (built.error || built.status !== 0) return built.status || 1;
      if (!fs.existsSync(join(root, 'dist/main/index.js')) || !fs.existsSync(join(root, 'dist/renderer/overlay.html'))) {
        throw new Error('Build completed without the required application files.');
      }
    }
    log('[desktop] Starting AI Signal with config.local.yaml. Minimize this window; exit from the tray.');
    const result = run(process.execPath, [join(root, 'scripts/start.mjs'), '--config', './config.local.yaml'],
      { cwd: root, env: childEnv, windowsHide: true, stdio: 'inherit' });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } catch (cause) {
    error(`[desktop] ${cause.message}`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runDesktopLaunch({ args: process.argv.slice(2) });
}
