/**
 * 只验证「点击某一行 -> 跳转」这条路径（不掺完成提醒的确认水位）。
 *
 * 与 verify-ack-click.mjs 的分工：
 *   - verify-ack-click：验证完成提醒的**确认水位**（要求那一行是绿灯，
 *     且因为水位会记下，**只能跑一次**，重启应用才能重跑）
 *   - 本脚本：只验证**点击能不能触发跳转**，任何状态都能跑、可重复运行
 *
 * 排查跳转类问题（跳错/没跳/重复开页面）时用这个更顺手。
 *
 * 用法（应用需带 --remote-debugging-port=9222 启动）：
 *   node scripts/probe-row-jump.mjs <taskId>
 */
const TASK = process.argv[2];
if (!TASK) {
  console.error('用法: node scripts/probe-row-jump.mjs <taskId>');
  process.exit(1);
}

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

const info = JSON.parse(
  await evaluate(`(() => {
    const row = document.querySelector('.strip-row[data-task-id=${JSON.stringify(TASK)}]');
    if (!row) return JSON.stringify({ err: 'ROW_NOT_FOUND' });
    const r = row.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(cx, cy);
    return JSON.stringify({
      status: row.dataset.status ?? '(无)',
      region: String(getComputedStyle(row).webkitAppRegion).trim(),
      hitInside: !!(hit && row.contains(hit)),
      hitTag: hit ? (hit.className || hit.tagName) : 'none',
      cx, cy,
    });
  })()`),
);

if (info.err === 'ROW_NOT_FOUND') {
  console.error('找不到 ' + TASK + ' 那一行（它可能因失联/失败被隐藏了）');
  process.exit(1);
}

console.log('=== ' + TASK + ' ===');
console.log(
  '  状态=' + info.status + '  app-region="' + info.region + '"  命中=' + info.hitTag +
    '  点=(' + info.cx + ',' + info.cy + ')',
);

console.log('\n=== 派发真实鼠标点击 ===');
await call('Input.dispatchMouseEvent', {
  type: 'mousePressed', x: info.cx, y: info.cy, button: 'left', clickCount: 1,
});
await call('Input.dispatchMouseEvent', {
  type: 'mouseReleased', x: info.cx, y: info.cy, button: 'left', clickCount: 1,
});
console.log('  已派发（跳转结果看应用日志的「聚焦请求」/「已切到」/「已打开」行）');

// Win32 窗口激活要编译 C#，实测要 5~6 秒才有日志
await new Promise((r) => setTimeout(r, 7_000));

const after = JSON.parse(
  await evaluate(`(() => {
    const row = document.querySelector('.strip-row[data-task-id=${JSON.stringify(TASK)}]');
    return JSON.stringify({
      stillThere: !!row,
      status: row ? (row.dataset.status ?? '') : '(行已消失)',
    });
  })()`),
);
console.log('  点击后: stillThere=' + after.stillThere + '  status=' + after.status);
ws.close();
