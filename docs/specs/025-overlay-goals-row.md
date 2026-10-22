# SPEC-025：悬浮灯「目标」行与新目标图标

> 状态：done
> 类型：feature（显示集成）
> 需求来源：用户 2026-10-22 会话——「我希望能显示在指示灯那个悬浮窗上，新设计个同样风格的图标」；SPEC-024 已交付目标窗口，本轮只做悬浮灯展示，不改目标数据语义。
> 负责人：lead + 开发者
> 基线提交：`4d56980` + SPEC-024 未提交工作区。
> 需求依据及假设：目标行显示「进行中数量 + 平均进度环」，点击打开目标窗口；不显示标题（浮窗空间有限），不新增配置项；已完成目标不常驻浮窗（避免常驻一行已完成）。
> 关联/替代条款：与 SPEC-024 共存；不改变 BASELINE-000 的状态机、可见性隐藏规则与任务行行为。

## 1. 问题与目标

SPEC-024 的目标清单只能从托盘/任务面板打开，悬浮灯上看不到目标。用户希望悬浮窗里也有一个与工具图标同风格的「目标」入口，一眼知道有多少进行中目标和平均推进程度，点击即可打开目标窗口。

目标行为：有进行中目标时，灯带底部出现一行（目标图标 + 平均进度环 + `目标 N`）；无进行中目标时不出现；点击打开目标窗口。没有进行中目标时，悬浮灯的形态与行为与之前完全一致。

## 2. 范围与非目标

- 本次包含：
  - `Snapshot.goalsSummary`（`active` / `done` / `progress`），由 `GoalsStore` 变更同步进 `TaskStore`；目标列表本身不进入快照。
  - 悬浮灯目标行：新图标、进度环、`目标 N`、点击打开目标窗口。
  - 灯带/单灯形态判定纳入目标行；`resolveCanvasSize` 支持强制灯带，保证 0/1 个任务 + 目标行时窗口尺寸不裁切。
  - 图标在悬浮灯、任务面板「目标」按钮、目标窗口标题三处复用同一路径。
  - 单元测试、`check:ui` 夹具、`check:goals` 集成回归。
- 本次不包含：
  - 目标行显示具体目标标题/时间线；目标行内直接改进度或勾选完成。
  - 已完成目标的常驻行、目标提醒/通知、多目标轮播。
  - 新的配置项、窗口尺寸/位置变化、拖拽顺序。
  - 改变任务行的过滤/颜色/点击语义。
- 受影响模块/接口/用户文档：
  - `src/shared/types.ts`、`src/shared/visibility.ts`、`src/main/store.ts`、`src/main/overlay.ts`、`src/main/overlay-layout.ts`、`src/main/goals-store.ts`、`src/main/index.ts`、`src/renderer/overlay.ts`、`src/renderer/ui.ts`、`src/renderer/panel.ts`、`src/renderer/goals.html|ts|css`、`src/renderer/shared.css`、`scripts/ui-render-check.cjs`、`scripts/ui-render-preload.cjs`。
  - 用户文档：`README.md`、规格索引、本规格。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | 已存在至少 1 条进行中目标（无论是否有可见任务） | 目标数据加载完成 / 悬浮灯收到快照 | 灯带底部出现「目标」行：目标图标 + 进度环 + `目标 N`（N = 进行中数量）；不会出现两行 |
| AC-02 | 没有进行中目标（无目标，或全部已完成） | 悬浮灯收到快照 | 目标行不渲染；悬浮灯形态与 SPEC-024 之前一致（可见任务 < 2 时为单灯） |
| AC-03 | 3 条进行中目标，进度分别为 40/60/20，1 条已完成 | 悬浮灯渲染 | 进度环数值为 40（平均后四舍五入）；`目标 3`；已完成目标不计入数量和平均 |
| AC-04 | 0 个可见任务、1 条进行中目标 | 悬浮灯渲染 | 使用灯带形态（总灯 + 目标行）并正确尺寸；画布不裁切内容（含投影留白） |
| AC-05 | 1 个可见任务、1 条进行中目标 | 悬浮灯渲染 | 使用灯带形态（任务行 + 目标行）；窗口高度比只有任务行时多一行，不裁切最后一行 |
| AC-06 | 已贴边（左/右/顶部）进入点阵形态，且有进行中目标 | 悬浮灯渲染 | 目标行只显示目标图标（文字与进度环隐藏）；点阵尺寸容纳该行且不裁切 |
| AC-07 | 目标行已显示 | 点击目标行 | 打开目标窗口；已打开时聚焦；不触发展开/收起任务面板 |
| AC-08 | 目标窗口/面板已打开 | 查看面板标题栏「目标」按钮与目标窗口标题 | 两处均使用同一个目标图标（本地 SVG，无远程资源） |
| AC-09 | 目标数据变更（新增、改进度、完成、删除） | 悬浮灯收到推送 | 目标行数量/进度环即时更新；全部完成时整行消失（不残留） |
| AC-10 | 无目标功能数据（`goalsSummary` 为 undefined） | 悬浮灯/快照 | 行为与本规格前完全一致；任务行颜色、点击、隐藏规则不变 |
| AC-11 | 现有测试与构建 | 执行 | typecheck / 全量测试 / build / smoke / check:ui / check:goals 全通过，无新增失败 |
| AC-12 | Windows 真机 | 重启后观察灯带、点击目标行、贴边点阵、DPI/多屏 | 行内容/进度环可辨、不裁切、点击打开目标窗口；无目标时不出现空行 |

边界、异常、恢复/停止行为：

- `goalsSummary.active` 为 0 或 `undefined`：不渲染目标行；`stripMode` 不因目标行变化。
- 目标数量很多时：标签 `目标 N` 由 `.strip-port` 的 `max-width: 80px` + ellipsis 兜底；不撑宽浮窗。
- 进度环数值强制 0–100（四舍五入后仍夹取）；非法数据不导致渲染异常。
- 目标摘要只在值变化时 `commit`，避免每次目标变更都推送一次灯带。
- 目标窗口关闭/隐藏不影响目标行；目标数据读取失败时摘要按已加载数据计算，不阻塞悬浮灯。
- 单灯模式下目标行不显示（灯带隐藏时其 DOM 会被清理），不会留下幽灵行。

## 4. 方案与任务切片

### 4.1 数据与判定

- `shared/types.ts`：`GoalsSummary`；`Snapshot.goalsSummary?: GoalsSummary`。
- `main/goals-store.ts`：`summarizeGoals(view)` 纯函数——active 数、done 数、active 平均进度四舍五入（无 active 时为 0）。
- `shared/visibility.ts`：`shouldShowStrip(visibleTaskCount, goalRowCount)`——目标行 > 0 或任务 ≥ 2 时用灯带。
- `TaskStore`：`setGoalsSummary()`（值不变不提交）；`getSnapshot().stripMode` 走 `shouldShowStrip`；快照携带 `goalsSummary`。
- `main/index.ts`：`goalsStore.onChange(view => { goalsWindow.setView(view); store.setGoalsSummary(summarizeGoals(view)); })`，启动时同步一次。

### 4.2 窗口尺寸

- `main/overlay-layout.ts`：`resolveCanvasSize(..., forceStrip=false)`；`forceStrip` 时 1 行也走灯带，0 行仍退回单灯。
- `main/overlay.ts`：`stripTaskCount()` = 可显示任务数 + 目标行数（`goalsSummary.active > 0`）；`resolveCanvasSize(..., snapshot.stripMode)` 传入权威形态。

### 4.3 渲染与图标

- `renderer/ui.ts`：新增 `goals` 图标（靶心 + 十字刻度，24×24、stroke 1.65，与现有工具图标同风格）。
- `renderer/overlay.ts`：目标行固定在任务行之后；图标 + `.strip-goal-ring`（conic-gradient 平均进度）+ `目标 N`；点击调用 `openGoals()`；无 active 时移除整行。
- `renderer/panel.ts`：面板「目标」按钮用同一图标（替代 `◎`）。
- `renderer/goals.html|ts|css`：目标窗口标题前显示同一图标。
- `renderer/shared.css`：目标行样式、进度环、贴边点阵隐藏文字/进度环。

### 4.4 任务切片

1. **S1 数据与形态判定**：`summarizeGoals`、`shouldShowStrip`、`TaskStore.setGoalsSummary`/`stripMode`。测试：`test/goals-summary.test.ts`。
2. **S2 尺寸**：`resolveCanvasSize` 的 `forceStrip`。测试：`test/overlay-layout.test.ts`。
3. **S3 渲染**：目标行 DOM/图标/环/点击、面板与目标窗口图标。验证：`check:ui` 新增 overlay goals 夹具（含 0 任务仅目标、3 任务+目标、贴边点阵）。
4. **S4 集成回归**：`check:goals` + 全量测试 + smoke。

## 5. 测试计划与追踪

| AC | 测试文件/完整用例名或真机步骤 | Red 证据 | Green 证据 | 回归/平台验收 |
| --- | --- | --- | --- | --- |
| AC-03、AC-09（数据） | `test/goals-summary.test.ts`：summarizeGoals 空列表/平均/四舍五入/全完成 | 首次运行前摘要函数已按规格实现；本组用例首跑通过（实现随 Red 批次同期落地，不是先实现后补测） | 2026-10-22 12:24 通过 | 全量 909 passed |
| AC-01、AC-02、AC-10（形态） | `test/goals-summary.test.ts`：TaskStore 无摘要单灯 / 1 任务+目标灯带 / 摘要不变不推送 / 清零回单灯 / 2 任务灯带 | 2026-10-22 12:24 首跑：3 failed（`goalsSummary` undefined、`stripMode` false），exit 1 | 同日 12:24 复跑：56 passed（含 overlay-layout） | 全量 |
| AC-04、AC-05（尺寸） | `test/overlay-layout.test.ts`：forceStrip 1 行/0 行/关闭 | 同上首跑：forceStrip 用例 failed（52×52 vs 164×130） | 复跑通过 | 全量 |
| AC-01、AC-04、AC-05、AC-06、AC-07、AC-08 | `npm run check:ui`：overlay goals 夹具（3 任务+目标、0 任务+目标、贴边+目标），断言行内容、图标、进度环、点击调用 `openGoals`、无目标不渲染、窗口不裁切 | — | 2026-10-22 12:26 PASS 31 cases（新增 3 个 overlay 目标场景） | 隐藏 Electron 渲染；截图 `logs/spec012-ui/overlay-goals-3.png` |
| AC-09（集成） | `npm run check:goals` + 既有目标窗口集成 | — | 2026-10-22 12:27 PASS | 真实 GoalsWindow/IPC |
| AC-11 | typecheck / 全量测试 / build / smoke | — | 2026-10-22 12:26–12:27 全通过；全量 909 tests | — |
| AC-12 | Windows 真机：重启后看灯带、点击目标行、贴边点阵、DPI/多屏 | — | 2026-10-22 12:31 用户重启并新增目标后确认：「没问题」（目标行显示、点击打开、完成后消失） | 用户真机确认通过 |

命令与结果：`npm run typecheck` exit 0；`npm test -- --maxWorkers=2 --minWorkers=1` 62 files / 909 tests passed；`npm run build` exit 0；`npm run smoke` exit 0；`npm run check:ui` 31 cases PASS；`npm run check:goals` PASS。

## 6. 执行记录

- 规格就绪依据、仍需澄清项：用户明确要求悬浮窗展示 + 同风格图标；显示内容（数量 + 平均进度）为本轮设计决定，若用户希望显示具体标题/百分比文字可再改。
- 修改前回归：SPEC-024 收尾时 typecheck / 897 tests / build / smoke / check:ui / check:goals 全通过。
- 切片 Red → Green → Refactor：
  - S1/S2 Red：`npm test -- test/goals-summary.test.ts test/overlay-layout.test.ts` → 3 failed / 53 passed，exit 1（快照缺 `goalsSummary`、`stripMode` 未纳入目标行、`forceStrip` 未生效）。
  - Green：实现 `summarizeGoals` 接入、`shouldShowStrip`、`resolveCanvasSize(forceStrip)` 后 56 passed。
  - S3 渲染：`check:ui` 新增 3 个 overlay 目标夹具，首跑暴露并修正夹具断言（目标行无状态点、点击计数），最终 31 cases PASS。
  - S4：全量 909 / smoke / check:goals PASS。
- TDD 例外：渲染行与图标为 DOM/Electron 行为，由 `check:ui` 真实 Electron 夹具覆盖；OS 点击/DPI 仍待真机。
- 需求变更记录：2026-10-22 用户确认 SPEC-024 真机通过，并提出悬浮灯展示与图标需求。

## 7. 交付与验收

- [x] 所有 AC 有验收证据；满足[流程 DoD](../development/spec-tdd.md)。
- [x] 类型检查、全量测试、构建后 smoke 及所需真机验证结果已记录（真机 2026-10-22 用户确认通过）。
- [x] 相关文档、规格索引、配置示例已更新；没有秘密或本机配置进入提交。
- [x] 已知失败接受依据（如适用）、未完成项、回退步骤、发布状态已说明。

最终结果/提交引用：2026-10-22 用户真机确认通过；代码在工作区（尚未提交，用户未要求提交）。
