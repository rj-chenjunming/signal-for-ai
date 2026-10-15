# 进展报告：多端口灯带 UI + 视觉验收（goal round 4）

> 本轮交付**浮窗 UI 主体**（设计决策 D6/D9/D10 的视觉与布局部分），
> 并首次做到**在没有桌面的环境下真正验证视觉呈现** ——
> 这是 04-SPEC §7.2 明确记为「未验证」的一项。
> 日期：2026-10-13 · 结论：**灯带渲染 17/17 项程序化验收通过，329 测试全绿**

---

## 一、本轮产出

| 文件 | 说明 |
|---|---|
| `src/renderer/shared.css`（改） | 新增灯带样式：`.lamp-strip` / `.strip-master` / `.strip-row` / `.strip-dot` |
| `src/renderer/overlay.html`（改） | 新增灯带 DOM 结构（总灯 + 端口行容器） |
| `src/renderer/overlay.ts`（改） | 多端口渲染 + 单灯/灯带切换 + 原地更新 |
| `src/main/overlay.ts`（改） | 画布尺寸随任务数自适应；`fitToTaskCount()` |
| `src/main/store.ts`（改） | `Snapshot.stripMode` 判定；`derivePortLabel()` |
| `src/main/index.ts`（改） | 注入 `taskCount`；热重载时对齐窗口尺寸 |
| `src/main/ipc.ts`（改） | 补齐 `stripMode` 字段 |
| `src/shared/types.ts`（改） | `TaskState.portLabel`、`Snapshot.stripMode` |
| `test/store-strip.test.ts`（新） | 11 个用例 |
| `scripts/make-strip-preview.mjs`（新） | 生成灯带静态预览页（用真实 shared.css） |
| `scripts/verify-strip-visual.mjs`（新） | **无头 Chrome 程序化视觉验收** |

---

## 二、形态设计（落地 D6/D9/D10）

```
◆ 运行中          <- 总灯 16px，代表所有端口的聚合态
● 3080            <- 每端口 14px 小灯 + 端口号（等宽 10px）
● 13080
● 13081
```

- **竖排**而非横排：端口号要跟着灯走；横排会把窗口撑宽、盖住更多编辑器区域。
  实测整窗**仅 64px 宽**，只占屏幕右侧一条。
- **单灯退回**：启用任务数 < 2 时自动回到经典单灯形态（干扰最小）。
- 端口数很多时 `.strip-rows` 内部滚动，不把窗口撑出屏幕。
- 色值全部走 `--status-*` 变量，CSS 里**不出现任何字面色值**（架构 §8.1 单一来源）。
- 每行可单独点击（DOM 已带 `data-task-id`，后续接"点某端口直接跳转"）。

### 一个必须对齐的口径（防错位）

`Snapshot.stripMode` 与 `OverlayWindow.resolveCanvasSize()` **必须数同一种东西**：

```ts
// store.ts
stripMode: all.filter((t) => !t.paused).length >= 2,   // 启用任务数
// overlay.ts
taskCount: () => configManager.config.tasks.filter((t) => t.enabled).length,
```

若一边数"全部任务"、另一边数"启用任务"，就会出现
**窗口按灯带开、内容按单灯渲染**的错位。已加专门用例锁死这条。

---

## 三、视觉验收：把"无法验证"变成"已验证"

04-SPEC §7.2 原文：

> **未验证** —— 托盘/悬浮灯的视觉呈现：沙箱无法真正起窗口，
> 逻辑层已验证但像素效果未看过

本轮解决了它。思路：灯带是**纯 CSS** 的，把项目真实的 `shared.css`
渲染进无头 Chrome，再读出 `getComputedStyle` 的结果 —— 就能在没有桌面的
情况下验证**浏览器实际算出来的**颜色与尺寸，比人眼估计更严格。

`scripts/verify-strip-visual.mjs` 结果（17/17）：

```
=== 1. 七态色值：浏览器实际计算出的颜色 ===
  ✅ idle      → rgb(107, 114, 128)
  ✅ starting  → rgb(147, 197, 253)
  ✅ running   → rgb(59, 130, 246)
  ✅ waiting   → rgb(245, 158, 11)
  ✅ success   → rgb(34, 197, 94)
  ✅ failed    → rgb(239, 68, 68)
  ✅ unknown   → rgb(75, 85, 99)

=== 2. 灯带布局（D6/D9）===
  ✅ 灯带是竖排 (column)
  ✅ 端口行内部也是竖排 (column)
  ✅ 总灯在端口行之上 (masterBottom=371.9 firstRowTop=378.9)
  ✅ 子节点顺序是 总灯 → 端口行 (strip-master | strip-rows)
  ✅ 整窗宽度紧凑（< 140px） (64px)
  ✅ 小灯 14px（D9）
  ✅ 总灯 16px（略大于端口灯）
  ✅ 端口标签 10px（紧凑）

=== 3. 单灯形态（任务数 < 2 时退回）===
  ✅ 单灯是圆形 (50%)
  ✅ 单灯渲染出真实颜色（非透明）
```

**同时产出可人工查看的预览页**：`deliverables/strip-preview.html`
（含七态色板 + 6 个真实场景 + 单灯形态）与配套截图 `strip-preview.png`。

预览页由 `make-strip-preview.mjs` 从**真实 shared.css** 生成，
并自校验 `overlay.html` 的结构（`lamp-strip` / `strip-rows` / `strip-master-dot`
三个锚点都在），防止预览与产物两处漂移。

---

## 四、质量关卡

| 关卡 | 结果 |
|---|---|
| `tsc -p tsconfig.json --noEmit` | **exit 0** |
| `tsc -p tsconfig.electron.json --noEmit` | **exit 0** |
| `tsc -p tsconfig.test.json --noEmit` | **exit 0** |
| `vitest run` | **329 passed × 2 次连续** |
| `node scripts/smoke-e2e.js` | **全部通过** |
| `scripts/live-dsh-check.mjs` | **真实 dsh 打通**（`17 会话，1 个活跃`） |
| `scripts/check-dsh-config.mjs` | **示例配置 0 警告** |
| `scripts/verify-strip-visual.mjs` | **17/17 视觉验收通过** |

测试数字对账：`318（上轮）+ 11（灯带）= 329` ✅

---

## 五、本轮修掉的一个自己写错的测试

`derivePortLabel` 的异常用例里，我期望 `authority: 'nocolon'`（无冒号）
返回 `'nocolon'`，实际实现返回 `'broken'`（taskId）。

**实现是对的，测试是错的** —— 把整个 `'nocolon'` 当端口标签会让灯带上
显示一个谁也看不懂的串；退回 taskId 才是可读的降级。
已改测试断言，并补了两个边界（无 authority、冒号在末尾）。

---

## 六、完成度

| 决策 | 状态 |
|---|---|
| D2 状态采集 | ✅ (a) 真实打通 · ✅ (b) 插件验证 · ⏳ 二者合并仲裁 |
| D3 扩展项目 | ✅ |
| D4 端口发现 | ✅ |
| D5 远端鉴权 | ⏳ SSH 路径未验证 |
| D6 聚合粒度 | ✅ **灯带 UI 已落地并视觉验收** |
| D7 插件 | ✅ |
| D8 采集方式 | ✅ 轮询/事件就绪；⏳ `session/follow` 未试 |
| **D9 灯排布** | ✅ **完成（14px 灯 + 端口号 + 总灯，64px 宽）** |
| **D10 浮窗交互** | 🟡 部分：可点击 + `focusable:false` + `clickThrough` 已有；**托盘里的"锁定/穿透"菜单项尚未接** |
| D11 通知 | ⏳ **未开始 —— 剩下的主要一块** |
| 插件装进真实 3080 | ⏳ 待你同意重启 |

---

## 七、复现

```powershell
cd D:\Projects\lamp\ai-task-indicator

# 类型检查（三份都应 exit 0）
node node_modules/typescript/bin/tsc -p tsconfig.json          --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.test.json     --noEmit

# 全量测试（应 329 passed）
node node_modules/vitest/vitest.mjs run

# 视觉验收（生成预览 + 用 Chrome 读计算样式核对）
node scripts/make-strip-preview.mjs
node scripts/verify-strip-visual.mjs

# 真实 dsh 端到端
node node_modules/typescript/bin/tsc -p tsconfig.json
node scripts/live-dsh-check.mjs

# 端到端冒烟
node scripts/smoke-e2e.js
```
