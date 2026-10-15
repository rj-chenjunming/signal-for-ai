/**
 * 灯带视觉验收（程序化）—— 用无头 Chrome 读取**浏览器实际计算出的**样式。
 *
 * 为什么要这么做：04-SPEC §7.2 记着「沙箱无法真正起窗口，视觉呈现未验证」。
 * 而灯带是纯 CSS 的，把真实 shared.css 渲染进 Chrome，再读出
 * getComputedStyle 的结果，就能在没有桌面的情况下**真正验证**：
 *   - 每个状态的灯是不是真的呈现成对应颜色
 *   - 灯带布局是否竖排、总灯是否在上
 *   - 尺寸是否符合 D9（约 76px 宽、14px 小灯）
 *
 * 用法：
 *   node scripts/make-strip-preview.mjs          # 先生成预览页
 *   node scripts/verify-strip-visual.mjs         # 再用 Chrome 验收
 */
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const previewPath = join(root, 'deliverables', 'strip-preview.html');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (chrome === undefined) {
  console.log('⚠️ 找不到 Chrome/Edge，跳过视觉验收（不影响功能）');
  process.exit(0);
}
if (!existsSync(previewPath)) {
  console.error('❌ 预览页不存在，请先运行：node scripts/make-strip-preview.mjs');
  process.exit(1);
}

/**
 * 在页面里跑一段 JS，把结果通过 document.title 带回。
 * headless Chrome 的 --dump-dom 会输出最终 DOM，我们从标题里取 JSON。
 */
const probe = `
(() => {
  const out = { states: {}, layout: {}, single: {} };

  // 1) 七态色板：读每个 swatch 实际计算出的背景色
  for (const fig of document.querySelectorAll('.swatch')) {
    const dot = fig.querySelector('.strip-dot');
    const name = fig.querySelector('figcaption').childNodes[0].textContent.trim();
    const cs = getComputedStyle(dot);
    out.states[name] = { bg: cs.backgroundColor, w: cs.width, h: cs.height };
  }

  // 2) 灯带布局：取第一个场景
  const strip = document.querySelector('.scene .lamp-strip');
  if (strip) {
    const cs = getComputedStyle(strip);
    out.layout.flexDirection = cs.flexDirection;
    out.layout.width = strip.getBoundingClientRect().width;
    out.layout.rowsFlexDirection = getComputedStyle(strip.querySelector('.strip-rows')).flexDirection;
    // 总灯必须在第一行
    const kids = [...strip.children].map((k) => k.className);
    out.layout.childOrder = kids.join(' | ');
    const master = strip.querySelector('.strip-master-dot');
    const csm = getComputedStyle(master);
    out.layout.masterSize = csm.width;
    out.layout.masterRowBottom = strip.querySelector('.strip-master').getBoundingClientRect().bottom;
    out.layout.firstRowTop = strip.querySelector('.strip-row').getBoundingClientRect().top;
  }

  // 3) 单灯形态：读第一个 lamp-core
  const core = document.querySelector('.lamp-core .lamp-dot');
  if (core) {
    const cs = getComputedStyle(core);
    out.single.bg = cs.backgroundColor;
    out.single.borderRadius = cs.borderRadius;
  }

  // 4) 端口标签字号（D9：紧凑）
  const port = document.querySelector('.strip-port');
  if (port) {
    const cs = getComputedStyle(port);
    out.layout.portFontSize = cs.fontSize;
    out.layout.portColor = cs.color;
  }

  // 5) 小灯尺寸（D9：14px）
  const dot = document.querySelector('.scene .strip-row .strip-dot');
  if (dot) {
    out.layout.rowDotSize = getComputedStyle(dot).width;
  }

  document.title = 'PROBE:' + JSON.stringify(out);
})();
`;

// 把探针注入预览页（复制一份，不动产物）
const tmp = mkdtempSync(join(tmpdir(), 'strip-verify-'));
const probePage = join(tmp, 'probe.html');
const { readFileSync } = await import('node:fs');
const html = readFileSync(previewPath, 'utf8').replace('</body>', `<script>${probe}</script></body>`);
writeFileSync(probePage, html, 'utf8');

let dom;
try {
  dom = execFileSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--virtual-time-budget=2500',
      '--dump-dom',
      `file:///${probePage.replace(/\\/gu, '/')}`,
    ],
    { encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const matched = /PROBE:(\{.*?\})<\/title>/su.exec(dom) ?? /PROBE:(\{.*\})/su.exec(dom);
if (!matched) {
  console.error('❌ 无法从页面取回探针结果');
  console.error(dom.slice(0, 800));
  process.exit(1);
}
const result = JSON.parse(matched[1]);

// ---------------------------------------------------------------------------
// 期望色值（来自 shared.css :root 的 --status-*，运维时可核对）
// ---------------------------------------------------------------------------
const EXPECTED_RGB = {
  idle: 'rgb(107, 114, 128)',
  starting: 'rgb(147, 197, 253)',
  running: 'rgb(59, 130, 246)',
  waiting: 'rgb(245, 158, 11)',
  success: 'rgb(34, 197, 94)',
  failed: 'rgb(239, 68, 68)',
  unknown: 'rgb(75, 85, 99)',
};

const checks = [];
const check = (name, cond, detail = '') => {
  checks.push({ name, cond, detail });
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`);
};

console.log('=== 1. 七态色值：浏览器实际计算出的颜色 ===');
for (const [state, expected] of Object.entries(EXPECTED_RGB)) {
  const got = result.states[state]?.bg;
  check(`${state.padEnd(9)} → ${expected}`, got === expected, got === expected ? '' : `实际 ${String(got)}`);
}

console.log('\n=== 2. 灯带布局（D6/D9）===');
check('灯带是竖排', result.layout.flexDirection === 'column', String(result.layout.flexDirection));
check('端口行内部也是竖排', result.layout.rowsFlexDirection === 'column', String(result.layout.rowsFlexDirection));
check(
  '总灯在端口行之上',
  typeof result.layout.masterRowBottom === 'number'
    && typeof result.layout.firstRowTop === 'number'
    && result.layout.masterRowBottom <= result.layout.firstRowTop,
  `masterBottom=${result.layout.masterRowBottom} firstRowTop=${result.layout.firstRowTop}`,
);
check('子节点顺序是 总灯 → 端口行', /strip-master.*strip-rows/u.test(String(result.layout.childOrder ?? '')), String(result.layout.childOrder));
check('整窗宽度紧凑（< 140px）', Number(result.layout.width) < 140, `${Math.round(Number(result.layout.width))}px`);
check('小灯 14px（D9）', result.layout.rowDotSize === '14px', String(result.layout.rowDotSize));
check('总灯 16px（略大于端口灯）', result.layout.masterSize === '16px', String(result.layout.masterSize));
check('端口标签 10px（紧凑）', result.layout.portFontSize === '10px', String(result.layout.portFontSize));

console.log('\n=== 3. 单灯形态（任务数 < 2 时退回）===');
check('单灯是圆形', result.single.borderRadius === '50%', String(result.single.borderRadius));
check('单灯渲染出真实颜色（非透明）', typeof result.single.bg === 'string' && !result.single.bg.includes('rgba(0, 0, 0, 0)'), String(result.single.bg));

const failed = checks.filter((c) => !c.cond);
console.log(`\n${failed.length === 0 ? `✅ 视觉验收全部通过（${checks.length} 项）` : `❌ ${failed.length}/${checks.length} 项失败`}`);
process.exit(failed.length === 0 ? 0 : 1);
