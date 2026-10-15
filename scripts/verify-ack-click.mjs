/**
 * 验证「点击绿灯 -> 跳转 + 熄灭 + **不复亮**」这条闭环。
 *
 * 为什么必须跑真的：这里有三个只能在运行时暴露的点 ——
 *   ① 渲染层到底有没有绑上 click（classic script 里没绑就完全没反应）
 *   ② mark_read 的确认水位有没有挡住监控后续的重复上报
 *      （挡不住的话绿灯会在 5 秒内**立刻复亮**，点击等于没点）
 *   ③ ★ 行**能不能被真实鼠标点到** —— `-webkit-app-region: drag`
 *      会把点击吃掉，而合成事件绕过命中测试，所以查不出这个问题
 *
 * ⚠️ 前置条件：那一行**当前必须是绿灯**。点击成功后确认水位会记下，
 *    同一个完成不会再亮 —— 所以**连跑两次时第二次会因前置不满足而退出（exit 2）**。
 *    这是设计使然，不是失败。重启应用即可清空水位（它只在内存里）。
 *
 * 用法（应用需带 --remote-debugging-port=9222 启动）：
 *   node scripts/verify-ack-click.mjs [taskId]
 *   退出码：0=通过，1=验证失败，2=前置条件不满足（需重启应用）
 */
const TASK = process.argv[2] ?? 'workbuddy';

const res = await fetch('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(5_000) });
const targets = await res.json();
const page = targets.find((t) => typeof t.url === 'string' && t.url.includes('overlay.html'));
if (page === undefined) {
  console.error('找不到 overlay 页面（应用需带 --remote-debugging-port=9222 启动）');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok, no) => {
  ws.addEventListener('open', ok, { once: true });
  ws.addEventListener('error', () => no(new Error('ws')), { once: true });
});

let seq = 1;
const call = (method, params = {}) =>
  new Promise((ok, no) => {
    const myId = seq++;
    const on = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== myId) return;
      ws.removeEventListener('message', on);
      m.error ? no(new Error(JSON.stringify(m.error))) : ok(m.result);
    };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

const evaluate = async (expr) => {
  const r = await call('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};

/** 读某一行当前的状态（拿 DOM 上的 data-status，最直接）。 */
const rowState = `(() => {
  const row = document.querySelector('.strip-row[data-task-id=${JSON.stringify(TASK)}]');
  if (!row) return 'ROW_NOT_FOUND';
  const dot = row.querySelector('.strip-dot');
  return JSON.stringify({
    status: row.dataset.status ?? '',
    bg: getComputedStyle(dot).backgroundColor,
  });
})()`;

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? `  (${detail})` : ''}`);
};

console.log(`=== 目标任务：${TASK} ===`);

/**
 * 前置状态说明（**不自动造状态，避免改配置带来的风险**）。
 *
 * 本脚本需要那一行**当前是绿灯**。若它已经是灰的，通常是因为
 * **同一个完成事件已被点过一次** —— 确认水位记下了，不会再亮。
 *
 * 这不是 bug，是设计（同一个完成只提醒一次）。要重跑验证，
 * **重启应用**即可清空确认水位（它只存在内存里，不落盘）。
 */
{
  const st = JSON.parse(await evaluate(rowState));
  if (st.status !== 'success') {
    console.log(`\n⚠️ 那一行当前是 ${st.status}，不是绿灯 —— 无法验证点击闭环。`);
    console.log('   原因通常是：这个完成事件已经点过了（确认水位已记下，不会再亮）。');
    console.log('   重跑方法：重启应用后再执行本脚本。');
    console.log('   命令：Get-CimInstance Win32_Process -Filter "Name=\'electron.exe\'" |');
    console.log('         Where-Object { $_.CommandLine -like "*ai-task-indicator*" } |');
    console.log('         ForEach-Object { Stop-Process -Id $_.ProcessId -Force }');
    console.log('         node scripts/start.mjs -- --config ./config.dsh.example.yaml --remote-debugging-port=9222');
    ws.close();
    process.exit(2); // 2 = 前置条件不满足（与"验证失败"区分开）
  }
}

const before = JSON.parse(await evaluate(rowState));
console.log(`  点击前: status=${before.status}  bg=${before.bg}`);
check('点击前是完成态（绿灯）', before.status === 'success', before.status);

// ---------------------------------------------------------------------------
// ★★ 先验：这一行**能不能被真实鼠标点到**
//
// 【为什么必须单独验】原来只用 `element.click()` 派发合成事件 ——
// 它**绕过命中测试**，所以行被 `-webkit-app-region: drag` 覆盖时
// 依然"点得动"，测试全绿，而用户真实鼠标点完全没反应。
// 实测就是这么漏掉一个 bug 的。
// ---------------------------------------------------------------------------
const hitTest = await evaluate(`(() => {
  const row = document.querySelector('.strip-row[data-task-id=${JSON.stringify(TASK)}]');
  if (!row) return JSON.stringify({ err: 'ROW_NOT_FOUND' });
  const r = row.getBoundingClientRect();
  const cx = Math.round(r.left + r.width / 2);
  const cy = Math.round(r.top + r.height / 2);
  const hit = document.elementFromPoint(cx, cy);
  // 计算样式：drag 区域会吞掉鼠标事件，导致子元素的 click 收不到
  const region = getComputedStyle(row).webkitAppRegion || getComputedStyle(row).getPropertyValue('-webkit-app-region');
  return JSON.stringify({
    region: String(region).trim(),
    hitIsInsideRow: !!(hit && row.contains(hit)),
    hitTag: hit ? (hit.className || hit.tagName) : 'none',
    cx, cy, w: Math.round(r.width), h: Math.round(r.height),
  });
})()`);

const hit = JSON.parse(hitTest);
console.log(`  行尺寸 ${hit.w}x${hit.h}  中心 (${hit.cx},${hit.cy})`);
console.log(`  -webkit-app-region = "${hit.region}"   elementFromPoint -> ${hit.hitTag}`);

check(
  '★★ 行不在拖拽区里（app-region 必须是 no-drag）',
  hit.region === 'no-drag',
  `实际 "${hit.region}"`,
);
check(
  '★★ 行中心点命中的是这一行内部（没有东西盖住）',
  hit.hitIsInsideRow === true,
  `命中 ${hit.hitTag}`,
);

// 让页面把 focus 动作的异常也报出来，便于定位（缺失的 api 会让点击静默无反应）
const apiOk = await evaluate('typeof window.aiIndicator?.sendTaskAction');
check('渲染层能拿到 sendTaskAction（preload 白名单正常）', apiOk === 'function', String(apiOk));

console.log('\n=== 触发点击（真实鼠标事件，走命中测试）===');
// 用 CDP 的 Input.dispatchMouseEvent 而不是 element.click()：
// 前者经过命中测试与事件冒泡，更接近用户真实点击。
// （app-region 的 drag 吞事件发生在更底层，这里不一定能完全复现，
//   所以上面那条 app-region 断言才是这个 bug 的真正哨兵。）
await call('Input.dispatchMouseEvent', {
  type: 'mousePressed',
  x: hit.cx,
  y: hit.cy,
  button: 'left',
  clickCount: 1,
});
await call('Input.dispatchMouseEvent', {
  type: 'mouseReleased',
  x: hit.cx,
  y: hit.cy,
  button: 'left',
  clickCount: 1,
});
console.log('  已派发真实 mousePressed/mouseReleased');

// mark_read 要等 focus_terminal 回来才发，给它一点时间
await new Promise((r) => setTimeout(r, 4_000));
const after = JSON.parse(await evaluate(rowState));
console.log(`  点击后: status=${after.status}  bg=${after.bg}`);
check('★ 点击后绿灯熄灭（不再 success）', after.status !== 'success', after.status);

// ★★ 最关键：等足够久（跨过至少两轮轮询），确认**没有复亮**
console.log('\n=== ★★ 等 16 秒，确认监控重复上报不会让绿灯复亮 ===');
await new Promise((r) => setTimeout(r, 16_000));
const later = JSON.parse(await evaluate(rowState));
console.log(`  16 秒后: status=${later.status}  bg=${later.bg}`);
check(
  '★★ 绿灯没有复亮（确认水位挡住了重复上报）',
  later.status !== 'success',
  later.status,
);

ws.close();
const bad = checks.filter((c) => !c.ok).length;
console.log(`\n${bad === 0 ? `✅ 点击闭环全部通过（${checks.length} 项）` : `❌ ${bad} 项失败`}`);
process.exit(bad === 0 ? 0 : 1);
