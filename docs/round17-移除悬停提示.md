# 修：悬停文字提示太乱（round 17）+ 顺手修掉 D5 的间歇性崩溃

> 你报的问题：「鼠标放上去就不需要文字提示了 乱糟糟的」
> 日期：2026-10-14 · 结论：**525 测试全绿，全部实测链通过，D5 退出码连跑 4 次稳定**

---

## 一、悬停提示有两个来源，缺一不可

只删 JS 是不够的 —— 悬停行为其实来自**两处**：

### 来源 1：原生 `title` 属性（系统小黄条）

```js
// overlay.ts —— 每渲染一行就设一次
entry.row.title = describeTask(task);
// → 弹出「dsh @ 3080（本机） · 空闲 · dsh 127.0.0.1:3080：17 会话」
```

### 来源 2：CSS `:hover` 规则（自绘 tooltip）

```css
/* shared.css —— ★ 这个只看 JS 是发现不了的 */
.lamp-stage:hover + .lamp-tooltip {
  opacity: 1;   /* JS 只写 textContent，显示与否完全由这条 CSS 决定 */
}
```

**如果只删 JS 里的 `applyTooltip()`，tooltip 元素会变成空白块但依然弹出来。**

---

## 二、改动

| 位置 | 处理 |
|---|---|
| `entry.row.title = describeTask(...)` | ❌ 删除（不再设 title） |
| `describeTask()` 函数 | ❌ 删除（只服务于悬停文案） |
| `applyTooltip()` 函数 + 调用 | ❌ 删除 |
| `.lamp-stage:hover + .lamp-tooltip` | ❌ 删除这条 `:hover` 规则 |
| `.lamp-tooltip` → `.lamp-toast` | ✅ 改名保留 —— 它还给 `onToast` 用（"配置已重载"这类一次性通知） |
| `overlay.html` 里的 `role="tooltip"` | ❌ 去掉（它不再是 tooltip） |

`.lamp-toast` 只在 `.show` 时出现（`onToast` 加类、4 秒后移除），
改成单行截断（`white-space: nowrap` + `text-overflow: ellipsis`），
比原来多行 `pre-line` 更不打扰。

### 为什么删掉是合理的

浮窗是个**常驻不打扰**的小挂件，鼠标扫过就弹一块多行文字正好破坏这一点。
而状态信息**已经**由灯本身表达：

- 圆点颜色 = 七态
- 端口标签 = 是哪个实例

### 那份明细没丢

`describeTask` 里最有价值的信息是监控器的 `message`
（`dsh 127.0.0.1:13080：64 会话`）。它**没有丢** ——
面板里每个任务都会显示 `task.message`（`panel.ts`），
需要排查时打开面板即可。只是从"鼠标扫过自动弹"改成"按需查看"。

---

## 三、顺带修掉：D5 的间歇性崩溃

验证过程中发现 `d5-tunnel-check.mjs` **间歇性崩溃**：

```
✅ D5 全链路打通（7 项）              ← 断言全绿
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
exit code = -1073740791               ← 0xC0000409 STATUS_STACK_BUFFER_OVERRUN
```

连跑三次的结果是 **崩、过、过** —— 而且 `✅` **先打印出来了**，
说明 7 项断言全过，崩的是**退出那一步**。

### 根因：`process.exit()` 把还在关句柄的 SSH 子进程强杀了

脚本结尾是 `process.exit(failed.length === 0 ? 0 : 1)`。
Windows 上 SSH 子进程的句柄可能还在关闭过程中，此时强杀会撞上
libuv 的关闭断言。

### 修法

```js
process.exitCode = failed.length === 0 ? 0 : 1;
const forceExit = setTimeout(() => process.exit(process.exitCode ?? 1), 3000);
forceExit.unref();   // 定时器本身不阻止自然退出
```

设 `exitCode` 让 Node 自然排空事件循环再退出，避开竞态；
万一还有句柄不释放，兜底定时器负责强制收尾，保证脚本不会挂住。

**修后连跑 4 次全部 `exit=0`。**

> ⚠️ 注意这类问题的危害：断言是过的，只有退出码是错的。
> 如果用 `$LASTEXITCODE` 判断 CI 成败，就会**误报失败** ——
> 而且间歇性出现，很容易被当成"环境抖动"忽略掉。

---

## 四、顺带修掉：`verify-ack-click.mjs` 不可重复运行

验证时发现这个脚本**第二次跑必然失败**：

```
❌ 点击前是完成态（绿灯）  (idle)
```

这不是回归 —— 是**设计使然**：点击成功后确认水位被记下，
同一个完成事件不会再亮灯。脚本却假设"跑的时候那一行正好是绿的"。

我一开始想让它自动造状态（写临时库 + 改配置），但那要动配置文件、
风险大于收益。改成**明确检测 + 礼貌报错**：

```
⚠️ 那一行当前是 idle，不是绿灯 —— 无法验证点击闭环。
   原因通常是：这个完成事件已经点过了（确认水位已记下，不会再亮）。
   重跑方法：重启应用后再执行本脚本。
   （附带完整的重启命令）
```

**退出码 `2`** 专门表示"前置条件不满足"，与"验证失败（1）"区分开 ——
这样 CI 里能一眼看出是环境问题还是真失败。

---

## 五、验证

| 关卡 | 结果 |
|---|---|
| `tsc` × 3 份配置 | **全部 exit 0** |
| `vitest run` | **525 passed** |
| `scripts/inspect-live-lamp.mjs` | **全部正确**（悬停断言已**反向**） |
| `scripts/verify-strip-visual.mjs` | **17/17**（CSS 改了，必须过） |
| `scripts/verify-ack-click.mjs` | **6/6**（重启后一次通过） |
| `scripts/sqlite-monitor-check.mjs` | **16/16** |
| `scripts/d2-arbitration-check.mjs` | **10/10** |
| `scripts/d5-tunnel-check.mjs` | **7/7，连跑 4 次 exit=0** |
| `scripts/live-dsh-check.mjs` | **打通** |
| `scripts/smoke-e2e.js` | **全部通过** |
| `scripts/check-dsh-config.mjs` | **0 警告** |

### 实时证据

```
端口行：
  3080       状态=idle  ...
      悬停：(无)
  workbuddy  状态=idle  ...
      悬停：(无)
  13080      状态=idle  ...
      悬停：(无)

=== 临时提示条（应常态为空）===
  (空)
```

`inspect-live-lamp.mjs` 里那条断言我**故意反向**写，用来锁住"别把悬停提示加回来"：

```js
check(
  `${r.port} 悬停无文字提示（已按用户要求移除）`,
  r.hoverTitle === null || r.hoverTitle === '',
  r.hoverTitle ? `又出现了：${r.hoverTitle}` : '(无)',
);
```

---

## 六、复现

```powershell
cd D:\Projects\lamp\ai-task-indicator

node node_modules/typescript/bin/tsc -p tsconfig.json
node scripts/start.mjs -- --config ./config.dsh.example.yaml --remote-debugging-port=9222

# 悬停应为「(无)」
node scripts/inspect-live-lamp.mjs

# 点击闭环（必须在应用重启后跑，因为确认水位会持久到进程结束）
node scripts/verify-ack-click.mjs workbuddy
```
