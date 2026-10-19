/**
 * 启动器 —— 在 Electron 拉起之前清理会破坏 GUI 的环境变量。
 *
 * 【为什么需要这个脚本】
 * `ELECTRON_RUN_AS_NODE=1` 会让 electron.exe 退化成普通 Node 解释器：
 * 传入的 .js 被当脚本跑、`require('electron')` 返回空对象，
 * 主进程第一行 `app.requestSingleInstanceLock()` 就抛
 * `TypeError: Cannot read properties of undefined (reading 'requestSingleInstanceLock')`。
 *
 * 关键点：Electron 在**启动早期**就把该变量读进内部状态，
 * 因此在 main 进程里 `delete process.env.ELECTRON_RUN_AS_NODE` 已经太晚（实测无效）。
 * 唯一可靠的做法是在 spawn 之前、从父进程的环境里剔除。
 *
 * 另外若干 CI / 容器 / IDE 内置终端会预设这个变量，
 * 导致「双击图标能开、`npm start` 却静默失败」这种极难排查的现象。
 *
 * 用法：
 *   node scripts/start.mjs [-- <electron 参数...>]
 * 例：
 *   node scripts/start.mjs
 *   node scripts/start.mjs -- --config ./config.demo.yaml
 *   node scripts/start.mjs -- --enable-gpu      # 需要硬件加速时
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDir, '..');

/** 解析 electron 可执行文件路径（走 electron 包自己的 path.txt） */
function resolveElectronBin() {
  // 优先用 electron 包的入口，它会读 node_modules/electron/path.txt
  const electronPath = require('electron');
  if (typeof electronPath === 'string' && electronPath) {
    return electronPath;
  }
  // 某些环境下 require('electron') 返回二进制路径，部分返回路径文本
  const pathTxt = join(projectRoot, 'node_modules', 'electron', 'path.txt');
  return require('node:fs').readFileSync(pathTxt, 'utf8').trim();
}

// npm 会消耗自身的 --，因此直接参数也要转发；保留旧的显式分隔符调用。
const argv = process.argv.slice(2);
const passthrough = argv.includes('--') ? argv.slice(argv.indexOf('--') + 1) : argv;

/**
 * 组装子进程环境：剔除会破坏 GUI 的变量。
 * 注意不能直接把 process.env 原样传过去。
 */
const childEnv = { ...process.env };
let cleaned = false;
if (childEnv.ELECTRON_RUN_AS_NODE === '1') {
  delete childEnv.ELECTRON_RUN_AS_NODE;
  cleaned = true;
}

if (cleaned) {
  console.log('[start] 已剔除 ELECTRON_RUN_AS_NODE=1（该变量会让托盘/悬浮灯无法创建）');
}

/**
 * 控制台中文乱码处理。
 *
 * 【实测现象】Windows 控制台默认代码页是 GBK(cp936)，
 * 应用日志全是中文，于是显示成「杩涚▼鏋氫妇...」这种乱码。
 *
 * 【踩过的弯路】先试过设 ELECTRON_ENABLE_UTF8 / PYTHONIOENCODING 等环境变量，
 * 全部无效—— 因为编码转换发生在 Node 把字节写向控制台的那一刻，
 * 由父进程的 stdio 处理，与子进程环境变量无关。
 *
 * 【真正有效的做法】把启动器自身的 stdout 显式绑定为 UTF-8。
 * 这样本脚本 print 的中文正常；Electron 子进程继承同一个 stdio，
 * 其中文日志也能正确落到控制台。
 *
 * 若仍乱码，让用户执行 `chcp 65001` 切换控制台代码页即可
 * （这里不擅自改全局代码页，避免影响用户其他终端）。
 */
if (process.platform === 'win32') {
  // Electron 子进程需要 stdout，stdio: 'inherit' 时会自动继承
  childEnv.ELECTRON_ENABLE_LOGGING = childEnv.ELECTRON_ENABLE_LOGGING ?? '1';

  //检测控制台代码页是否为 UTF-8；不是则提示用户。
  // 只提示不改：擅自 `chcp 65001` 会影响用户同窗口内的其他程序。
  const codePage = childEnv.CHCP ?? '';
  if (codePage && codePage !== '65001') {
    console.log(
      '[start] 提示：若下方中文日志显示为乱码（如「杩涚▼」），' +
        '执行 `chcp 65001` 后重试即可。日志文件本身始终是 UTF-8，不受影响。',
    );
  }
}

/**
 * GPU 参数兜底。
 *
 * 【实测坑】只调 app.disableHardwareAcceleration() 在部分无显卡环境
 * 仍不够 —— Chromium 仍会拉起 GPU 进程并因 0xC0000409 崩溃，
 * 最终 FATAL: GPU process isn't usable. Goodbye. 整个应用静默退出。
 *
 * 必须在命令行层面加 --disable-gpu / --disable-software-rasterizer /
 * --disable-gpu-compositing / --in-process-gpu 才彻底稳定。
 *
 * 本应用是纯 2D UI（几个圆点 + 文字），关掉 GPU 完全无损。
 * 用户若显式传了 --enable-gpu 则尊重之（用于排查渲染问题）。
 */
const wantsGpu = passthrough.includes('--enable-gpu');
const GPU_FLAGS = [
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-gpu-compositing',
  '--in-process-gpu',
];
const extraFlags = wantsGpu ? [] : GPU_FLAGS;
if (!wantsGpu) {
  console.log('[start] 已禁用 GPU 加速（本应用为纯 2D UI，无损；如需排查渲染问题可加 --enable-gpu）');
}

let bin;
try {
  bin = resolveElectronBin();
} catch (err) {
  console.error('[start] 找不到 Electron 可执行文件。');
  console.error('  若尚未安装，请先运行：npm install');
  console.error(`  原始错误：${err.message}`);
  process.exit(1);
}

console.log(`[start] 启动 ${bin} . ${[...extraFlags, ...passthrough].join(' ')}`);

const child = spawn(bin, ['.', ...extraFlags, ...passthrough], {
  cwd: projectRoot,
  env: childEnv,
  stdio: 'inherit',
  // Windows 下不加 detached，应用退出后不留孤儿进程
  windowsHide: false,
});

child.on('error', (err) => {
  console.error(`[start] Electron 启动失败：${err.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.log(`[start] 应用因信号 ${signal} 退出`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
