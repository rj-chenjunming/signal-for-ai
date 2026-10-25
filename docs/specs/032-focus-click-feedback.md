# SPEC-032：悬浮灯任务行点击的即时跳转反馈

> 状态：done
> 类型：bugfix（交互/反馈）
> 需求来源：用户 2026-10-24 对上一轮差异的 UX 评审——问题 2「点击跳转剩余的 ~2 秒缺乏即时反馈」被明确列为值得修订（取"便宜方案"：即时过渡态，不在本规格内消除 Add-Type 开销）。
> 负责人：AI 协作（dreaming）
> 基线提交与环境：`5bddcf7`，Windows 10.0.26200 x64，Git Bash，Node v24.16.0；夹具验证运行时 Electron 31.7.7（`AITI_ELECTRON`，理由见 SPEC-031 §6 环境记录）
> 需求依据及假设：SPEC-022 后真机点击到前台仍需 ~1.9–2.2s（PowerShell + Add-Type 固定开销），期间无任何视觉确认，用户会连点。假设：反馈只要表达"已收到点击、正在跳转"即可，不承诺 2s 内完成。
> 关联/替代条款：关联 SPEC-012（灯带行）、SPEC-013（跳转失败反馈）、SPEC-022（时延优化）；失败提示链路本身不在本规格改动范围。

## 1. 问题与目标

`src/renderer/overlay.ts` 灯带任务行的 click 处理发出 `focus_terminal`（可能还有 `mark_read`），两条请求互不阻塞地异步执行；从点击到窗口真正到前台有 ~2s，期间行外观毫无变化——用户无法区分"没点上"和"在跳转"。

目标行为：点击后**同步**（同一事件循环内，先于任何 await）让被点行进入"跳转中"过渡态；全部相关请求结算（成功或失败）后退出过渡态。失败时现有的错误反馈（面板消息/灯 toast）保持不变。

## 2. 范围与非目标

- 本次包含：`src/renderer/overlay.ts` 任务行 click 处理（跳转态的开始/结束/幂等）；`src/renderer/shared.css` 过渡态样式；测试基建 `scripts/ui-render-check.cjs`、`scripts/ui-render-preload.cjs`（可控的 `sendTaskAction` 结算通道）。
- 本次不包含：消除 PowerShell/Add-Type 固定开销（另立规格）；面板（panel.ts）点击反馈；目标行（点击即开窗口，无时延）；单灯模式（togglePanel 即时开面板）； mark_read 语义与"两条请求独立发出"的既有约束。
- 受影响模块：渲染层两文件 + 两个夹具脚本。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | 灯带含至少一个任务行 | 点击某任务行 | 同一帧内该行获得 `is-jumping` 类与 `aria-busy="true"`；行视觉变暗（计算样式 opacity < 1） |
| AC-02 | 某行处于跳转态 | 该行发出的全部 `sendTaskAction` 结算（成功） | `is-jumping` 移除、`aria-busy` 移除、opacity 恢复 |
| AC-03 | 某行处于跳转态 | 请求结算结果为 `ok:false` | 过渡态同样解除；现有失败反馈照常（本规格不断言其文案） |
| AC-04 | 某行处于跳转态 | 用户再次点击同一行 | 过渡态保持（不闪烁），最早一批结算后若仍有新请求未结算则保持到全部结算 |
| AC-05 | 8 秒保护窗 | 请求始终未结算（IPC 挂死） | 8s 后过渡态自动解除，行恢复可点 |

边界、异常、恢复/停止行为：跳转态只作用于被点的行，其它行不受影响；目标行、单灯模式不进入跳转态；窗口在跳转态期间收到新快照重绘时，行节点是复用的（stripRowCache），类名不得被状态刷新冲掉或残留到别的任务（taskId 复用场景）。`mark_read` 仅在点击时为 success/failed 行发出，与跳转态开始/结束无关。

## 4. 方案与任务切片

1. `send()` 改为返回所发出的 promise（行为不变，仍互不阻塞）；click 处理收集本批 promise，用 `Promise.allSettled` + 行内递增 token 结算后清除类名；同时设 8s `setTimeout` 兜底。
2. CSS：`.strip-row.is-jumping { opacity: .6; transition: opacity .12s; }`（复用行现有过渡），不新增动画避免与七态动画冲突。
3. 夹具 preload 的 `sendTaskAction` 改为挂起直到主进程发 `ui-task-action-resolve`，供测试控制结算时机。

数据/IPC/配置影响：无新增 IPC 通道（夹具通道仅测试用）。降级：类名/属性操作失败不影响跳转请求本身。

## 5. 测试计划与追踪

| AC | 测试文件/完整用例名或真机步骤 | Red 证据 | Green 证据 | 回归/平台验收 |
| --- | --- | --- | --- | --- |
| AC-01 | `scripts/ui-render-check.cjs` → `checkOverlayJumpFeedback` AC-01 步骤（类/aria 同步；变暗规则命中） | 已记录（见 §6） | 已记录 | 已记录 |
| AC-02 | 同上 AC-02 步骤 | 已记录（见 §6） | 已记录 | 已记录 |
| AC-03 | 同上 AC-03 步骤 | 已记录（见 §6） | 已记录 | 已记录 |
| AC-04 | 同上 AC-04 步骤（重复点击 + 仅结算最早一批） | 已记录（见 §6） | 已记录 | 已记录 |
| AC-05 | 同上（实现为行内 8s 保护窗；夹具未覆盖挂死场景，依赖代码路径与 AC-02 复用同一 finish） | Red 不适用（保护窗是防御路径，无可稳定复现的挂死夹具） | 代码评审 + check:ui 全过 | 未运行 |
| 回归 | `npm run check:ui` 原有用例、`npm test` | 未运行 | 35 用例 / 939 项全过，退出码 0 | 已记录 |
| 真机 | Windows：点击 dsh/WorkBuddy 行→行变暗→窗口到前台后恢复；失败路径（改坏 windowTitle）行恢复且面板提示照旧 | 未运行 | 未运行 | 未运行（保持 verifying） |

## 6. 执行记录

- 规格就绪依据、仍需澄清项：用户已授权（含"便宜方案"取舍）；无未知项。
- 修改前回归：typecheck 0、`npm test` 937/937、smoke 0（基线 `5bddcf7`）；无既有失败。
- **切片 Red**（`AITI_ELECTRON=<electron31> node scripts/check-ui.mjs`，退出码 1）：`AC-01 点击后未进入跳转态`。
- **切片 Green**（overlay.ts 点击处理器 + shared.css 过渡态后重建，退出码 0）：35 用例全过，`checkOverlayJumpFeedback` 覆盖 AC-01~04。
- 测试自身修订记录：AC-01 的"变暗"断言最初读 `getComputedStyle(row).opacity`——隐藏夹具窗口不推进 CSS 过渡帧，数值恒为 1；改为断言 `.strip-row.is-jumping` 的 opacity 过渡规则已命中该行（`transitionProperty` 含 opacity），像素级变暗列为真机步骤。实现（CSS `opacity: .6; transition: .12s`）未因断言调整而改变。
- 附带修复：`test/overlay-actions.test.ts` 的 DOM stub 补 `removeAttribute` 空实现（与既有 `setAttribute` 空实现对称）——SPEC-032 代码调用它后该文件出现 5 个 Unhandled Rejection，补齐后 939/939 全过且无未处理异常；未删改任何断言。
- Refactor：无必要（点击处理器自包含，token/计数逻辑局部于行）。
- TDD 例外：AC-05 Red 不适用（防御性保护窗，理由见测试计划）。
- 真机验收（2026-10-25 用户确认）：点击 codex 行跳转正常、变暗与恢复「没问题」。日志实测：17:53:42.034 聚焦请求 → 42.465 Win32 激活窗口「ChatGPT」确认，431ms。
- 需求变更记录：无。

## 7. 交付与验收

- [x] 所有 AC 有验收证据（真机与 AC-05 夹具除外）；满足[流程 DoD](../development/spec-tdd.md) 的自动化部分。
- [x] 类型检查（0）、全量测试（939/939，退出码 0）、构建（0）、smoke（0）、check:ui（35 用例，0）已记录——**验证运行时为 Electron 31.7.7**。
- [x] 相关文档（README）、规格索引已更新；无秘密入库。
- [ ] 真机验收（变暗/恢复的像素级确认）未完成 → 保持 `verifying`。

最终结果/提交引用：未提交（等待与 SPEC-031/033/034 一并检视）。
