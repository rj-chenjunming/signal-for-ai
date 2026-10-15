/**
 * 渲染层静态资源复制脚本。
 *
 * 依赖: 仅 Node 内置模块（无第三方依赖）。
 * 用途: tsc 只产出 .js，HTML / CSS 需要原样复制到 dist/renderer/ 供 BrowserWindow 以 file:// 加载。
 * 说明: 架构 D2 决策「tsc 直编 + 静态复制」，刻意不引入 Vite，因此需要这一步。
 */
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDir, '..');
const rendererSrc = join(projectRoot, 'src', 'renderer');
const rendererCompiled = join(projectRoot, 'dist-renderer', 'renderer');
const rendererOut = join(projectRoot, 'dist', 'renderer');

if (!existsSync(rendererCompiled)) {
  console.error('[copy-renderer] 未找到 tsc 产物，请先执行 `npm run build:renderer`');
  process.exit(1);
}

mkdirSync(rendererOut, { recursive: true });

// 1) 复制编译产物（.js / .js.map）
//用 cpSync 的 force 默认值（已存在则覆盖），**不做先删后拷**。
// 原因：删除整个目录在受限环境（带删除守卫的沙箱/容器）会直接失败，
// 而 Electron 加载的是 dist/renderer/，里面只需要"最新一份"，
// 覆盖写已足够，跳过删除反而让构建在更多环境下能跑通。
cpSync(rendererCompiled, rendererOut, { recursive: true, force: true });

// 2) 复制静态资源（.html / .css）
for (const file of ['overlay.html', 'panel.html', 'shared.css']) {
  const from = join(rendererSrc, file);
  if (existsSync(from)) {
    cpSync(from, join(rendererOut, file), { force: true });
  } else {
    console.warn(`[copy-renderer] 缺少静态资源: ${file}`);
  }
}

// 3) 写一份构建标记，方便排查"跑的是不是旧产物"
writeFileSync(
  join(rendererOut, '.build-stamp'),
  new Date().toISOString(),
  'utf8',
);

console.log(`[copy-renderer] 渲染层资源已就绪-> ${rendererOut}`);
