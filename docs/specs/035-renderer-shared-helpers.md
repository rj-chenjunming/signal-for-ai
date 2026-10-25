# SPEC-035：渲染层共享助手收敛（shared-ui.ts）

> 状态：done
> 类型：refactor（纯重构，不改外部行为）
> 需求来源：用户 2026-10-24 批准的重构顺序 R-A「渲染层共享胶水收敛」（前序讨论：SPEC-034 之前 formatTime/statusLabel 的两份实现已实际漂移过一次）。
> 负责人：AI 协作（dreaming）
> 基线提交与环境：工作区为 SPEC-031~034 完成后未提交状态；Windows 10.0.26200 x64，Node v24.16.0；Electron 夹具验证运行时 31.7.7（`AITI_ELECTRON`，见 SPEC-031 §6 环境记录）。
> 需求依据及假设：三份 classic script 各自复制胶水——`formatTime`（goals.ts，曾与主进程漂移）、状态文案两套（overlay.ts `statusLabel` 函数 + panel.ts `STATUS_VISUAL.label` 字段）、`el()`（goals.ts）。已有 `ui.ts`（`window.aiIndicatorUi`，三页共享图标）证明共享 classic script 模式可行且加载顺序已就绪。假设：toast 不收敛——三窗口 toast 的 DOM 结构与计时刻数不同（overlay 4s 定长 / goals 按文案长度 3–10s），合并即行为变更，超出纯重构。
> 关联/替代条款：SPEC-034（时间格式锚，重构后由 `window.aiUi.formatTime` 单点承载）；架构 D1/D2（原生 TS + tsc + 静态复制，不引入打包器——本规格完全遵守）。

## 1. 问题与目标

重复实现是漂移温床：SPEC-034 已经抓到一次（渲染层/主进程时间格式不一致），渲染层内部的状态文案也存两份（overlay 函数与 panel 映射字段），新增窗口（goals）又复制了 `el()`。目标：`src/renderer/shared-ui.ts` 以 `window.aiUi` 暴露 `formatTime / statusLabel / el`，三张 HTML 在窗口脚本前加载（与 `ui.js` 同一模式、同一位置）；三个窗口文件删除各自的本地副本。**外部行为零变化**。

## 2. 范围与非目标

- 本次包含：`src/renderer/shared-ui.ts`（新增）、`src/renderer/globals.d.ts`（`AiUiHelpers` + `Window.aiUi?`）、三张 HTML 各加一行 `<script src="./shared-ui.js">`、`goals.ts / overlay.ts / panel.ts` 改用共享助手并删本地副本、`test/overlay-actions.test.ts` 的 window stub 补 `aiUi`、`scripts/ui-render-check.cjs` 补特征断言与接线断言。
- 本次不包含：toast 收敛（见假设，属行为变更）；`formatDuration`（仅 panel 一份，无重复）；主进程 `formatGoalTime` 与渲染层合并（跨进程无法共享实现，继续靠测试锚互指，见 SPEC-034）；测试基建 AITI_ELECTRON 之外的任何依赖/构建变更。
- 受影响模块：上述渲染层文件；构建零改动（`tsconfig.electron.json` 的 include 通配已覆盖新文件，`copy-renderer.mjs` 整目录拷贝编译产物）。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | 重构前基线代码 | check:ui 新增特征断言：overlay 第一行 aria-label 以「运行中」结尾、panel 首行 `.task-status-label` 以「运行中」开头 | 原代码上通过（特征测试先行，纯重构流程） |
| AC-02 | 重构后 | 三张页面（overlay/panel/goals）`window.aiUi` 均为对象且 `formatTime/statusLabel/el` 为函数 | check:ui 三页面接线断言通过 |
| AC-03 | 重构后 | 全量回归：check:ui、check:goals、`npm test`、typecheck、build、smoke | 与 SPEC-031~034 完成时同基线全绿，无行为差异 |
| AC-04 | 源码检查 | `goals.ts / overlay.ts / panel.ts` 不再含 `formatTime`/`statusLabel`/`el` 的本地实现（引用共享助手） | 代码评审 + noUnusedLocals/typecheck 通过 |

边界、异常、恢复/停止行为：`window.aiUi` 类型为可选（与 `aiIndicatorUi` 同风格）；生产页面由 HTML 加载顺序保证存在，若缺失属于接线错误，由 check:ui 三页接线断言与 check:goals 真实 HTML 集成捕获。overlay 单测的 window stub 提供 `aiUi` 替身（与既有 `aiIndicator` stub 同理）。

## 4. 方案与任务切片

1. 切片 1（特征测试先行）：check:ui 加 AC-01 两条断言 → 在**未重构**代码上运行记录 Green。
2. 切片 2（重构）：新增 shared-ui.ts / globals.d.ts 声明 / HTML script 标签 / 三窗口切换 / 测试 stub，加 AC-02 接线断言 → 全量回归。

## 5. 测试计划与追踪

| AC | 测试文件/完整用例名或真机步骤 | Red 证据 | Green 证据 | 回归/平台验收 |
| --- | --- | --- | --- | --- |
| AC-01 | `scripts/ui-render-check.cjs` checkOverlay 特征锚（strip 形态 aria-label 以「运行中」结尾）+ checkPanel 特征锚（`.task-status-label` 以「运行中」开头） | Red 不适用（纯重构；特征测试在原代码通过即为证据） | 已记录（见 §6） | 已记录 |
| AC-02 | 同脚本三页面 `aiUiWired` 接线断言 | 不适用（接线断言随重构引入） | 已记录（见 §6） | 已记录 |
| AC-03 | typecheck / npm test / build / smoke / check:ui / check:goals | 不适用 | 已记录（见 §6） | 已记录 |
| AC-04 | 代码评审 + grep（窗口文件 0 处本地定义，shared-ui.ts 3 处）+ tsc | 不适用 | 已记录（见 §6） | 已记录 |

## 6. 执行记录

- 规格就绪依据：用户已批准 R-A；模式先例（ui.ts）与构建链已核实。
- 修改前回归：SPEC-034 完成时全绿（typecheck 0 / test 939 / build 0 / smoke 0 / check:ui 35 用例 0 / check:goals 0），同工作区。
- **切片 1（特征测试先行）**：check:ui 加 AC-01 两条特征锚后在**未重构**代码上运行——退出码 0（35 用例）。过程修订两处断言守卫（均属断言前提错误，非实现问题）：strip 行文案只在灯带形态（count≥2）存在，单灯模式无 strip 行；panel 暂停夹具的状态标签是「监控已暂停」，不在本锚范围。
- **切片 2（重构）**：新增 `shared-ui.ts`（`window.aiUi = { statusLabel, formatTime, el }`）+ `globals.d.ts` 的 `AiUiHelpers`/`Window.aiUi` + 三张 HTML 在 ui.js 前插入 shared-ui.js + 三窗口文件删除本地副本改用共享版 + 两个 vitest stub（overlay-actions/ui-panel）补 `aiUi` 替身（窗口脚本现在加载即解构）+ 三页面 `aiUiWired` 接线断言。
- **切片 2 回归**（全部真实退出码）：typecheck 0；`npm test` 939/939；build 0（产物含 `dist/renderer/shared-ui.js`）；check:ui 35 用例 0（含 AC-02）；check:goals 0（真实 HTML 加载链路）；smoke 0。与 SPEC-034 完成基线一致，无行为差异。
- 过程记录：一次误编辑删掉了 goals.ts 的 SPEC-031 注释块，随即恢复（最终文件已核对含完整注释）。
- TDD 例外：本规格为纯重构——AC-01 特征测试先行并在原代码通过；AC-02 接线断言为新接线（随重构引入，无 Red 语义）；无行为 Red。
- 「Electron 33 复核」挂起项由 SPEC-039 解除（根因为仓库 ACL 毒化，与版本无关；解毒后夹具回归 pin 版全过）。2026-10-25 真机验收期间三页渲染全程正常。
- 需求变更记录：无。

## 7. 交付与验收

- [x] 所有 AC 有验收证据；满足[流程 DoD](../development/spec-tdd.md) 的自动化部分。
- [x] 类型检查（0）、全量测试（939/939）、构建（0）、smoke（0）、check:ui（35 用例，0）、check:goals（0）已记录——验证运行时 Electron 31.7.7（同 SPEC-031 环境记录）。
- [x] 规格索引已更新；无秘密入库。
- [ ] 真机/Electron 33 复核（同 SPEC-031 挂起项）→ 保持 `verifying`。

最终结果/提交引用：未提交（与 SPEC-031~034 同一工作区，等待检视）。
