/**
 * 精确测量正在运行的悬浮灯：各元素的边界框与是否溢出窗口。
 *
 * 用于定位"圆圈显示不完整"这类问题 —— 光看颜色对了不够，
 * 得看它有没有被父容器的边界裁掉。
 *
 * 用法（应用需带 --remote-debugging-port=9222 启动）：
 *   node scripts/measure-live-lamp.mjs
 */
const res = await fetch('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(5_000) });
const targets = await res.json();
const page = targets.find((t) => typeof t.url === 'string' && t.url.includes('overlay.html'));
if (page === undefined) {
  console.error('找不到 overlay 页面');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('WS 连接失败')), { once: true });
});
let nextId = 1;
const call = (method, params = {}) => {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== id) return;
      ws.removeEventListener('message', onMsg);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
};

const EXPR = String.raw`
(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      sel,
      x: +r.x.toFixed(1), y: +r.y.toFixed(1),
      w: +r.width.toFixed(1), h: +r.height.toFixed(1),
      display: cs.display, overflow: cs.overflow,
      appRegion: cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region'),
      flex: cs.flex, alignSelf: cs.alignSelf,
    };
  };
  return JSON.stringify({
    viewport: { w: innerWidth, h: innerHeight },
    els: [
      '.lamp-stage', '.lamp-drag', '.lamp-core', '#lamp-strip',
      '.strip-master', '#strip-master-dot', '.strip-master-label',
      '.strip-rows', '.strip-row', '.strip-dot', '.strip-port',
    ].map(pick).filter(Boolean),
  }, null, 2);
})()
`;

const r = await call('Runtime.evaluate', { expression: EXPR, returnByValue: true });
const data = JSON.parse(r.result.value);

// ---------------------------------------------------------------------------
// 第三段：★ 检查 box-shadow 是否被裁
// ---------------------------------------------------------------------------
// 这是之前漏掉的一层：只看 getBoundingClientRect 会以为"都在窗口内"，
// 但 box-shadow 画在 border box **之外**，窗口/滚动容器会把它们切掉 ——
// 表现正是"圆圈显示不完整"。
const SHADOW = String.raw`
(() => {
  const out = { dots: [], clips: [] };

  /** 解析 box-shadow，算出它向外扩散的像素范围 */
  const shadowExtent = (cs) => {
    const raw = cs.boxShadow;
    if (!raw || raw === 'none') return { top: 0, bottom: 0, left: 0, right: 0 };
    let top = 0, bottom = 0, left = 0, right = 0;
    const parts = raw.replace(/rgba?\([^)]*\)/g, 'C').split(/,(?![^(]*\))/);
    for (const p of parts) {
      const nums = p.match(/-?[\d.]+px/g);
      if (!nums || nums.length < 3) continue;
      const ox = parseFloat(nums[0]);
      const oy = parseFloat(nums[1]);
      const blur = parseFloat(nums[2]);
      const spread = nums[3] !== undefined ? parseFloat(nums[3]) : 0;
      const grow = blur + spread;
      top = Math.max(top, grow - oy);
      bottom = Math.max(bottom, grow + oy);
      left = Math.max(left, grow - ox);
      right = Math.max(right, grow + ox);
    }
    return { top: Math.ceil(top), bottom: Math.ceil(bottom), left: Math.ceil(left), right: Math.ceil(right) };
  };

  const vw = innerWidth, vh = innerHeight;

  for (const sel of ['.strip-dot', '.strip-master-dot']) {
    for (const el of document.querySelectorAll(sel)) {
      const rc = el.getBoundingClientRect();
      const ext = shadowExtent(getComputedStyle(el));
      const box = {
        top: rc.top - ext.top,
        bottom: rc.bottom + ext.bottom,
        left: rc.left - ext.left,
        right: rc.right + ext.right,
      };
      out.dots.push({ sel, cls: el.className, ext });
      const clipped = {
        top: box.top < 0 ? +(0 - box.top).toFixed(1) : 0,
        bottom: box.bottom > vh ? +(box.bottom - vh).toFixed(1) : 0,
        left: box.left < 0 ? +(0 - box.left).toFixed(1) : 0,
        right: box.right > vw ? +(box.right - vw).toFixed(1) : 0,
      };
      if (clipped.top || clipped.bottom || clipped.left || clipped.right) {
        out.clips.push({ sel, cls: el.className, clipped, box });
      }
    }
  }

  for (const el of document.querySelectorAll('.strip-rows, .lamp-strip')) {
    const cs = getComputedStyle(el);
    out.clips.push({
      sel: '.' + String(el.className).split(' ')[0],
      overflow: cs.overflowY,
      note: cs.overflowY === 'visible' ? '不裁剪' : '会裁剪子元素的阴影',
      paddingTop: cs.paddingTop,
      paddingBottom: cs.paddingBottom,
      paddingLeft: cs.paddingLeft,
      paddingRight: cs.paddingRight,
      // 滚动容器：圆点相对其**裁剪边**的距离（内边距区不算被裁）
      dots: [...el.querySelectorAll('.strip-dot, .strip-master-dot')].map((d) => {
        const dr = d.getBoundingClientRect();
        const er = el.getBoundingClientRect();
        const dcs = getComputedStyle(d);
        let grow = 0;
        const raw = dcs.boxShadow;
        if (raw && raw !== 'none') {
          for (const p of raw.replace(/rgba?\([^)]*\)/g, 'C').split(/,(?![^(]*\))/)) {
            const nums = p.match(/-?[\d.]+px/g);
            if (nums && nums.length >= 3) {
              grow = Math.max(grow, parseFloat(nums[2]) + (nums[3] ? parseFloat(nums[3]) : 0));
            }
          }
        }
        return {
          cls: String(d.className),
          distL: +(dr.left - er.left).toFixed(1),
          distR: +(er.right - dr.right).toFixed(1),
          overL: +(grow - (dr.left - er.left)).toFixed(1),
          overR: +(grow - (er.right - dr.right)).toFixed(1),
        };
      }),
    });
  }
  return JSON.stringify(out, null, 2);
})()
`;
const sh = await call('Runtime.evaluate', { expression: SHADOW, returnByValue: true });

const shadow = JSON.parse(sh.result.value);
console.log('\n=== ★ 投影裁剪检查（box-shadow 画在 border box 之外）===');
const first = shadow.dots[0];
if (first) {
  const e = first.ext;
  console.log(
    `  单个小圆点的 box-shadow 向外扩散：上 ${e.top} / 下 ${e.bottom} / 左 ${e.left} / 右 ${e.right} px`,
  );
}
const dotClips = shadow.clips.filter((c) => c.clipped);
if (dotClips.length === 0) {
  console.log('  ✅ 没有任何圆点的投影被窗口裁掉（四边都检查了）');
} else {
  console.log(`  ❌ ${dotClips.length} 个圆点的投影被窗口裁掉：`);
  for (const c of dotClips.slice(0, 8)) {
    // 明确报出是哪一边被裁多少 —— 只说"被裁"很难定位
    const sides = Object.entries(c.clipped)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${{ top: '上', bottom: '下', left: '左', right: '右' }[k]} ${v}px`)
      .join('、');
    console.log(`     ${c.cls || c.sel}: ${sides}`);
  }
}
console.log('  滚动容器裁剪行为：');
for (const c of shadow.clips.filter((x) => x.overflow !== undefined)) {
  console.log(
    `     ${String(c.sel).padEnd(14)} overflow-y=${String(c.overflow).padEnd(8)} ${c.note}  ` +
      `padding=${c.paddingTop}/${c.paddingRight}/${c.paddingBottom}/${c.paddingLeft}`,
  );
  // overflow 容器会裁掉超出裁剪边的阴影 —— 水平方向最容易漏
  for (const d of c.dots ?? []) {
    // ★ `overflow: visible` 的容器**根本不裁剪**子元素的阴影 ——
    // 此时"阴影超出内边距"不是问题（留白只是审美），报出来会把
    // 点阵形态这种"贴边留白很小"的正常布局误判成"被裁"。
    // 这个误报真实出现过：点阵形态 `.strip-rows` 的 padding 归零后刷出 4 个假 ❌。
    if (c.overflow === 'visible') {
      continue;
    }
    if (d.overL > 0 || d.overR > 0) {
      console.log(
        `        ❌ ${d.cls}: 阴影超出裁剪边 ${d.overL > 0 ? `左 ${d.overL}px` : ''}` +
          `${d.overR > 0 ? `${d.overL > 0 ? '、' : ''}右 ${d.overR}px` : ''}`,
      );
      dotClips.push({ cls: d.cls, clipped: { left: Math.max(0, d.overL), right: Math.max(0, d.overR) } });
    }
  }
}
if ((shadow.clips.filter((x) => x.overflow !== undefined).flatMap((c) => c.dots ?? [])).length > 0) {
  const anyOver = shadow.clips
    .filter((x) => x.overflow !== undefined)
    .flatMap((c) => c.dots ?? [])
    .some((d) => d.overL > 0 || d.overR > 0);
  if (!anyOver) console.log('     ✅ 圆点阴影都在容器裁剪边之内（含左右）');
}

// 第二段：让页面自己报告"内容自然需要多大"
// 方法：克隆灯带 -> 脱离 flex 约束 -> 用 scrollHeight 量真实内容高度。
// 光靠"算的"容易和 CSS 实际值差几像素（这个 bug 就是这么来的）。
const NATURAL = String.raw`
(() => {
  const strip = document.getElementById('lamp-strip');
  if (!strip) return JSON.stringify({ error: 'no strip' });
  const rows = strip.querySelectorAll('.strip-row').length;
  const clone = strip.cloneNode(true);
  clone.hidden = false;
  clone.id = 'lamp-strip-measure';
  // 脱离一切约束：绝对定位 + 不限制宽高
  Object.assign(clone.style, {
    position: 'absolute', left: '0', top: '0',
    width: 'max-content', height: 'auto', maxHeight: 'none',
    visibility: 'hidden', pointerEvents: 'none',
  });
  document.body.appendChild(clone);
  const rowsBox = clone.querySelector('.strip-rows');
  if (rowsBox) { rowsBox.style.maxHeight = 'none'; rowsBox.style.overflow = 'visible'; }
  const r = clone.getBoundingClientRect();
  const rowsRect = rowsBox ? rowsBox.getBoundingClientRect() : null;
  const out = {
    rowCount: rows,
    naturalWidth: +r.width.toFixed(2),
    naturalHeight: +r.height.toFixed(2),
    rowsHeight: rowsRect ? +rowsRect.height.toFixed(2) : null,
    // 内容盒（不含 padding/border）
    clientWidth: clone.clientWidth,
    clientHeight: clone.clientHeight,
  };
  clone.remove();
  return JSON.stringify(out);
})()
`;
const nat = await call('Runtime.evaluate', { expression: NATURAL, returnByValue: true });
ws.close();

const natural = JSON.parse(nat.result.value);
console.log('\n=== 内容自然尺寸（脱离窗口约束后实测）===');
if (natural.error) {
  console.log(`  测量失败：${natural.error}`);
} else {
  console.log(`  端口行数        : ${natural.rowCount}`);
  console.log(`  灯带自然尺寸    : ${natural.naturalWidth} x ${natural.naturalHeight}`);
  console.log(`  其中行区高度    : ${natural.rowsHeight}`);
  const vw = data.viewport.w;
  const vh = data.viewport.h;
  const fitsW = natural.naturalWidth <= vw;
  const fitsH = natural.naturalHeight <= vh;
  console.log(`  与窗口 ${vw}x${vh} 对比：宽${fitsW ? '够' : `**差 ${(natural.naturalWidth - vw).toFixed(1)}px**`}，` +
    `高${fitsH ? '够' : `**差 ${(natural.naturalHeight - vh).toFixed(1)}px**`}`);
  if (!fitsH) {
    console.log(`  建议高度至少：${Math.ceil(natural.naturalHeight) + 6}px（内容 + 垂直留白）`);
  }
  if (!fitsW) {
    console.log(`  建议宽度至少：${Math.ceil(natural.naturalWidth)}px`);
  }
}



console.log(`=== 窗口视口 ===  ${data.viewport.w} x ${data.viewport.h}\n`);
console.log('元素                          x      y      w      h    overflow  app-region');
for (const e of data.els) {
  console.log(
    `${e.sel.padEnd(26)} ${String(e.x).padStart(6)} ${String(e.y).padStart(6)} ` +
      `${String(e.w).padStart(6)} ${String(e.h).padStart(6)}  ${String(e.overflow).padEnd(9)} ${e.appRegion}`,
  );
}

console.log('\n=== 溢出检查（元素是否超出窗口视口）===');
const vw = data.viewport.w;
const vh = data.viewport.h;
let bad = 0;
for (const e of data.els) {
  const overRight = e.x + e.w > vw;
  const overBottom = e.y + e.h > vh;
  const overLeft = e.x < 0;
  const overTop = e.y < 0;
  if (overRight || overBottom || overLeft || overTop) {
    console.log(
      `  ❌ ${e.sel} 溢出：` +
        [
          overTop ? `上 ${(-e.y).toFixed(1)}px` : '',
          overLeft ? `左 ${(-e.x).toFixed(1)}px` : '',
          overRight ? `右 ${(e.x + e.w - vw).toFixed(1)}px` : '',
          overBottom ? `下 ${(e.y + e.h - vh).toFixed(1)}px` : '',
        ]
          .filter(Boolean)
          .join(' '),
    );
    bad += 1;
  }
}
if (bad === 0) console.log('  ✅ 所有元素都在视口内');

// ★ 投影被裁也算失败 —— 这是"圆圈显示不完整"最容易漏掉的一层：
//   元素边界框都在窗口内，但 box-shadow 画在 border box 之外，仍可能被切。
if (dotClips.length > 0) {
  bad += dotClips.length;
  console.log(`  ❌ ${dotClips.length} 个圆点的投影被窗口裁掉（上方已列出）`);
} else {
  console.log('  ✅ 圆点投影未被裁（含描边与光晕）');
}

// 拖拽区是否比灯带大
const drag = data.els.find((e) => e.sel === '.lamp-drag');
const strip = data.els.find((e) => e.sel === '#lamp-strip');
console.log('\n=== 拖拽可行性 ===');
if (drag && strip) {
  const dragBigEnough = drag.w >= strip.w && drag.h >= strip.h;
  console.log(`  拖拽区 ${drag.w}x${drag.h}，灯带 ${strip.w}x${strip.h}`);
  console.log(
    `  ${dragBigEnough ? '✅' : '❌'} 拖拽区${dragBigEnough ? '覆盖' : '**小于**'}灯带` +
      (dragBigEnough ? '' : ' —— 灯带超出部分无法拖动，且若父级裁剪会显示不全'),
  );
  if (!dragBigEnough) bad += 1;
}

console.log(`\n${bad === 0 ? '✅ 布局无问题' : `❌ ${bad} 项问题`}`);
process.exit(bad === 0 ? 0 : 1);
