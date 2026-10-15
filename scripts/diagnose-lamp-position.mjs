/**
 * 诊断：悬浮灯窗口在哪个显示器上、离各边多远？
 *
 * 用于排查"圆点被割掉"到底是 CSS 裁剪还是**窗口被屏幕边缘切掉**。
 * 后者在多显示器下很常见：窗口定位用了错误的显示器范围。
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const require = createRequire(import.meta.url);

// 用 Node 侧无法拿 electron 的 screen；改从 CDP 问渲染进程。
// 渲染进程的 window.screen 反映的是它所在显示器的信息。
const res = await fetch('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(4_000) });
const targets = await res.json();
const page = targets.find((t) => typeof t.url === 'string' && t.url.includes('overlay.html'));
if (page === undefined) {
  console.error('需要带 --remote-debugging-port=9222 启动');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok, no) => {
  ws.addEventListener('open', ok, { once: true });
  ws.addEventListener('error', () => no(new Error('ws')), { once: true });
});
let id = 1;
const call = (method, params = {}) =>
  new Promise((ok, no) => {
    const myId = id++;
    const on = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== myId) return;
      ws.removeEventListener('message', on);
      m.error ? no(new Error(JSON.stringify(m.error))) : ok(m.result);
    };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

const r = await call('Runtime.evaluate', {
  expression: 'JSON.stringify({sw:screen.width,sh:screen.height,aw:screen.availWidth,ah:screen.availHeight,ax:screen.availLeft,ay:screen.availTop,iw:innerWidth,ih:innerHeight,ox:screenX,oy:screenY,ow:outerWidth,oh:outerHeight,dpr:devicePixelRatio})',
  returnByValue: true,
});

// ---------------------------------------------------------------------------
// 同时检查"容器裁剪"—— 与屏幕边界是两套完全不同的机制，必须分开看
// ---------------------------------------------------------------------------
const CLIP = String.raw`
(() => {
  const out = { dots: [], rowsScroll: null };
  const rows = document.querySelector('.strip-rows');
  if (rows) {
    const cs = getComputedStyle(rows);
    out.rowsScroll = {
      clientW: rows.clientWidth, scrollW: rows.scrollWidth,
      clientH: rows.clientHeight, scrollH: rows.scrollHeight,
      overflowX: cs.overflowX, overflowY: cs.overflowY,
      padL: cs.paddingLeft, padR: cs.paddingRight,
      horizontalScrollable: rows.scrollWidth > rows.clientWidth,
      verticalScrollable: rows.scrollHeight > rows.clientHeight,
    };
  }
  // 每个圆点：相对其最近裁剪祖先（.strip-rows）的位置
  for (const el of document.querySelectorAll('.strip-dot, .strip-master-dot')) {
    const rc = el.getBoundingClientRect();
    // box-shadow 向外扩散：解析出真实占位
    const raw = getComputedStyle(el).boxShadow;
    let grow = 0;
    if (raw && raw !== 'none') {
      const parts = raw.replace(/rgba?\([^)]*\)/g, 'C').split(/,(?![^(]*\))/);
      for (const p of parts) {
        const nums = p.match(/-?[\d.]+px/g);
        if (nums && nums.length >= 3) {
          grow = Math.max(grow, parseFloat(nums[2]) + (nums[3] ? parseFloat(nums[3]) : 0));
        }
      }
    }
    const parent = el.closest('.strip-rows') || el.closest('.lamp-strip');
    let rel = null;
    if (parent) {
      const pr = parent.getBoundingClientRect();
      const pcs = getComputedStyle(parent);
      // 裁剪边 = padding box（overflow 非 visible 时）
      const clipL = pr.left + parseFloat(pcs.borderLeftWidth);
      const clipR = pr.right - parseFloat(pcs.borderRightWidth);
      rel = {
        parent: '.' + String(parent.className).split(' ')[0],
        dotL: +(rc.left - clipL).toFixed(1),
        dotR: +(clipR - rc.right).toFixed(1),
        shadowOutsideLeft: +(grow - (rc.left - clipL)).toFixed(1),
        shadowOutsideRight: +(grow - (clipR - rc.right)).toFixed(1),
      };
    }
    out.dots.push({ cls: String(el.className), w: +rc.width.toFixed(2), left: +rc.left.toFixed(1), rel });
  }
  return JSON.stringify(out, null, 2);
})()
`;
const clipRes = await call('Runtime.evaluate', { expression: CLIP, returnByValue: true });
ws.close();

const clip = JSON.parse(clipRes.result.value);
console.log('\n=== .strip-rows 滚动状态（overflow 容器会不会裁）===');
const rs = clip.rowsScroll;
if (rs) {
  console.log(`  client ${rs.clientW}x${rs.clientH}   scroll ${rs.scrollW}x${rs.scrollH}`);
  console.log(`  overflow: x=${rs.overflowX}  y=${rs.overflowY}   padding: ${rs.padL}/${rs.padR}`);
  console.log(`  可横向滚动: ${rs.horizontalScrollable}   可纵向滚动: ${rs.verticalScrollable}`);
  if (rs.horizontalScrollable) console.log('  ⚠️ 横向溢出 -> 出现水平滚动条，会挤掉内容宽度！');
}

console.log('\n=== 圆点相对裁剪边（.strip-rows 的 padding box）===');
console.log('  元素                    宽     距左   距右   阴影超出左/右');
for (const d of clip.dots) {
  const rel = d.rel;
  console.log(
    `  ${d.cls.slice(0, 22).padEnd(24)} ${String(d.w).padStart(5)}  ` +
      `${rel ? String(rel.dotL).padStart(6) : '   -  '} ${rel ? String(rel.dotR).padStart(6) : '   -  '}  ` +
      `${rel ? `${rel.shadowOutsideLeft} / ${rel.shadowOutsideRight}` : ''}`,
  );
}
const overLeft = clip.dots.filter((d) => d.rel && d.rel.shadowOutsideLeft > 0);
const overRight = clip.dots.filter((d) => d.rel && d.rel.shadowOutsideRight > 0);
console.log('');
if (overLeft.length > 0) console.log(`  ❌ ${overLeft.length} 个圆点的阴影超出容器左边 ${overLeft[0].rel.shadowOutsideLeft}px（会被裁）`);
if (overRight.length > 0) console.log(`  ❌ ${overRight.length} 个圆点的阴影超出容器右边 ${overRight[0].rel.shadowOutsideRight}px（会被裁）`);
if (overLeft.length === 0 && overRight.length === 0) console.log('  ✅ 圆点阴影都在容器裁剪边之内');


const s = JSON.parse(r.result.value);
console.log('=== 渲染进程看到的显示器信息 ===');
console.log(`  screen        : ${s.sw} x ${s.sh}`);
console.log(`  availArea     : ${s.aw} x ${s.ah}  @(${s.ax}, ${s.ay})`);
console.log(`  窗口视口      : ${s.iw} x ${s.ih}`);
console.log(`  窗口外框      : ${s.ow} x ${s.oh}  @(${s.ox}, ${s.oy})`);
console.log(`  devicePixelRatio: ${s.dpr}`);
console.log('');
console.log('=== 窗口相对该显示器可用区的位置 ===');
console.log(`  距左 : ${s.ox - s.ax} px`);
console.log(`  距右 : ${s.ax + s.aw - (s.ox + s.ow)} px`);
console.log(`  距上 : ${s.oy - s.ay} px`);
console.log(`  距下 : ${s.ay + s.ah - (s.oy + s.oh)} px`);
if (s.ox < s.ax) console.log(`  ⚠️ 左边被屏幕裁掉 ${s.ax - s.ox}px`);
if (s.oy < s.ay) console.log(`  ⚠️ 上边被屏幕裁掉 ${s.ay - s.oy}px`);
