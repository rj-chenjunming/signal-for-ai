/**
 * 生成灯带的静态预览页（用**项目真实的 shared.css**），用于视觉验收。
 *
 * 为什么需要它：Electron 窗口在无桌面/沙箱环境起不来（04-SPEC §7.2 记录过
 * 「托盘/悬浮灯的视觉呈现：沙箱无法真正起窗口」）。但灯带是纯 CSS 的，
 * 把它渲染进一个普通网页再用无头浏览器截图，就能真正看到效果 ——
 * 而不是靠读 CSS 猜。
 *
 * 用法：
 *   node node_modules/typescript/bin/tsc -p tsconfig.electron.json
 *   node scripts/make-strip-preview.mjs
 * 产物：deliverables/strip-preview.html
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const css = readFileSync(join(root, 'src', 'renderer', 'shared.css'), 'utf8');
const overlayHtml = readFileSync(join(root, 'src', 'renderer', 'overlay.html'), 'utf8');

/** 七态 → 视觉元数据，必须与 src/renderer/overlay.ts 的 STATUS_VISUAL 保持一致。 */
const STATUS_VISUAL = {
  idle: { colorVar: '--status-idle', animClass: 'anim-steady', label: '空闲' },
  starting: { colorVar: '--status-starting', animClass: 'anim-breathe-slow', label: '启动中' },
  running: { colorVar: '--status-running', animClass: 'anim-breathe', label: '运行中' },
  waiting: { colorVar: '--status-waiting', animClass: 'anim-blink-fast', label: '等待授权' },
  success: { colorVar: '--status-success', animClass: 'anim-flash-once', label: '已完成' },
  failed: { colorVar: '--status-failed', animClass: 'anim-alarm', label: '失败' },
  unknown: { colorVar: '--status-unknown', animClass: 'anim-steady', label: '失联' },
};

/** 造一个灯带场景：总灯 + 若干端口行。 */
function stripScene(title, masterStatus, ports) {
  const rows = ports
    .map((p) => {
      const v = STATUS_VISUAL[p.status];
      return `
      <div class="strip-row" data-status="${p.status}">
        <div class="strip-dot" style="background-color: var(${v.colorVar});" class="${v.animClass}"></div>
        <span class="strip-port">${p.label}</span>
      </div>`;
    })
    .join('');

  const mv = STATUS_VISUAL[masterStatus];
  const badge =
    ports.filter((p) => p.status === 'running').length > 0
      ? `<div class="lamp-badge" style="position:static;margin-left:2px;">${ports.filter((p) => p.status === 'running').length}</div>`
      : '';

  return `
  <figure class="scene">
    <div class="lamp-strip">
      <div class="strip-master">
        <div class="strip-master-dot ${mv.animClass}" style="background-color: var(${mv.colorVar});"></div>
        <span class="strip-master-label">${mv.label}</span>
        ${badge}
      </div>
      <div class="strip-rows">${rows}</div>
    </div>
    <figcaption>${title}</figcaption>
  </figure>`;
}

// ---- 场景定义：覆盖 PRD 最关心的几种真实情形 ----
const scenes = [
  stripScene('全空闲', 'idle', [
    { label: '3080', status: 'idle' },
    { label: '13080', status: 'idle' },
  ]),
  stripScene('一个端口在跑', 'running', [
    { label: '3080', status: 'running' },
    { label: '13080', status: 'idle' },
  ]),
  stripScene('★ 卡住等你授权（PRD 第一痛点）', 'waiting', [
    { label: '3080', status: 'waiting' },
    { label: '13080', status: 'running' },
  ]),
  stripScene('一个崩了', 'failed', [
    { label: '3080', status: 'failed' },
    { label: '13080', status: 'running' },
    { label: '13081', status: 'idle' },
  ]),
  stripScene('隧道实例失联', 'unknown', [
    { label: '3080', status: 'running' },
    { label: '13080', status: 'unknown' },
  ]),
  stripScene('多端口混合（真实形态）', 'waiting', [
    { label: '3080', status: 'running' },
    { label: '13080', status: 'waiting' },
    { label: '13081', status: 'success' },
    { label: 'dsh-plugin', status: 'idle' },
    { label: 'remote-7', status: 'unknown' },
  ]),
];

// ---- 七态色板（逐态单灯，用于核对颜色） ----
const palette = Object.entries(STATUS_VISUAL)
  .map(
    ([status, v]) => `
    <figure class="swatch">
      <div class="strip-dot ${v.animClass}" style="background-color: var(${v.colorVar});width:22px;height:22px;"></div>
      <figcaption>${status}<br /><small>${v.label}</small></figcaption>
    </figure>`,
  )
  .join('');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>多端口 dsh 指示灯 · 灯带预览</title>
<style>
${css}

/* ---- 预览页专属样式（不属于产品，只用于排版截图） ---- */
body.preview {
  margin: 0;
  padding: 28px 32px 40px;
  background: #0f172a;
  color: #e2e8f0;
  font: 13px/1.5 ui-sans-serif, system-ui, "Segoe UI", sans-serif;
}
h1 { font-size: 17px; margin: 0 0 4px; font-weight: 650; }
h2 { font-size: 13px; margin: 30px 0 12px; color: #94a3b8; font-weight: 600;
     text-transform: uppercase; letter-spacing: .06em; }
.hint { color: #94a3b8; margin: 0 0 6px; font-size: 12px; }
.row { display: flex; flex-wrap: wrap; gap: 26px; align-items: flex-start; }
.scene { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 10px; }
.scene figcaption { font-size: 11px; color: #94a3b8; max-width: 190px; text-align: center; }
.swatch { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 8px; width: 84px; }
.swatch figcaption { font-size: 11px; color: #cbd5e1; text-align: center; line-height: 1.35; }
.swatch small { color: #64748b; }
/* 预览页里让灯带不要被 body 的 flex 拉伸 */
.lamp-strip { width: auto; }
</style>
</head>
<body class="preview">
  <h1>多端口 dsh 指示灯 · 灯带视觉验收</h1>
  <p class="hint">
    本页使用项目真实的 <code>src/renderer/shared.css</code> 与
    <code>overlay.html</code> 中的灯带结构，色值全部来自 <code>--status-*</code> 变量。
  </p>

  <h2>七态色板</h2>
  <div class="row">${palette}</div>

  <h2>灯带场景（总灯 + 每端口一行）</h2>
  <div class="row">${scenes.join('')}</div>

  <h2>单灯形态（任务数 &lt; 2 时退回）</h2>
  <div class="row">
    <figure class="scene">
      <div class="lamp-core" style="width:28px;height:28px;">
        <div class="lamp-dot anim-breathe" style="background-color: var(--status-running);"></div>
        <div class="lamp-badge">2</div>
      </div>
      <figcaption>运行中（带运行数量徽标）</figcaption>
    </figure>
    <figure class="scene">
      <div class="lamp-core" style="width:28px;height:28px;">
        <div class="lamp-dot anim-blink-fast" style="background-color: var(--status-waiting);"></div>
      </div>
      <figcaption>等待授权</figcaption>
    </figure>
    <figure class="scene">
      <div class="lamp-core" style="width:28px;height:28px;">
        <div class="lamp-dot anim-alarm" style="background-color: var(--status-failed);"></div>
      </div>
      <figcaption>失败</figcaption>
    </figure>
  </div>
</body>
</html>
`;

const outDir = join(root, 'deliverables');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'strip-preview.html');
writeFileSync(outPath, html, 'utf8');

// 顺带报告 overlay.html 的结构是否与预览一致（防两处漂移）
const hasStrip = overlayHtml.includes('id="lamp-strip"');
const hasRows = overlayHtml.includes('id="strip-rows"');
const hasMaster = overlayHtml.includes('id="strip-master-dot"');
console.log(`预览已生成：${outPath}`);
console.log(`overlay.html 结构自检：lamp-strip=${hasStrip} strip-rows=${hasRows} strip-master-dot=${hasMaster}`);
console.log(`场景数：${scenes.length}，色板数：${Object.keys(STATUS_VISUAL).length}`);
process.exit(hasStrip && hasRows && hasMaster ? 0 : 1);
