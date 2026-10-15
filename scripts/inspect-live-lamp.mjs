/**
 * 用 Chrome DevTools Protocol 查询**正在运行的**悬浮灯真实 DOM 状态。
 *
 * 为什么需要这个：像素截图对半透明合成窗口不可靠，而"灯带是否真的
 * 按端口显示了正确颜色"是本项目最核心的观感。通过 CDP 读
 * `getComputedStyle` 与 `data-status`，拿到的是渲染层**实际生效**的值。
 *
 * 用法（应用需带 --remote-debugging-port=9222 启动）：
 *   node scripts/inspect-live-lamp.mjs
 */
const CDP_LIST = 'http://127.0.0.1:9222/json/list';

const res = await fetch(CDP_LIST, { signal: AbortSignal.timeout(5_000) });
const targets = await res.json();
const page = targets.find((t) => typeof t.url === 'string' && t.url.includes('overlay.html'));
if (page === undefined) {
  console.error('找不到 overlay 页面。现有目标：');
  for (const t of targets) console.error(`  ${t.type} ${t.url}`);
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
});

let nextId = 1;
function call(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMsg);
      if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const EXPR = String.raw`
(() => {
  const out = { strip: null, master: null, rows: [], single: null, opacityVar: null };

  // 灯带模式
  // ⚠️ 单灯容器的 id 是 **lamp-core**（不是 lamp-single）。
  // 写成 lamp-single 会让 getElementById 返回 null，于是 singleVisible
  // 恒为 false —— 这个探测错误一度让我误判成"单灯也没显示"。
  const strip = document.getElementById('lamp-strip');
  const single = document.getElementById('lamp-core');
  out.stripVisible = strip ? getComputedStyle(strip).display !== 'none' : false;
  out.singleVisible = single ? getComputedStyle(single).display !== 'none' : false;

  out.opacityVar = getComputedStyle(document.documentElement).getPropertyValue('--lamp-opacity').trim();
  out.bodyClass = document.body.className;

  const nameOf = (rgb) => {
    const map = {
      'rgb(107, 114, 128)': 'idle', 'rgb(147, 197, 253)': 'starting',
      'rgb(59, 130, 246)': 'running', 'rgb(245, 158, 11)': 'waiting',
      'rgb(34, 197, 94)': 'success', 'rgb(239, 68, 68)': 'failed',
      'rgb(75, 85, 99)': 'unknown',
    };
    return map[rgb] ?? ('? ' + rgb);
  };

  const md = document.getElementById('strip-master-dot');
  if (md) {
    const cs = getComputedStyle(md);
    out.master = {
      bg: cs.backgroundColor,
      state: nameOf(cs.backgroundColor),
      anim: md.className,
      size: cs.width,
    };
  }
  const ml = document.getElementById('strip-master-label');
  if (ml) out.masterLabel = ml.textContent;

  for (const row of document.querySelectorAll('.strip-row')) {
    const dot = row.querySelector('.strip-dot');
    const port = row.querySelector('.strip-port');
    const cs = dot ? getComputedStyle(dot) : null;
    out.rows.push({
      taskId: row.getAttribute('data-task-id'),
      dataStatus: row.getAttribute('data-status'),
      port: port ? port.textContent : null,
      // 悬停文案已按用户要求移除（「鼠标放上去就不需要文字提示了 乱糟糟的」），
      // 所以这里应该始终是 null —— 下方断言会把它锁住，防止有人又加回来。
      hoverTitle: row.getAttribute('title'),
      dotBg: cs ? cs.backgroundColor : null,
      dotState: cs ? nameOf(cs.backgroundColor) : null,
      dotAnim: dot ? dot.className : null,
      dotSize: cs ? cs.width : null,
    });
  }

  // 临时提示条（不是悬停 tooltip）：平时应为空，只有 onToast 时才短暂有字
  const tip = document.getElementById('lamp-toast');
  out.tooltip = tip ? tip.textContent : null;
  return JSON.stringify(out, null, 2);
})()
`;

const result = await call('Runtime.evaluate', { expression: EXPR, returnByValue: true });
ws.close();

if (result.exceptionDetails) {
  console.error('页面内求值抛出：', JSON.stringify(result.exceptionDetails, null, 2));
  process.exit(1);
}

const data = JSON.parse(result.result.value);
console.log('=== 悬浮灯实时状态（来自正在运行的渲染进程）===\n');
console.log(`body class        : ${data.bodyClass}`);
console.log(`--lamp-opacity    : ${data.opacityVar}`);
console.log(`灯带可见          : ${data.stripVisible}`);
console.log(`单灯可见          : ${data.singleVisible}`);
console.log('');
if (data.master) {
  console.log(`总灯  状态=${data.master.state}  尺寸=${data.master.size}  动画=${data.master.anim}`);
  console.log(`      标签="${data.masterLabel ?? ''}"`);
}
console.log('端口行：');
if (data.rows.length === 0) console.log('  （无端口行）');
for (const r of data.rows) {
  console.log(
    `  ${String(r.port ?? '?').padEnd(14)} 状态=${String(r.dotState).padEnd(10)} ` +
      `data-status=${String(r.dataStatus).padEnd(9)} 尺寸=${r.dotSize} 动画=${r.dotAnim}`,
  );
  console.log(`      taskId=${r.taskId}  bg=${r.dotBg}`);
  // 悬停**不应**有任何文字（已按用户要求移除）
  console.log(`      悬停：${r.hoverTitle ?? '(无)'}`);
}

console.log('\n=== 临时提示条（应常态为空；只有 onToast 时才短暂有字）===');
console.log(`  ${data.tooltip ? data.tooltip : '(空)'}`);

// 一致性校验：DOM 的 data-status 与计算出的颜色必须吻合
console.log('\n=== 一致性校验（data-status 与渲染颜色是否吻合）===');
let bad = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) bad += 1;
};
// 形态断言：两种都合法，取决于"此刻有几个可显示的行"。
//
// 【为什么不能只断言灯带】产品原则是「浮窗里出现的东西默认就该是活着的」，
// 失联/失败的行不显示；当可显示行数 < 2 时整窗会**缩成单灯**。
// 所以"单灯"是一个正常且预期的形态，不是失败。
const isStrip = data.stripVisible === true;
const isSingle = data.singleVisible === true;
check(
  `形态单一且自洽（${isStrip ? '灯带' : isSingle ? '单灯' : '都没显示'})`,
  isStrip !== isSingle,
  `灯带=${data.stripVisible} 单灯=${data.singleVisible} body="${data.bodyClass}"`,
);

if (isStrip) {
  check(
    '灯带模式下行数与形态一致（≥2 行）',
    data.rows.length >= 2,
    `${data.rows.length} 行`,
  );
} else {
  // 单灯形态：灯带里不该有残留行（hidden 生效 + 已清空）
  check('单灯形态下没有残留的端口行', data.rows.length === 0, `${data.rows.length} 行`);
}

// 行数**不写死** —— 配置会随需求增加任务，写死数字会让每次加任务都"测试失败"，
// 那是噪声不是信号。这里只断言"每行的数据自洽"。
for (const r of data.rows) {
  check(
    `${r.port} 的 data-status 与渲染颜色吻合`,
    r.dataStatus === r.dotState,
    `data-status=${r.dataStatus} 颜色=${r.dotState}`,
  );
  check(`${r.port} 颜色是合法七态之一`, !String(r.dotState).startsWith('?'), String(r.dotState));
  // 产品原则：显示出来的行不该是"没活着"的
  check(
    `${r.port} 显示出来的行是活着的（非 failed/unknown）`,
    r.dotState !== 'failed' && r.dotState !== 'unknown',
    String(r.dotState),
  );
  // ★ 悬停**必须没有**文字（用户要求：「鼠标放上去就不需要文字提示了 乱糟糟的」）
  //
  // 这条断言方向是**反向**的 —— 它锁住"别把悬停提示加回来"。
  // 状态信息已由圆点颜色 + 端口标签表达；明细在面板里看。
  check(
    `${r.port} 悬停无文字提示（已按用户要求移除）`,
    r.hoverTitle === null || r.hoverTitle === '',
    r.hoverTitle ? `又出现了：${r.hoverTitle}` : '(无)',
  );
}
if (data.master) {
  check('总灯颜色是合法七态之一', !String(data.master.state).startsWith('?'), String(data.master.state));
  const states = data.rows.map((r) => r.dotState);
  if (states.length > 0) {
    const priority = ['failed', 'waiting', 'running', 'success', 'starting', 'idle', 'unknown'];
    const expected = priority.find((p) => states.includes(p));
    check(
      '总灯 = 各显示行的聚合态（按 PRD 优先级）',
      data.master.state === expected,
      `期望 ${expected}，实际 ${data.master.state}（行状态：${states.join(',')}）`,
    );
  }
}

console.log(`\n${bad === 0 ? '✅ 实时渲染状态全部正确' : `❌ ${bad} 项不一致`}`);
process.exit(bad === 0 ? 0 : 1);
