# 修：灯带行点不动（round 16）

> 你报的问题：「好像点击不了」
> 日期：2026-10-14 · 结论：**525 测试全绿，点击验证 6/6（含新增的哨兵断言）**

---

## 一、根因：`-webkit-app-region: drag` 把点击吃掉了

```
.lamp-drag {
  -webkit-app-region: drag;     /* 整块当标题栏，用来拖动窗口 */
  width: 100%;                  /* 灯带模式下撑满整窗 */
  height: 100%;
}
```

**在 `drag` 区域里，鼠标事件被操作系统用于拖窗，不会派发给子元素。**
所以我在 `.strip-row` 上挂的 `click` 监听**永远收不到事件** ——
表现就是"点了没反应"。

`.lamp-core` 当初**专门**用 `no-drag` 挖出来过，注释写得很清楚：

```css
/* 点击区：必须从拖拽区里挖出来，否则点击会被 drag 吃掉 */
.lamp-core { -webkit-app-region: no-drag; ... }
```

**灯带行漏了这一步。** 这个坑是我加"点击跳转"时才踩上的 ——
之前灯带行本来就不需要点击（`cursor: pointer` 是个从没兑现的承诺，
代码注释里还留着"后续接「点某个端口直接跳转」"）。

### 修法

```css
.strip-row {
  cursor: pointer;
  -webkit-app-region: no-drag;   /* ★ 从拖拽区里挖出来 */
}
```

**只挖行本身、不挖 `-rows` 容器**：容器上下的内边距与行间距仍属 drag 区域，
所以窗口照样能拖（拖那些空隙即可）。挖成整块 `no-drag` 的话窗口就拖不动了。

---

## 二、★ 为什么我的验证没抓到它

这是本轮**最值得记的一点**。我的 `verify-ack-click.mjs` 之前报 **4/4 通过**，
但它用的是：

```js
document.querySelector('.strip-row[...]').click();   // 合成事件
```

`element.click()` **绕过命中测试** —— 它直接在元素上派发事件，
完全不经过 `app-region` 判定。所以行被 drag 覆盖时它依然"点得动"，
测试全绿，**而你的真实鼠标点完全没反应**。

### 修法：加一条 app-region 哨兵 + 改用真实鼠标事件

```js
// ① 断言这一行不在拖拽区里
const region = getComputedStyle(row).webkitAppRegion;
check('★ 行不在拖拽区里（app-region 必须是 no-drag）', region === 'no-drag');

// ② 断言行中心点命中的是自己（没有被别的东西盖住）
const hit = document.elementFromPoint(cx, cy);
check('★ 行中心点命中的是这一行内部', row.contains(hit));

// ③ 点击改用 CDP 的真实鼠标事件，而不是 element.click()
await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, ... });
await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, ... });
```

验证结果：

```
行尺寸 69x14  中心 (82,82)
-webkit-app-region = "no-drag"   elementFromPoint -> strip-port
✅ ★★ 行不在拖拽区里（app-region 必须是 no-drag）
✅ ★★ 行中心点命中的是这一行内部（没有东西盖住）
✅ ★ 点击后绿灯熄灭（不再 success）
✅ ★★ 绿灯没有复亮（确认水位挡住了重复上报）
✅ 点击闭环全部通过（6 项）
```

> **教训**：合成事件（`element.click()` / `dispatchEvent`）会绕过命中测试，
> 因此**不能用来验证"用户能不能点到"**。功能逻辑可以用它验，
> 但"点得到吗"必须查命中测试或 `app-region`。

---

## 三、上一轮同类问题的回顾

有点讽刺的是，上一轮我**刚**抓到一个"合成 vs 真实"的漏洞的近亲
（`wasDone` 被捕获成首帧值，逻辑对但实际不工作），
本轮又栽在同一类问题上 —— 只不过这次是**命中测试**而不是闭包捕获。

两次的共同点：**逻辑正确 ≠ 用户能用**。
`verify-ack-click.mjs` 现在同时覆盖这两类。

---

## 四、验证

| 关卡 | 结果 |
|---|---|
| `tsc` × 3 份配置 | **全部 exit 0** |
| `vitest run` | **525 passed** |
| `scripts/verify-ack-click.mjs` | **6/6**（原 4 项 + 2 项命中测试哨兵） |
| `scripts/verify-strip-visual.mjs` | **17/17**（CSS 改了，这条必须过） |
| `scripts/sqlite-monitor-check.mjs` | **16/16** |
| `scripts/d2-arbitration-check.mjs` | **10/10** |
| `scripts/d5-tunnel-check.mjs` | **7/7（exit 0）** |
| `scripts/live-dsh-check.mjs` | **打通** |
| `scripts/smoke-e2e.js` | **全部通过** |
| `scripts/check-dsh-config.mjs` | **0 警告** |

---

## 五、复现

```powershell
cd D:\Projects\lamp\ai-task-indicator

node node_modules/typescript/bin/tsc -p tsconfig.json
node scripts/start.mjs -- --config ./config.dsh.example.yaml --remote-debugging-port=9222

# ★ 这条会断言 app-region 与命中测试 —— 是这个 bug 的哨兵
node scripts/verify-ack-click.mjs workbuddy
```

---

## 六、现在能点的区域 / 不能点的区域

| 区域 | 点击行为 |
|---|---|
| **端口行**（圆点 + 名称） | 跳转 + 熄灭完成提醒 |
| 行与行之间的空隙 | 窗口拖动 |
| 灯带上下内边距 | 窗口拖动 |
| 总灯（单灯形态） | 打开/收起面板 |
| 总灯（灯带形态） | 窗口拖动（未单独挖出） |

### 还有一个前提

**浮窗必须能收鼠标。** 若开了「锁定浮窗（鼠标穿透）」，
点击会穿过去到下面的窗口。托盘菜单里的
`锁定浮窗（鼠标穿透）` 要处于**未勾选**状态才能点灯带行。
（`config.dsh.example.yaml` 里现在是 `clickThrough: false`，符合要求。）
