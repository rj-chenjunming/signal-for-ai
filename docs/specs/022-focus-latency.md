# SPEC-022：桌面切换延迟（点击任务行到前台确认）

> 状态：done
> 类型：bugfix（性能/交互时延）
> 需求来源：2026-10-21 18:51 用户反馈“点击图标时候窗口要好一会儿才会打开”，随后澄清是“点任务行 → 目标工具窗口切到前台”慢；日志实测 5.5–14 秒。
> 负责人：待填写（Lead）
> 基线提交与环境：`ed19087` + 当前未提交工作区；Windows 10.0.26200；Electron 33.4.11；Node 24.14.0；dsh 0.2.1-rc.2 `127.0.0.1:56388`；WorkBuddy 本机数据库。
> 需求依据及假设：用户明确要求缩短切换等待；不改变“必须真实前台确认才报成功”的语义，不新增运行时依赖。
> 关联/替代条款：保留 SPEC-002/013/014/015/020 的窗口定位、失败反馈与原生恢复行为；只优化路径与时延。

## 1. 问题与目标

**现象**：点击悬浮灯任务行后，目标工具窗口要过“好一会儿”才到前台。日志中 `聚焦请求` 到 `自身恢复成功/前台 HWND 已确认` 的间隔：

- 16:05:18.473 → 16:05:27.682（9.2s，dsh）
- 16:05:35.886 → 16:05:43.272（7.4s，dsh）
- 16:06:02.082 → 16:06:13.762（11.7s，WorkBuddy）
- 16:06:14.962 → 16:06:28.654（13.7s，WorkBuddy）
- 17:00:55.228 → 17:01:00.718（5.5s，WorkBuddy）

**根因（代码路径）**：

1. `focusDesktop` 每次点击都先 `refreshWindows()`：启动一次 PowerShell 跑 `Get-Process | ConvertTo-Json`，即使 `knownWindows` 里已有有效缓存。
2. 目标隐藏时再启动一次 PowerShell 做 `EnumWindows` 隐藏主窗口查询（`findHiddenWindow`）。
3. dsh/WorkBuddy 原生恢复再启动一次 PowerShell，脚本内 `WaitForExit(3000)` 等 handoff。
4. 恢复成功后又单独启动一次 PowerShell `verifyForeground` 确认前台。
5. 任一步失败，外层还会 `refreshWindows()` + 重试一整轮，最坏叠加两次。
6. `activateViaWin32` 自身含 370ms 的刻意 sleep（前台锁绕过），可保留但不应叠加不必要的进程启动。

**目标**：在保持“真实前台确认才成功”、隐藏/最小化恢复、失败反馈不变的前提下，把一次点击的 PowerShell 进程数与等待降到最小；优先使用缓存窗口，原生恢复与前台确认合并为一次调用。

## 2. 范围与非目标

- 本次包含：`FocusService` 的缓存优先策略；原生恢复脚本内前台确认；相应测试与真机时延测量。
- 本次不包含：替换 PowerShell 为原生插件/新依赖；改变 Win32 最小化→恢复算法；改变 dsh/WorkBuddy 单实例 handoff 语义；改变失败提示文案。
- 受影响模块：`src/main/focus.ts`、`src/main/native-window-reveal.ts`、`src/main/dsh-native-reveal.ts`、`src/main/workbuddy-native-reveal.ts`（若脚本复用）、对应测试与规格索引。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | `knownWindows` 已有匹配的可见目标 | 点击任务行 | 不再调用窗口枚举 PowerShell；直接用缓存 HWND 激活；仍以真实前台确认判成功 |
| AC-02 | 缓存 HWND 已失效/窗口关闭 | 点击任务行 | 激活失败后最多刷新一次并重试一次；仍失败则给原有明确失败反馈，不误报成功 |
| AC-03 | dsh/WorkBuddy 隐藏或最小化 | 点击任务行 | 隐藏查询与原生恢复流程保留；原生恢复脚本内完成前台确认，不再额外启动 `verifyForeground`；未确认前台时不得输出成功 marker |
| AC-04 | Windows 真机、同一任务连续点击 | 点击任务行 | 修改后“聚焦请求 → 前台确认”时延显著低于修改前（目标：缓存可见路径 ≤2.0s，原生恢复路径 ≤4.0s）；功能与失败路径不回归 |
| AC-05 | 本次改动 | 交付前 | typecheck、全量 test、build、smoke 全绿；无新增依赖；测试断言调用次数而非易抖动的墙钟阈值 |

**边界与默认值**：

- 缓存不是“永不过期”：激活脚本继续校验 HWND owner PID，stale 时返回 `stale window`，外层刷新重试；这与现有行为一致。
- 前台确认仍必须是 `GetForegroundWindow()` 的真实结果，不能用 `SetForegroundWindow` 返回值替代。
- 失败重试上限保持 1 次刷新 + 1 次重试，不放大重试次数。
- 不改变 `focusTimeoutMs` 的既有上限；不通过缩短超时来“看起来更快”。

## 4. 方案与任务切片

1. **切片 A（Red，调用次数）**：
   - `test/focus.test.ts`：预填充 `knownWindows` 后重置调用记录，`focusTerminal` 不得再出现枚举命令。
   - `test/dsh-native-reveal.test.ts` / `test/workbuddy-native-reveal.test.ts`：原生恢复路径只执行一次 `LAMP*REVEAL` 脚本，不再执行 `LAMPVERIFY`；marker 只在脚本确认前台后输出。
2. **切片 B（缓存优先）**：`focusDesktop` L2 仅在 `knownWindows` 为空时刷新；匹配失败才刷新一次；stale 走既有重试。保持 `findHiddenWindow` 仅在缓存无匹配时执行。
3. **切片 C（合并确认）**：`buildNativeWindowRevealScript` 内轮询 `GetForegroundWindow()`（最多约 1s），确认后才输出成功 marker；`revealNativeWindow` 直接采用该结果，不再调 `verifyForeground`。保留 `verifyForeground` 给 AppActivate 兜底。
4. **切片 D（真机时延）**：构建后在 Windows 真实点击 dsh/WorkBuddy，对比日志时间戳；记录修改前后的冷/热点击。
5. **文档**：更新规格索引与验证记录；不改变 SPEC-014/015/020 的行为语义。

## 5. 测试计划与追踪

| AC | 测试文件/用例 | Red 证据 | Green 证据 | 回归/平台 |
| --- | --- | --- | --- | --- |
| AC-01 | `test/focus.test.ts` “已有窗口缓存时不再重复枚举”；`test/focus-refresh-feedback.test.ts` “uses the cached HWND without re-enumerating” | 18:57 实跑 7 failed / 67 passed，缓存仍触发 Get-Process，`logs/spec022-red.log` | 19:02 相关 6 文件 **104 项通过**，`logs/spec022-green-2.log` | 真机 dsh 点击 1.90s |
| AC-02 | `test/focus-refresh-feedback.test.ts` “stale cached HWND refreshes once and retries the new HWND”；`test/focus-reliability.test.ts` 应用重启用例 | 同上 Red | 全量 862 项通过 | 失败刷新/重试路径保留 |
| AC-03 | `test/dsh-native-reveal.test.ts` / `test/workbuddy-native-reveal.test.ts`：不再调用 LAMPVERIFY；脚本含 GetForegroundWindow 且位于成功 marker 之前 | Red：LAMPVERIFY 仍被调用、脚本缺 GetForegroundWindow | 6 文件 104 项通过 | 真机 WorkBuddy 原生恢复 2.18s，日志确认前台 |
| AC-04 | Windows 真机：`聚焦请求`→`前台确认` | 修改前 5.5–14s | 修改后 WorkBuddy 2.179s、dsh 1.901s，`logs/spec022-real-latency.log` | 功能正常 |
| AC-05 | typecheck / 全量 test / build / smoke | — | typecheck 0、58 文件 **862 项**、build 0、smoke 22 项通过 | — |

每项 Red 必须因“新增断言/目标行为缺失”失败，不能是编译/依赖错误；时延以真机日志为准，不用 mock 墙钟替代。

## 6. 执行记录

- 2026-10-21 18:5x 现状取证：日志 5.5–14s；代码路径确认每次点击 3–5 次 PowerShell 启动。
- 2026-10-21 18:57 Red：新增缓存命中、单次原生恢复、脚本内前台确认断言，`npx vitest run test/focus.test.ts test/dsh-native-reveal.test.ts test/workbuddy-native-reveal.test.ts` 实跑 **7 failed / 67 passed，exit 1**；失败均为目标行为缺失（仍枚举、仍 LAMPVERIFY、脚本无 GetForegroundWindow），非编译/依赖错误，`logs/spec022-red.log`。
- 2026-10-21 18:58 Green：`focusDesktop` 改为缓存优先（仅缓存为空时枚举）；原生恢复脚本内轮询前台并只在确认后输出 marker；`revealNativeWindow` 不再单独启动 `verifyForeground`；定向 6 文件 **104 项通过**，`logs/spec022-green-2.log`。
- 2026-10-21 19:02 全量回归：58 文件 **862 项通过**，exit 0，`logs/spec022-full-test.log`；typecheck 0（`logs/spec022-typecheck.log`）。
- 2026-10-21 19:04 构建 0（`logs/spec022-build.log`），smoke 22 项通过（`logs/spec022-smoke.log`）。
- 2026-10-21 19:05 真机点击：WorkBuddy 19:05:23.292→19:05:25.471（**2.179s**）；dsh-local 19:05:35.041→19:05:36.942（**1.901s**），`logs/spec022-real-latency.log`。对比修改前同路径 5.5–14s。
- 需求变更记录：无。
- 已知边界：缓存优先意味着窗口关闭后第一次点击会先失败再刷新重试（多约 1s），这是保留 stale 安全的代价；原生 handoff 本身仍受 `WaitForExit(3000)` 上限约束。

## 7. 交付与验收

- [x] 所有 AC 有验收证据；满足[流程 DoD](../development/spec-tdd.md)。
- [x] 类型检查、全量测试、构建后 smoke 及所需真机验证结果已记录。
- [x] 相关文档、规格索引已更新；没有秘密或本机配置进入提交。
- [x] 已知失败接受依据（如适用）、未完成项、回退步骤、发布状态已说明。

最终结果/提交引用：缓存优先 + 原生脚本内前台确认已实现；真机切换从 5.5–14s 降到 1.90–2.18s，全量 862 项、typecheck/build/smoke 通过。回退方式：恢复 `focusDesktop` 的每次刷新与 `revealNativeWindow` 的独立 `verifyForeground`。未提交、未发布。
