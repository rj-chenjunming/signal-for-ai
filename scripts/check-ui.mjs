import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// SPEC-039：曾因仓库根 ACL 毒化临时加过 --no-sandbox 并借 AITI_ELECTRON 跑 31；
// ACL 解毒后夹具已回归 pin 版（默认沙箱），AITI_ELECTRON 仅作应急通道保留。
const electronPath = env.AITI_ELECTRON || require('electron');
const child = spawn(electronPath, [
  fileURLToPath(new URL('./ui-render-check.cjs', import.meta.url)),
  '--disable-gpu', '--disable-software-rasterizer', '--disable-gpu-compositing', '--in-process-gpu',
], { env, windowsHide: true, stdio: 'inherit' });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
