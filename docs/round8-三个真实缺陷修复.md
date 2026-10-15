# 修复报告：三个真实缺陷 + 投影裁剪（round 8）

> 你反馈的三条问题，全都定位到根因并修好了。其中两条**不是观感问题**，
> 而是把核心功能悄悄打掉了。
> 日期：2026-10-13 · 结论：**440 测试全绿，五条实测链全通**

---

## 追加修复：「下面圆形显示的还是不完整」

第一轮修完后你仍看到圆圈不完整 —— 因为**还有一层我漏了**：

我的验收只检查了 `getBoundingClientRect()`（元素边界框在窗口内 ✅），
但 **`box-shadow` 画在 border box 之外**，窗口会把它切掉。

### 两个叠加的裁剪源

1. **窗口底边距只有 2px，而投影向下 5px**
   （`0 1px 4px` = 1px 位移 + 4px 模糊）。底部那圈的光晕被窗口边缘切平。
2. **`.strip-rows` 是滚动容器（`overflow-y: auto`）**
   滚动容器会裁掉超出其 content box 的一切 —— 而行原本填满容器，
   于是**首行顶部的描边、末行底部的投影全被切**。

### 修法

| 改动 | 作用 |
|---|---|
| `.strip-rows { padding: 6px 0 }` + 常量 `STRIP_ROWS_PAD_Y` | 让滚动容器的裁剪边退到圆点描边之外 |
| `STRIP_SHADOW_PAD_Y: 8 → 12`（新增 `X = 8`） | 窗口留出大于投影扩散量的余量 |

多出来的空白是**透明的、看不见的**，所以"宁可多留"没有代价 ——
而少留 1px 就是切边。

### 教训：验收脚本本身有盲区

我原来的验收说"✅ 所有元素都在视口内"，却让你仍然看到缺陷 ——
**因为它检查的维度不对**。已给 `measure-live-lamp.mjs` 加了第三段：
解析每条 `box-shadow` 的偏移/模糊/扩散，算出圆点**含投影**的实际占位，
再和窗口边界比对；投影被裁现在会计入失败。

```
=== ★ 投影裁剪检查（box-shadow 画在 border box 之外）===
  单个小圆点的 box-shadow 向外扩散：上 3 / 下 5 / 左 4 / 右 4 px
  ✅ 没有任何圆点的投影被窗口裁掉
  滚动容器裁剪行为：
     .lamp-strip    overflow-y=visible  不裁剪
     .strip-rows    overflow-y=auto     会裁剪子元素的阴影  padding=6px/6px

=== 内容自然尺寸 ===
  灯带自然尺寸    : 118.48 x 105
  与窗口 152x117 对比：宽够，高够
```

**105 vs 之前的 97 —— 就是差这 8px，投影被切。**

### 顺带又修了测试里 CSS 解析器的两个盲区

为了交叉校验常量与 CSS 一致，测试里有个朴素的 CSS 解析器。这轮它连续误报两次：

1. **注释里的 `}` 会让"截到第一个 `}`"提前截断** —— 我给 `.strip-rows`
   加了说明注释后，`padding` 就读不出来了。修法：解析前先去掉注释。
2. **`padding: 6px 0` 的第二个值不带 `px`** —— 正则要求两边都有 `px`，
   于是匹配失败。修法：`px` 设为可选。

两次都是**解析器的错，不是被测代码的错** —— 与之前那个
"`.strip-dot` 先命中 `.strip-row:hover .strip-dot`"是同一类问题。
这类"测试基础设施自己有 bug"很容易被误读成产品缺陷，值得单独记一笔。

---

## 问题一：圆圈显示不完整 + 不可移动

### 根因

灯带 DOM 确实在 `.lamp-drag` 里（结构没错），但 `.lamp-drag` 的尺寸是
按**单灯**算的：

```css
.lamp-drag {
  width: calc(var(--lamp-size) + 16px);   /* 28+16 = 44px */
  height: calc(var(--lamp-size) + 16px);
}
```

而灯带是 **118.5 × 93**。于是：

1. 作为 flex 项被 `align-items: center` 居中 → 超出部分往上下两头溢出 → **被窗口边缘裁掉**（这就是"圆圈显示不完整"）
2. 只有中间 44×44 那一块能拖 → 用户觉得**"拖不动"**

### 修法

```css
body.strip-mode .lamp-drag { width: 100%; height: 100%; }
```

由 `overlay.js` 按 `snapshot.stripMode` 切换（渲染层不自己判断"几个任务算多"）。

### 还有第二层原因：画布尺寸算少了

实测（CDP 量真实 DOM）：3 行灯带的**自然尺寸是 118.48 × 93**，
而窗口只有 88 → 上下各被裁 3.5px。

原来的公式是**拍脑袋**的：

```ts
const ROW_HEIGHT = 19;   // 实际每行步进 ≈ 17.33
const MASTER_HEIGHT = 28; // 实际 21~22
const PADDING = 22;
```

于是我把它抽成纯函数 `src/main/overlay-layout.ts`，
并且**用实测值反推常量**（而不是继续猜）：

| 常量 | 值 | 依据 |
|---|---|---|
| `STRIP_ROW_STEP` | 18 | (93 − 41) / 3 ≈ 17.33，**向上取整**（宁可多留） |
| `STRIP_MASTER_HEIGHT` | 21 | 93 − 41 − 54，从实测反推 |
| `STRIP_SHADOW_PAD_Y` | 8 | 小灯描边 1px + 投影 5px 画在 border box 之外 |
| `STRIP_SAFETY_PAD` | 6 | CSS 取整/字体度量会多出 1–2px，差 1px 就是切边 |

并加了**交叉校验测试**：直接读 `shared.css`，断言 TS 常量与 CSS 实际值一致
（不是自己写死一份数字 —— 那样两边一起错就测不出来）。

### 最后还有第三层：窗口不会随任务数增长

窗口在 `create()` 时按当时的任务数定死。配置异步加载或热重载加了个端口后，
`fitToTaskCount()` 只在显式调用时触发，于是窗口停留在旧尺寸。

**修法**：`setState()` 里调用 `fitToTaskCount()`（内部有"尺寸未变则不动"判断，无副作用）。

### 验证

```
=== 窗口视口 ===  148 x 97
#lamp-strip      14.8    2   118.5   93
✅ 所有元素都在视口内
✅ 拖拽区 148x97 覆盖灯带 118.5x93
```

---

## 问题二：★「执行完了还显示运行中」—— 这是个真 bug

### 根因

**静默判定排在 running 判定之后**：

```ts
// 修改前
if (pendingInteraction) return 'waiting';
if (runningSubagentCount > 0) return 'running';   // ← 在这里就返回了
if (running === true) return 'running';           // ← 或这里
if (刚活动) return 'starting';
if (agentAvailable === false) return 'idle';
if (静默超过 60s) return 'idle';                  // ← 永远到不了
```

于是只要 dsh 还报着 `running: true`，或 `subagentCatalog` 里留着一个
**永远没写 `settledAt` 的陈旧条目**，这个会话就**永远显示蓝色**。

### 实测抓到的真实数据

```
sessionId         running  未结算子代理   静默(s)   判定
session-26c9a3ad  true     2              40       running
...
session-26c9a3ad  true     2              726      running   ← 静默 12 分钟还是 running
```

### 修法

把静默判定提到 running **之前**：

```ts
if (updatedAt !== undefined && now - updatedAt > silenceMs
    && pendingInteraction === undefined) {
  return 'idle';
}
```

关键细节：**静默不能盖过 waiting**。人卡在授权上等再久也还是 waiting ——
否则"等你授权"这个最值钱的信号会在 60 秒后消失，那是本末倒置。

### 验证

同一份真实数据，判定分布从 `running 1 / idle 16` 变成 **`idle 17`**。

---

## 问题三（我顺着查出来的）：`idle → waiting` 被状态机拒绝

### 这是本轮最严重的发现

我在 round 6 把这条记成"真实粗糙点，不影响 D2 功能"。**那个判断是错的。**

调试时打出来的证据：

```
pluginStateFor(session-...) = {"pendingInteraction":"approval"}   ✅ 信号传到了
per-session 判定: ... -> waiting                                  ✅ 判定正确
store: dsh-3080=idle                                             ❌ apply 被拒
  [warn] [store] 非法状态转移被拒绝: dsh-3080 idle -> waiting
```

D2 全链路每一环都对，最后 `apply` 因 `idle → waiting` 非法**返回 null**，
灯停在灰色 —— **用户永远看不到"卡住等你授权"**，也就是本产品最值钱的功能被静默打掉。

之前没暴露，**只是因为碰巧有会话在 running**，走的 `running → waiting`。
一旦所有会话 idle（修好问题二之后就是这样），它就必然暴露。

### 修法

```ts
idle: ['starting', 'running', 'waiting', 'failed'],
```

理由：推送型任务在收到信号前**一直是 idle**，收到"在等授权"时前一个状态就是 idle
（不会有 starting/running —— 那是轮询/日志型的路径）。

不变量检查：本边**不引入** `failed → success`，也**不引入** `unknown → success`，
故不违反 PRD §4.2。

### ★ 中途一次自我纠正：我放得太宽了，测试把我挡了回来

我一度顺手也放开了 `unknown → waiting`。**两个既有测试立刻报红**：

```
× unknown 不能直接转 waiting/success（必须先真正跑起来）
× unknown -> waiting 被拒：必须先真正跑起来才可能等待授权
```

读它们的理由后我确认**测试是对的、我是错的**：

- `idle` = "没在干活"（安全，可以直接转 waiting）
- `unknown` = "**看不见它**了"——失联期间实例可能早就崩了

若允许 `unknown → waiting`，就会出现"明明挂了却显示卡在等你授权" ——
比停在灰色更危险（漏报失败）。所以 `unknown` 必须**先被观察到真实运行信号**
才可能进入 waiting。我保留原设计，并在代码注释里写明了这次来回。

---

## 顺带修掉的两个小问题

1. **SSH 超时太紧**：20s 在真实环境经常超时（日志：`SSH 超时（>20000ms）`），
   导致隧道实例灯先变红、要等下一轮重试才恢复。实测单次握手波动很大
   （快时 ~11s，慢时**超过 4 分钟**）。改为 **45s** —— 覆盖常见区间，
   又不至于让一轮轮询挂太久。反正失败会重试、成功后缓存 30 分钟。
2. `dsh.ts` 里一处粘连的声明（`...DshPollOutcome {    this.failureCount = 0;`），
   语法合法但可读性差，已格式化。

---

## 质量关卡

| 关卡 | 结果 |
|---|---|
| `tsc` × 3 份配置 | **全部 exit 0** |
| `vitest run` | **440 passed × 2 次连续** |
| `scripts/d2-arbitration-check.mjs` | **10/10**（基线 idle → 推入后 waiting） |
| `scripts/d5-tunnel-check.mjs` | **7/7** |
| `scripts/live-dsh-check.mjs` | **打通** |
| `scripts/verify-strip-visual.mjs` | **17/17** |
| `scripts/smoke-e2e.js` | **全部通过** |
| `scripts/measure-live-lamp.mjs`（新） | **布局无问题 + 圆点投影未被裁** |
| `scripts/inspect-live-lamp.mjs` | **实时渲染状态全部正确** |

测试数字对账：`424（修复前）+ 8（静默优先级）+ 5（idle→waiting）+ 3（投影/裁剪）= 440`

### 顺带修正了两个"靠 bug 才通过"的断言

修好问题二之后，两个实测脚本报红 —— 因为它们的断言**只有在旧 bug 下才成立**：

- `live-dsh-check.mjs`：`拿到了非 idle 的真实状态`
  → 改为断言"读到了合法七态 + message 带会话数与 authority"（那才是"读到了 dsh"的证据）
- `d2-arbitration-check.mjs`：等基线"非 idle"
  → 改为等"store 里已有该任务"，并断言 **idle → waiting** 这个升级

**这类断言比没有断言更危险**：它把 bug 固化成"预期行为"。

---

## 新增的两个诊断工具

| 工具 | 用途 |
|---|---|
| `scripts/inspect-live-lamp.mjs` | 用 CDP 读运行中悬浮灯的真实 DOM 状态与颜色 |
| `scripts/measure-live-lamp.mjs` | 量各元素边界框、检测溢出、**并让页面自己报告内容自然尺寸** |
| `scripts/diagnose-running-state.mjs` | 逐会话打印 dsh 原始字段（running/plan.pending/未结算子代理/静默）与判定结果 |

`measure-live-lamp.mjs` 里那个"让页面自己报告自然需要多大"的做法值得留着：
它是把"我算得对不对"变成"页面说它需要多大"，避免继续用猜测对齐 CSS。

---

## 复现

```powershell
cd D:\Projects\lamp\ai-task-indicator

# 类型检查（三份都应 exit 0）
node node_modules/typescript/bin/tsc -p tsconfig.json          --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.test.json     --noEmit

# 全量测试（应 438 passed）
node node_modules/vitest/vitest.mjs run

# build 后跑各条实测链
node node_modules/typescript/bin/tsc -p tsconfig.json
node scripts/live-dsh-check.mjs
node scripts/d2-arbitration-check.mjs
node scripts/d5-tunnel-check.mjs

# 起应用（带调试端口以便量布局）
node scripts/start.mjs -- --config ./config.dsh.example.yaml --remote-debugging-port=9222
node scripts/measure-live-lamp.mjs
node scripts/inspect-live-lamp.mjs
```
