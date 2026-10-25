# SPEC-036：常驻 PowerShell 焦点 worker（激活路径）

> 状态：done
> 类型：refactor（性能/架构，外部行为保持）+ 新能力（worker 基础设施）
> 需求来源：用户 2026-10-24 批准的重构顺序 R-C「焦点链路去 Add-Type」第一切片（前序分析：SPEC-022 后点击到前台仍 ~2s，剩余成本几乎全是每次点击 spawn PowerShell + Add-Type 现场编译 C# 的 1–3s 固定税，POC §6 与 focus.ts:909 注释在案）。
> 负责人：AI 协作（dreaming）
> 基线提交与环境：工作区为 SPEC-031~035 完成后未提交状态；Windows 10.0.26200 x64，Node v24.16.0；PowerShell 5.1（powershell.exe）本机可用（本轮诊断大量使用）。
> 需求依据及假设：Win32 激活脚本本体（SW_MINIMIZE→SW_RESTORE→BringWindowToTop→SetForegroundWindow→前台 HWND 确认，focus.ts `activateViaWin32`）是实测唯一可靠路径，**脚本逻辑一字不改**，只改变"每次冷启动编译"为"常驻进程启动时编译一次、stdio JSON-lines 调用"。假设：PowerShell 常驻进程的生存期管理（退出杀树、无响应重启、请求超时）是主要风险面，必须有完整降级：worker 任何失败都回落到现有的按次 spawn 路径，该路径与其全部测试原样保留。
> 关联/替代条款：SPEC-022（时延基线：真机 WorkBuddy 2.18s / dsh 1.90s，本规格复测口径相同）；SPEC-020/023（dsh/WorkBuddy 恢复语义不变）；否决项：N-API 原生模块（引入 node-gyp）、预编译 exe（引入 .NET SDK 与二进制产物）——均违背极简依赖约束。

## 1. 问题与目标

点击任务行 → `focus_terminal` → `activateViaWin32` 每次都 `spawn powershell.exe` 并 `Add-Type` 现场编译 C#（实测 1–3s），加上进程启动与确认等待，构成 SPEC-022 优化后剩余的 ~2s。目标：新增**常驻 worker 进程**（启动时编译一次 C#，之后经 stdin/stdout JSON-lines 处理激活请求），把单次激活的进程税降到毫秒级；worker 不可用时**无条件回落**现有按次 spawn 路径（行为与现状完全一致）。

## 2. 范围与非目标

- 本次包含：`src/main/focus-worker.ts`（新增：worker 生命周期 + JSON-lines 协议 + 超时/退出处理）；`focus.ts` 的 `activateViaWin32` 增加 worker 优先路径（spawn 路径原样保留为降级）；`src/main/index.ts` 接线（创建/退出销毁）；`test/focus-worker.test.ts`（协议/生命周期单测 + FocusService 集成）+ 既有测试保持。
- 本次不包含：枚举（`refreshWindows`）、隐藏窗口查询（`findHiddenWindow`）、`native-window-reveal`（LAMPDSHREVEAL）、`verifyForeground`/AppActivate 迁移——全部留给 SPEC-037；配置开关（worker 默认启用，异常时自动降级，不加配置项）；Linux/云环境（worker 仅 Windows 语义，非 Windows 不启动，回落路径天然覆盖）。
- 受影响模块：上述文件；`SpawnExecutor` 抽象不动（worker 需要流式 stdio，manager 用独立可注入的 spawn 工厂）。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | FocusService 配置了可用 worker | `focusTerminal` 走到 Win32 激活 | `activateViaWin32` 经 worker `exec('activate',{hwnd,pid})` 完成，**未** spawn 带 `Add-Type` 的脚本（冷编译消失） |
| AC-02 | worker `exec` 返回 `{ok:true,detail:'ok'}` | 同上 | 激活成功语义与现状一致（返回 ok）；返回 `detail:'stale window'` 时同样按 stale 处理（不重试 AppActivate） |
| AC-03 | worker exec 拒绝（失败/超时/进程退出） | 同上 | 回落现有按次 spawn 路径并成功；日志含回落记录；**spawn 路径代码与测试零改动** |
| AC-04 | worker 进程被杀 | 下一次 `exec` | pending 全部拒绝、进程标记失效，再次调用自动重启新 worker（每次调用至多一次重启尝试，不循环重启） |
| AC-05 | worker 对同一请求无响应 | 超时（默认 5s） | 该请求拒绝并触发 AC-03 回落；后续请求不受悬挂请求影响（按 id 匹配，互不串扰） |
| AC-06 | 真实 PowerShell（集成） | 启动 worker 并 `ping` | 返回 `{ok:true,detail:'pong'}`（真实 Add-Type 编译 + stdio 往返，非 fake） |
| AC-07 | 全量回归 | typecheck / npm test / build / smoke / check:ui / check:goals | 全绿；既有 focus 系列测试（injected spawner 断言降级链与 Add-Type 脚本内容）**零改动通过**——未配 worker 的 FocusService 行为与现状逐字节一致 |

边界、异常、恢复/停止行为：应用退出时 `kill()` worker（spawn 用 `windowsHide:true`，不产生可见窗口；退出挂起由 kill + stdin end 兜底）；worker stdout 的坏行（非 JSON）忽略不崩溃；请求 id 单调递增，响应 id 不匹配的行丢弃。非 Windows 平台 `process.platform !== 'win32'` 时 manager 拒绝启动（exec 直接抛出→回落）。

## 4. 方案与任务切片

1. 切片 1（Red→Green）：FocusService 集成测试先行——AC-01/02/03 三条用例在现有 `focus.ts` 上运行（`focusWorker` 选项当前被忽略 → worker 断言失败，有效 Red）；实现 `focus-worker.ts`（manager：懒启动、ping 预热、id 匹配、超时、退出失效、可注入 spawn 工厂）+ `activateViaWin32` worker 优先路径 → Green。
2. 切片 2：manager 单测（协议编码/坏行/超时/退出失效/重启一次）+ 真实 PowerShell ping 集成用例（AC-06）。
3. `index.ts` 接线 + 应用退出 kill；全量回归（AC-07）。

worker 脚本要点（内嵌 TS 模板串，非独立文件）：启动即 `Add-Type`（与 focus.ts 现有 C# 完全同体）→ 循环 `ReadLine` → `ping`/`activate` 分发 → `ConvertTo-Json -Compress` 回写并 flush。`activate` 内部逻辑（owner 校验→minimize/restore→foreground 确认→'stale window' 语义）逐行对照 `activateViaWin32` 现脚本。

## 5. 测试计划与追踪

| AC | 测试文件/完整用例名或真机步骤 | Red 证据 | Green 证据 | 回归/平台验收 |
| --- | --- | --- | --- | --- |
| AC-01/02 | `test/focus-worker.test.ts`「activateViaWin32 优先走常驻 worker」 | 未运行 | 未运行 | 未运行 |
| AC-03 | 同文件「worker 失败回落按次 spawn」 | 未运行 | 未运行 | 未运行 |
| AC-04/05 | 同文件 manager 单测（退出失效/超时/id 匹配） | 未运行 | 未运行 | 未运行 |
| AC-06 | 同文件「真实 PowerShell worker ping」（真实进程，超时上限 30s） | 未运行 | 未运行 | 未运行 |
| AC-07 | 全量命令 | 未运行 | 未运行 | 未运行 |
| 真机 | Windows：点击 dsh/WorkBuddy 行到前台，记录时延对比 SPEC-022 基线（预期 ≤1s）；托盘退出后确认无残留 powershell 子进程 | 未运行 | 未运行 | 未运行 |

## 6. 执行记录

- 规格就绪依据：用户已批准 R-C；PowerShell 本机可用；脚本本体有既有测试与真机记录兜底。
- 修改前回归：SPEC-035 完成时全绿（typecheck 0 / test 939 / build 0 / smoke 0 / check:ui 0 / check:goals 0）。
- **切片 1 Red**（`npx vitest run test/focus-worker.test.ts`，3 failed）：三条 FocusService 集成用例在现有代码上因"worker 从未被调用"失败（行为缺失，有效 Red）。
- **切片 1 Green**（`focus-worker.ts` + `activateViaWin32` worker 优先路径后）：7 用例全过——含 AC-01（worker 调用、LAMPFOCUS 冷编译消失）、AC-02（stale 语义保持、不重试 AppActivate）、AC-03（worker 失败回落 spawn）；**既有 focus 系列 84 项测试零改动通过**（未配 worker 的 FocusService 行为不变）。
- **切片 2**：manager 单测（协议 id 匹配/坏行丢弃/超时失效重启/进程退出重启）+ **真实 PowerShell ping 集成**（真进程、真 Add-Type 编译、stdio JSON-lines 往返，本机通过）。全量：typecheck 0、946/946（+7）、build 0、smoke 0。
- 过程记录：a) `ensureStarted` 初版在 worker 退出后永不重启（starting 残留 resolved promise），实现评审阶段修正为 settle 后置空；b) worker 脚本 catch 分支弃用手工引号转义改用 ConvertTo-Json；c) 测试类型修整（ChildProcess 只读字段/stdio 交叉类型）。
- TDD 例外：AC-06 真实集成用例无 Red 语义（新基础设施首证）；manager 协议单测随实现引入。
- 真机时延（2026-10-25 日志实测）：点击 codex → 前台确认 431ms（SPEC-022 基线 1900–2180ms，约 4–5 倍提升）；托盘退出后 tasklist 无残留 powershell/electron，退出码 0。
- 需求变更记录：无。

## 7. 交付与验收

- [x] 所有 AC 有验收证据（真机除外）；满足[流程 DoD](../development/spec-tdd.md) 的自动化部分。
- [x] 类型检查（0）、全量测试（946/946）、构建（0）、smoke（0）已记录。
- [x] `index.ts` 已接线（创建 + 退出 kill）；规格索引已更新；无秘密入库。
- [ ] 真机时延对比（预期 ≤1s，基线 2.18s/1.90s）与退出后残留进程检查未完成 → 保持 `verifying`。

最终结果/提交引用：未提交（与 SPEC-031~035 同一工作区）。
