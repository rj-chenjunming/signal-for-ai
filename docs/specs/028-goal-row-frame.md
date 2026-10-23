# SPEC-028：悬浮灯「目标」行去掉框线痕迹（分隔线弯钩 + 常驻滚动条）

> 状态：verifying
> 类型：bugfix（视觉）
> 需求来源：用户 2026-10-22 会话——「感觉目标这个图标有点问题，能看到轮廓，没有很好的融入背景」；用户附贴边点阵局部截图，并确认所指即「目标行上方带弯钩的圆角分隔线 + 右侧 4px 灰色滚动条」把图标框了起来。
> 负责人：lead
> 基线提交：`7aadfa7`（工作区干净；复现用临时夹具目录已清理，证据截图在 `logs/spec012-ui/`）
> 需求依据及假设：用户要的是「目标行不要看起来被一个框包住」，不是改图标造型/配色。分隔线本身保留（SPEC-025 用它区分目标行与任务行），只修掉它的弯钩与滚动条。
> 关联/替代条款：不改变 SPEC-025 的行内容、点击语义、贴边隐藏文字/进度环规则；不改变 SPEC-012 的灯带/点阵几何常量。

## 1. 问题与目标

SPEC-025 给悬浮灯加了「目标」行，样式为：

```css
.strip-goal-row { border-top: 1px solid var(--panel-border); margin-top: 2px; }
```

`.strip-row` 是 `border-radius: 8px` 的按钮，`border-top` 落在圆角上时会在两端画出**向下弯的钩**；同时 `margin-top: 2px` 没有计入 `main/overlay-layout.ts` 的 32px 行节奏（`COMPACT_TILE` + `COMPACT_GAP`），在贴边点阵形态下把 `.strip-rows` 撑出 2px 纵向溢出，`overflow-y: auto` 于是常驻一条 4px 滚动条。

贴边画布只有 52px 宽（`COMPACT_TILE 32 + COMPACT_PAD 4×2 + COMPACT_SHADOW_PAD 6×2`），4px 滚动条紧贴目标图标右侧；加上上方带弯钩的分隔线，三面合起来像一个把图标框住的「轮廓」，在浅色/深色玻璃底上都不融合。用户截图即为贴边纵向点阵。

复现（2026-10-22 本机，真实 Electron 渲染夹具，`dist/` 为 `7aadfa7` 构建）：

| 夹具 | `.strip-rows` 状态 |
| --- | --- |
| 贴边 `left`，2 任务 + 目标行 | `clientWidth 28 / offsetWidth 32`（4px 竖滚动条）；`scrollHeight 108 / clientHeight 106`（2px 溢出） |
| 非贴边灯带，2 任务 + 目标行 | 无溢出，但目标行 `border-top: 1px`，分隔线两端带弯钩 |
| 贴边 `top` 横排 | 目标行 `margin-top` 把行撑成 34px 高（横排下无可见滚动条） |

目标行为：有目标行时，`.strip-rows` 不出现滚动条、不溢出；分隔线是**直线**且不占布局高度；行内容与交互不变。

## 2. 范围与非目标

- 本次包含：
  - `src/renderer/shared.css`：目标行分隔线改为不参与布局的 `::before` 直线上沿线；去掉 `border-top` 与 `margin-top`；顶部横排点阵（`dock-top`）改用竖直分隔线（横线会浮在图标上方，属于同一类框线杂音）。
  - `scripts/ui-render-check.cjs`：新增「目标行不撑出溢出/不出滚动条、行高仍为 32、分隔线为 1px 直线」断言；补存贴边目标行截图；贴边目标行夹具提前到目标行用例最前。
  - `deliverables/`：重生成含目标行的 README 截图（`overlay-current.png`、`dock-vertical.png`、`dock-horizontal.png`、`goals-overlay.png`），避免文档继续展示被框住的目标行。
  - 规格索引与本文档。
- 本次不包含：
  - 目标图标（靶心 SVG）造型、线宽、`--accent` 配色、进度环 `::after` 底色。
  - 贴边形态是否显示分隔线的取舍（本轮保留）。
  - 窗口尺寸/几何常量、任务行样式、滚动行为本身（长列表仍可滚动）。
  - 目标行内容、点击语义、`goalsSummary` 数据口径。
- 受影响模块/接口/用户文档：`src/renderer/shared.css`、`scripts/ui-render-check.cjs`；`docs/specs/README.md`。无配置、IPC、数据格式变化。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | 贴边纵向点阵（`dock=left`/`right`），3 任务 + 1 条进行中目标 | 真实 Electron 渲染悬浮灯 | `.strip-rows` 不溢出：`scrollHeight <= clientHeight`、`scrollWidth <= clientWidth`；不出现滚动条：`offsetWidth - clientWidth = 0`、`offsetHeight - clientHeight = 0`；行不被画布裁切 |
| AC-02 | 非贴边灯带，3 任务 + 1 条进行中目标 | 同上 | 目标行 `offsetHeight === 32`、计算样式 `border-top-width === 0px`；分隔线由 `::before` 绘制且高度 1px、直线不参与布局（行高仍 32） |
| AC-03 | 非贴边灯带，3 任务 + 1 条进行中目标 | 同上 | 目标行仍渲染图标、`目标 N` 文案、进度环（`display` 可见）与正确的 `--goal-progress`；点击行仍调用 `openGoals()`，不触发展开/收起面板 |
| AC-04 | 贴边点阵，3 任务 + 1 条进行中目标 | 同上 | 目标行仍只显示图标（进度环与文字隐藏），行高 32，点阵尺寸不裁切 |
| AC-05 | 无进行中目标 | 同上 | 目标行不渲染；灯带/点阵外观与 SPEC-025 之后一致（既有用例回归） |
| AC-06 | 现有测试与构建 | 执行 | `typecheck` / 全量测试 / `build` / `smoke` / `check:ui` / `check:goals` 全通过，无新增失败 |
| AC-07 | Windows 真机，贴边点阵且有进行中目标 | 用户查看悬浮灯 | 目标图标上方是细直线、右侧无灰色滚动条，图标不再被「框」住；用户确认 |
| AC-08 | 顶部横排点阵（`dock=top`），3 任务 + 1 条进行中目标 | 真实 Electron 渲染悬浮灯 | 目标行分隔线为竖直 1px 线（计算宽度 1px、高度 ≥16px），不再在图标上方画横线；行高 32、无溢出、无滚动条 |

边界、异常、恢复/停止行为：

- 任务很多（超出画布）时 `.strip-rows` 仍按原规则纵向滚动，滚动条属于预期行为；本轮只消除「内容本可容纳却被撑出溢出」的常驻滚动条。
- 目标行在 `dock=top` 横排时同样不吃 `margin-top`，行高横竖都保持 32，几何常量无需改动。
- 完全没有目标行时，本轮 CSS 不产生任何可见变化。
- 分隔线用 `::before` 绘制，`pointer-events: none`，不改变点击区域与 `:hover` 背景范围。

## 4. 方案与任务切片

最小方案（只改渲染层样式与夹具断言）：

1. `.strip-goal-row` 去掉 `border-top` 与 `margin-top`（不再改变行盒尺寸，也不在圆角上画弯钩）。
2. 新增 `.strip-goal-row::before`：绝对定位、`top: 0`、`height: 1px`、`left/right: 4px`（与行内 padding 对齐）、`background: var(--panel-border)`、`pointer-events: none`。只画线，不占布局高度。
3. 行节奏回到纯 32px：`.strip-rows` 内容高度与 `overlay-layout.ts` 的 `COMPACT_TILE`/`COMPACT_GAP`、`STRIP_ROW_STEP` 一致，贴边画布不再被撑溢出。
4. `body.dock-top .strip-goal-row::before` 改成竖直分隔线（`left: 0; top/bottom: 4px; width: 1px`）：横排点阵里行是横向排列的，横线会浮在图标上方，属于同一类框线杂音。

备选取舍：

- 改 `overlay-layout.ts` 给贴边画布加安全余量：能压住滚动条，但每行多出的 2px 仍会把目标行挤出行节奏，且要动几何常量与既有尺寸断言，故不取。
- 只加 `scrollbar-width: none`：滚动条看不见了，但 2px 溢出仍在（可滚动、行位置偏），且长列表失去滚动提示，故不取。
- 直接删掉分隔线：会让点阵形态下目标行与任务行完全同形，丢失 SPEC-025 的区分，故保留直线分隔。

任务切片：

1. **S1（Red）**：`check:ui` 新增 AC-01/AC-02/AC-04 断言，在未改 CSS 的构建上运行，确认因「4px gutter / 2px 溢出 / border-top 1px」失败。
2. **S2（Green）**：改 `shared.css`，重跑 `check:ui` 全绿，人工查看贴边截图确认框线消失。
3. **S3（Red → Green，AC-08）**：补贴边 `top` 目标行夹具 + 分隔线方向断言，先在旧样式上确认「横线 24px」失败，再加 `body.dock-top` 覆盖转绿。
4. **S4（回归）**：`typecheck` → 全量测试 → `build` → `smoke` → `check:goals`；更新索引与本文档。

## 5. 测试计划与追踪

| AC | 测试文件/完整用例名或真机步骤 | Red 证据 | Green 证据 | 回归/平台验收 |
| --- | --- | --- | --- | --- |
| AC-01、AC-03、AC-04 | `npm run check:ui`：贴边 `left` 夹具（`checkOverlay(3,'left',{active:2,done:1,progress:40})`，3 任务 + 目标行） | 2026-10-22 17:26 `npm run check:ui` exit 1：`AssertionError: stray scrollbar beside the goal row (x gutter)`，实际 4 !== 0（`.strip-rows` `clientWidth 28 / offsetWidth 32`、`scrollHeight 108 / clientHeight 106`） | 17:29 同命令 exit 0（31 cases）；加入横排夹具后 17:37 exit 0（`PASS: 32 real Electron rendering cases`）。贴边截图 `logs/spec012-ui/overlay-goals-left-3.png` 无滚动条、目标行 32px、进度环/文字按贴边规则隐藏 | 隐藏 Electron 渲染（非 OS 鼠标/DPI 验收） |
| AC-02、AC-03、AC-05 | `npm run check:ui`：非贴边目标行（3 任务 + 目标、0 任务 + 目标）与无目标行的 4 布局 × 4 任务数用例 | 2026-10-22 17:25 首跑 exit 1：`AssertionError: goal row must not paint a rounded border-top hook`，实际 `'1px' !== '0px'`（当时顺序为非贴边夹具先跑） | 17:29 exit 0：计算样式 `border-top-width: 0px`、`::before` 高度 1px、行高 32；截图 `overlay-goals-3.png`、`overlay-goals-0.png`、`overlay-goals-left-3.png` | 隐藏 Electron 渲染 |
| AC-06 | `npm run typecheck`、`npm test -- --maxWorkers=2 --minWorkers=1`、`npm run build`、`npm run smoke`、`npm run check:goals`、`git diff --check` | — | 见执行记录，全部 exit 0 | Windows 本机 |
| AC-07 | Windows 真机：贴边点阵 + 有进行中目标，用户查看目标行附近 | 修改前用户截图：目标行上方弯钩分隔线 + 右侧 4px 灰色滚动条 | 待用户确认（截图见 `deliverables/dock-vertical.png` 与 `logs/spec012-ui/overlay-goals-left-3.png`） | 用户确认 |
| AC-08 | `npm run check:ui`：顶部横排夹具（`checkOverlay(3,'top',{...})`） | 2026-10-22 17:36 `npm run check:ui` exit 1：`AssertionError: docked-top goal row needs a vertical divider`，实际 `'24px' !== '1px'` | 17:37 exit 0：计算宽度 1px、高度 24px（`top/bottom: 4px`）、行高 32、无滚动条；截图 `logs/spec012-ui/overlay-goals-top-3.png` | 隐藏 Electron 渲染 |

## 6. 执行记录

- 规格就绪依据、仍需澄清项：用户已确认现象与位置（贴边点阵目标行上方的带弯钩分隔线 + 右侧 4px 滚动条），无需再澄清。分隔线保留（SPEC-025 的区分作用），只去掉弯钩与常驻滚动条。
- 修改前状态：工作区干净，`7aadfa7`；`dist/` 由该提交构建。旧 CSS 上 `check:ui` 31 用例通过（2026-10-22 14:05），说明 2px 溢出/弯钩是长期存在但无断言覆盖的缺陷，不是本轮引入。
- 复现与定位（真实 Electron 夹具，改动前）：贴边 `left` + 2 任务 + 目标行时 `.strip-rows` `offsetWidth−clientWidth = 4`（4px 竖滚动条）、`scrollHeight 108 > clientHeight 106`（2px 溢出）；根因是 `.strip-goal-row` 的 `margin-top: 2px` 未计入 `overlay-layout.ts` 的 32px 行节奏，加上 `border-top` 在 `border-radius: 8px` 上画出两端弯钩。
- 切片 Red → Green：
  - S1（Red，17:25–17:26）：先加 `check:ui` 断言（滚动条/溢出、行高 32、`border-top 0px`、`::before` 1px）。首跑失败在 `goal row must not paint a rounded border-top hook`（`'1px' !== '0px'`）；把贴边目标行夹具提前后复跑，失败在 `stray scrollbar beside the goal row (x gutter)`（`4 !== 0`）。两次均 exit 1。
  - S2（Green，17:29）：`shared.css` 去掉 `border-top`/`margin-top`，分隔线改 `::before`；`npm run build` exit 0 后 `npm run check:ui` exit 0（31 cases PASS）。
  - S3（Red → Green，AC-08，17:36–17:37）：补 `top` 横排夹具与分隔线方向断言，旧样式上失败 `docked-top goal row needs a vertical divider`（`'24px' !== '1px'`，exit 1）；加 `body.dock-top` 竖直分隔线后 `npm run build` exit 0、`npm run check:ui` exit 0（32 cases PASS），截图 `overlay-goals-top-3.png`。
  - S4（回归，17:38–17:39，最终交付状态）：`npm run typecheck` exit 0；`npm test -- --maxWorkers=2 --minWorkers=1` 64 files / 928 tests passed，exit 0；`npm run smoke` exit 0；`npm run check:goals` exit 0（PASS：目标窗口真实 IPC 集成）。此前一次同口径回归（17:31–17:34）也是 typecheck 0 / 928 passed / build 0 / smoke 0 / check:goals 0，`git diff --check` exit 0。
- 附加自检（`none`/`left`/`top` × 浅色/深色，含目标行）：三种布局都 `gutterX = gutterY = 0`、`scrollHeight === clientHeight`、目标行 `offsetHeight 32`、`border-top-width 0px`、分隔线为 1px 直线（横排为竖直方向）且颜色为 `--panel-border`；`top` 横排的目标行也从 34px 回到 32px。
- 文档图像：重生成 `deliverables/overlay-current.png`、`dock-vertical.png`、`dock-horizontal.png`（`scripts/readme-shots.cjs`）与 `goals-overlay.png`（`logs/spec012-ui/overlay-goals-3.png` 同场景）。`panel-current.png` 仅有与本轮无关的 7×8px 渲染抖动，已还原不提交。
- TDD 例外：无；本轮为渲染层行为，用真实 Electron 渲染夹具断言（纯 CSS 单测无法观察滚动条与 `::before` 绘制）。
- 需求变更记录：无。

## 7. 交付与验收

- [x] 渲染层 AC-01 ~ AC-05、AC-08 有真实 Electron 夹具断言与截图证据；AC-06 的类型检查/全量测试/构建/smoke/check:goals 已记录；AC-07 真机待用户确认。
- [x] 类型检查、全量测试、构建后 smoke 及相关集成检查结果已记录（见执行记录）。
- [x] 规格索引、README 截图已更新；没有秘密或本机配置进入提交。
- [ ] AC-07 Windows 真机确认后改 `done`；当前保持 `verifying`，未提交（用户未要求提交）。

最终结果/提交引用：代码在工作区（`src/renderer/shared.css`、`scripts/ui-render-check.cjs`、`deliverables/*`、规格与索引），未提交。待用户真机确认贴边点阵下目标行不再被框住后改为 `done`。
