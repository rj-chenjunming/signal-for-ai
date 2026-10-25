import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// 2026-10-24 本机实测：Electron 33.4.11 初始化崩溃（见 check-ui.mjs 同款注释）；
// AITI_ELECTRON 可指定验证用 Electron 二进制，缺省为仓库 pin 版本。
const electronPath = env.AITI_ELECTRON || require('electron');
const child = spawn(electronPath, [
  fileURLToPath(new URL('./goals-window-check.cjs', import.meta.url)),
  '--disable-gpu', '--disable-software-rasterizer', '--disable-gpu-compositing', '--in-process-gpu',
], { env, windowsHide: true, stdio: 'inherit' });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
