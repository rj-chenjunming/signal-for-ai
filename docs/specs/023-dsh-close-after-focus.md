# SPEC-023：dsh 点击后窗口无法关闭（回归）

> 状态：done
> 类型：bugfix（回归）
> 需求来源：2026-10-22 09:40 用户反馈“点击小鲸鱼图标，起来的窗口关闭不了”；2026-10-22 09:39 日志显示 dsh 走 Win32 最小化→恢复。
> 负责人：待填写（Lead）
> 基线提交与环境：`8b3ce8f` + 当前未提交工作区；Windows 10.0.26200；Electron 33.4.11；dsh 0.2.1-rc.2 `127.0.0.1:56388`。
> 需求依据及假设：dsh 的窗口必须经其自身单实例 handoff 恢复，直接 Win32 `SW_MINIMIZE`/`SW_RESTORE` 会破坏其关闭行为（SPEC-014 已记录）；本次修复不改变 WorkBuddy 路径。
> 关联/替代条款：修订 SPEC-020 中“可见 `windowTitle` 保持 Win32”的 dsh 分支；保留 SPEC-022 的缓存优先与前台确认。

## 1. 问题与目标

**现象**：点击悬浮灯的 dsh 行后，窗口能到前台，但点 X 无法正常关闭。2026-10-22 09:39:18 / 09:39:36 日志均为 `已通过 Win32 激活窗口「… — DeepSeek Harness」`。

**根因**：SPEC-020 为避免“可见但未聚焦的 dsh 走 handoff 后前台确认失败”，把可见/最小化的 `windowTitle` dsh 仍交给 `focusExistingWindow` → `activateViaWin32`。该脚本为了保证前台权限执行 `ShowWindow(SW_MINIMIZE)` → `SW_RESTORE`；SPEC-014 已确认这个往返会破坏 dsh 自身的关闭处理（当时改用单实例 handoff 才修好）。本次回归正是 dsh **可见**时又走了这条路径。

**目标**：dsh 的显式窗口目标（visible / minimized / hidden，`windowTitle` 或 `windowProcess`）**一律经 dsh 自身单实例 handoff 恢复**，绝不对 dsh 执行 `SW_MINIMIZE`；仍必须真实前台确认后才报成功。

## 2. 范围与非目标

- 包含：`FocusService.activate` 的 dsh 路由；原生恢复脚本的“无最小化”前台补齐；测试与真机 X 关闭验收。
- 不包含：WorkBuddy 路由变化；改变 Win32 非 dsh 工具激活算法；改变 handoff 超时/安全检查；新增依赖。
- 受影响：`src/main/focus.ts`、`src/main/native-window-reveal.ts`、相关测试与规格索引。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | dsh 窗口可见、隐藏或最小化，配置声明了 dsh 进程名 | 点击 dsh 行 | 走 `LAMPDSHREAL` 原生恢复，不出现 `LAMPFOCUS`/`SW_MINIMIZE`；窗口到前台后 X 能正常关闭/回后台（用户真机确认） |
| AC-02 | dsh 可见但不在前台 | 点击 dsh 行 | 仍能到前台；若 handoff 后前台未确认，返回失败反馈，但不通过最小化/恢复强抢，避免再次破坏 X |
| AC-03 | WorkBuddy 与其他工具 | 点击 | 原路由与行为不变；SPEC-022 的缓存/前台确认不回退 |
| AC-04 | 本次改动 | 交付前 | 新增路由/脚本测试 Red→Green；typecheck、全量 test、build、smoke 全绿 |

**边界**：不结束 dsh 进程；不自动点击 X；真机 X 验收由用户完成，Agent 不通过关闭窗口来测试（会中断当前会话）。

## 4. 方案与任务切片

1. 切片 A（Red）：`focus-hidden-window`/`focus` 测试断言可见 dsh 的 `windowTitle` 目标也调用 `LAMPDSHREAL`，且不调用 `LAMPFOCUS`；脚本测试断言无 `SW_MINIMIZE`。
2. 切片 B：`activate` 对 `name === 'deepseek harness' && task.monitor.type === 'dsh'` 始终 `revealNativeWindow`。
3. 切片 C：原生脚本保留唯一一次 `IsIconic → SW_RESTORE`；可见但未聚焦时用 `BringWindowToTop + SetForegroundWindow` 补齐，不最小化；前台轮询逻辑保留。
4. 切片 D：构建重启后真机点击 dsh，用户验证 X 行为；全量回归。

## 5. 测试计划与追踪

| AC | 测试 | Red | Green | 真机 |
| --- | --- | --- | --- | --- |
| AC-01 | `focus-hidden-window.test.ts`：可见 dsh windowTitle → LAMPDSHREVEAL only；`dsh-native-reveal.test.ts`：脚本无最小化、含 BringWindowToTop/SetForegroundWindow | 09:43 实跑 **2 failed / 46 passed**：仍在 Win32 路径、脚本缺前台补齐，`logs/spec023-red.log` | 定向 6 文件 **114 项通过**，`logs/spec023-green-2.log` | 09:50:30 dsh 自身恢复成功 1.786s；用户 10:02 确认 X 正常 |
| AC-02 | 前台轮询 + AttachThreadInput/SetForegroundWindow 补齐；前台未确认仍失败（不最小化） | 同上 | 定向通过 | 09:50 先聚焦 WorkBuddy 再点 dsh，仍成功到前台 |
| AC-03 | WorkBuddy/SPEC-022 既有用例 + 全量 | — | 全量通过 | WorkBuddy 09:50:26 恢复 2.796s |
| AC-04 | typecheck / test / build / smoke | — | typecheck 0、58 文件 **863 项**、build 0、smoke 22 项 | — |

## 6. 执行记录

- 2026-10-22 09:40 取证：09:39 两次 dsh 点击均 `已通过 Win32 激活窗口`；X 无法关闭。
- 2026-10-22 09:43 Red：新增“可见 dsh 必须走 LAMPDSHREAL”“原生脚本不得最小化”断言，先回退实现实跑 **2 failed / 46 passed**，`logs/spec023-red.log`；随后恢复实现。
- 2026-10-22 09:45 Green：dsh 路由改为一律 `revealNativeWindow`；脚本删除所有最小化路径，前台未确认时用 `BringWindowToTop + SetForegroundWindow`（含 `AttachThreadInput`）重试；定向 6 文件 114 项通过，`logs/spec023-green-2.log`。
- 2026-10-22 09:48 首次真机：可见 dsh 原生恢复日志 `前台未确认`（仅单次 SetForegroundWindow 不足）；追加 25×100ms 重试与 AttachThreadInput 后重建。
- 2026-10-22 09:50 真机：先切到 WorkBuddy 再点 dsh，09:50:28.554→09:50:30.340（**1.786s**）`dsh 自身恢复成功，前台 HWND 已确认`；无 Win32 日志。WorkBuddy 2.796s。
- 2026-10-22 10:02 用户点 X 确认“正常了”。
- 2026-10-22 10:02 最终：typecheck 0、58 文件 **863 项通过**、build 0、smoke 22 项；`logs/spec023-typecheck-final.log`、`logs/spec023-full-test-final.log`、`logs/spec023-build.log`、`logs/spec023-smoke-final.log`。
- 已知边界：dsh 必须走自身 handoff；若 handoff 后前台仍无法在 2.5s 内确认，会返回失败反馈，但不做任何最小化，避免再次破坏 X。

## 7. 交付与验收

- [x] 所有 AC 有验收证据。
- [x] typecheck/test/build/smoke 与真机 X 验收记录。
- [x] 文档与索引更新。
- [x] 未完成项/回退说明。

最终结果/提交引用：dsh 的 visible/minimized/hidden 目标一律走自身单实例恢复，不再执行 Win32 最小化；真机确认 X 正常。回退方式：恢复 SPEC-020 的 “可见 windowTitle 走 Win32” 分支（会重新引入 X 问题）。未提交、未发布。
