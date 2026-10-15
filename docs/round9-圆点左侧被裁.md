# 修复报告：圆点**左侧**被割掉（round 9）

> 你指出「下面圆点左侧似乎还有部分被割掉了」—— 完全正确，
> 而且这是我上一轮修复的**同类问题在另一个方向上的遗漏**。
> 日期：2026-10-14 · 结论：**442 测试全绿，五条实测链全通**

---

## 一、根因：容器只加了垂直内边距

上一轮我为「底部投影被切」给 `.strip-rows` 加了内边距，但写的是：

```css
padding: 6px 0;   /* ← 上下 6px，左右 0 */
```

`.strip-rows` 有 `overflow-y: auto`，**滚动容器会裁掉超出其 padding box 的一切**
—— 包括子元素画在 border box 之外的 `box-shadow`
（小灯是 `0 0 0 1px` 描边 + `0 1px 4px` 投影，**左右各外扩 4px**）。

行填满整个容器宽度 → 圆点紧贴裁剪边 → 左侧 4px 光晕被切。

### 用 CDP 拿到的铁证

```
=== 圆点相对裁剪边（.strip-rows 的 padding box）===
  元素                    宽     距左   距右   阴影超出左/右
  strip-master-dot        16       8  106.5  -2 / -100.5
  strip-dot               14       0   88.5    4 / -84.5     ← 距左 = 0！
  strip-dot               14       0   88.5    4 / -84.5
  strip-dot               14       0   88.5    4 / -84.5

  ❌ 3 个圆点的阴影超出容器左边 4px（会被裁）
```

`距左 = 0` 说明圆点**紧贴**容器裁剪边，而阴影要向左画 4px —— 必然被切。

---

## 二、修法

```css
padding: 6px;   /* 四个方向都要 */
```

并同步把水平内边距计入画布宽度（否则容器变宽会把内容挤出灯带）：

```ts
export const STRIP_ROWS_PAD_X = 6;
export const STRIP_ROWS_PAD_Y = 6;

export function stripCanvasWidth(): number {
  return STRIP_CONTENT_WIDTH + STRIP_ROWS_PAD_X * 2 + STRIP_PAD_X * 2 + STRIP_SHADOW_PAD_X * 2;
}
```

### 修复后

```
  元素              距左   距右   阴影超出左/右
  strip-dot (×3)      6    94.5      -2 / -90.5      ← 距左 6，超出 -2（有余量）
  ✅ 圆点阴影都在容器裁剪边之内
```

窗口从 152×117 变成 **164×117**（容器水平方向多了 12px padding）。

---

## 三、我为什么会连着漏两次

同一个机制（overflow 容器的 box-shadow 裁剪），我修了**垂直**却漏了**水平**。
原因是：上一轮我写验收脚本时，只检查了「元素是否超出**窗口视口**」这个维度，
而它是**上下左右都算**的 —— 于是我以为覆盖全了。

但真正会裁圆点的是**两层不同的裁剪边界**：

| 裁剪源 | 垂直 | 水平 |
|---|---|---|
| 窗口视口边缘 | 曾经漏（round 8 修） | 一直有余量，没暴露 |
| `.strip-rows` 的 padding box | round 8 修 | **round 9 才修** ← 你发现的 |

**"检查了四个方向"不等于"检查了所有裁剪源"。** 这两层必须分别验证。

### 已把这条维度补进验收脚本

`scripts/measure-live-lamp.mjs` 现在会：
1. 解析每条 `box-shadow` 的偏移/模糊/扩散，算出圆点**含投影**的真实占位
2. 与**窗口视口**比（四边）
3. 与**每个 overflow 容器的 padding box** 比（四边）
4. 报出时明确说明**是哪一边、差多少** —— 而非只说"被裁"

```
  滚动容器裁剪行为：
     .strip-rows    overflow-y=auto  会裁剪子元素的阴影  padding=6px/6px/6px/6px
     ✅ 圆点阴影都在容器裁剪边之内（含左右）
```

---

## 四、新增测试

`test/overlay-layout.test.ts` 加了 2 条（共 21）：

- `★ .strip-rows 的水平内边距必须 > 0（否则圆点左侧光晕被裁）`
  —— 断言 `STRIP_ROWS_PAD_X >= 阴影向左扩散的距离`，并交叉校验 CSS 里的实际值
- `★ 画布宽度必须把 .strip-rows 的水平内边距算进去`
  —— 漏算会导致内容变宽被灯带裁

同时改造了 padding 解析：现在能同时接受 `padding: 6px`（单值）
与 `padding: 6px 0`（双值），并分别核对上下/左右。

---

## 五、质量关卡

| 关卡 | 结果 |
|---|---|
| `tsc` × 3 份配置 | **全部 exit 0** |
| `vitest run` | **442 passed × 2 次连续** |
| `scripts/d2-arbitration-check.mjs` | **10/10** |
| `scripts/live-dsh-check.mjs` | **打通** |
| `scripts/verify-strip-visual.mjs` | **17/17** |
| `scripts/smoke-e2e.js` | **全部通过** |
| `scripts/measure-live-lamp.mjs` | **布局无问题 + 圆点投影未被裁（含左右）** |

测试数字对账：`440 → 442`（+2 水平裁剪回归）

---

## 六、顺带说明：你的悬浮灯位置被我还原了

诊断时我为了排除「屏幕边缘把窗口切掉」这一可能，临时把 `lamp.x/y`
挪到画面中间（2200, 300）。确认排除后**已还原为你原来拖到的位置**
（`x: 3627, y: 63`）。

顺带确认了这一层也是干净的：窗口在 1920×1080 的第二显示器上，
距右边缘还有 61px，所以那片空白**不是**被屏幕切的 —— 确实是 CSS 裁剪。

---

## 七、复现

```powershell
cd D:\Projects\lamp\ai-task-indicator

node node_modules/typescript/bin/tsc -p tsconfig.json          --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.test.json     --noEmit
node node_modules/vitest/vitest.mjs run

node node_modules/typescript/bin/tsc -p tsconfig.json
node scripts/start.mjs -- --config ./config.dsh.example.yaml --remote-debugging-port=9222
node scripts/measure-live-lamp.mjs          # 窗口视口 + 容器裁剪 两层都查
node scripts/diagnose-lamp-position.mjs     # 屏幕边界 + 容器裁剪边距离
```
