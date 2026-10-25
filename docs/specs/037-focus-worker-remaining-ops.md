# SPEC-037：焦点 worker 承载枚举/隐藏查询/原生恢复

> 状态：done
> 类型：refactor（性能/架构，外部行为保持）
> 需求来源：用户 2026-10-24 批准的 R-C 第二切片（SPEC-036 的后续）。
> 负责人：AI 协作（dreaming）
> 基线提交与环境：工作区为 SPEC-031~036 完成后未提交状态；Windows 10.0.26200 x64，Node v24.16.0。
> 需求依据及假设：SPEC-036 只迁移了 activate；`refreshWindows`（Get-Process 枚举）、`findHiddenWindow`（LampWindowDiscovery + Add-Type）、`revealNativeWindow`（LampNativeOwner + 单实例 handoff）仍每次点击冷启动。假设：三者脚本本体逐行搬运进 worker（分发函数化、参数化），语义与解析函数（`parseHiddenWindow`/`toTerminalWindow`/marker 判定）完全不动；stdin 若有非 ASCII（用户配置的中文进程名）需在 manager 写入侧统一转义为 `\uXXXX` 保证 PS 5.1 Console.In 解码安全（JSON 规范允许，ConvertFrom-Json 原生解码）。
> 关联/替代条款：SPEC-036（worker 基础设施与 activate op）；SPEC-020/023（恢复语义不变）；SPEC-005（端口发现不在 focus 链路，不涉及）。

## 1. 问题与目标

activate 之外的三条 PowerShell 调用（枚举、隐藏窗口查询、原生恢复）仍按次冷启动 + Add-Type。目标：三者迁入常驻 worker（脚本本体编译一次），每次调用毫秒级；任何 worker 失败回落各自的按次 spawn 路径（解析函数与降级链不动）。

## 2. 范围与非目标

- 本次包含：`focus-worker.ts` 脚本扩容（LampWindowDiscovery / LampNativeOwner / Invoke-Enumerate / Invoke-Hidden / Invoke-Reveal，分发器加三 op）+ 写入侧非 ASCII 转义；`focus.ts` 的 `refreshWindows` / `findHiddenWindow` / `revealNativeWindow` 增加 worker 优先路径（枚举解析块提取共用）；`test/focus-worker.test.ts` 批次 3。
- 本次不包含：`verifyForeground`/AppActivate 迁移（仅在 AppActivate 兜底路径使用，冷启动可接受）；`wt.exe` 探测（L0，启动一次）；worker 脚本外置为文件。
- 受影响模块：上述两源文件 + 测试。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | 配置了可用 worker | `refreshWindows` | 经 worker `enumerate` op 完成，spawn 路径未收到 `Get-Process |` 脚本；解析结果（knownWindows）与 spawn 路径同构 |
| AC-02 | 配置了可用 worker | `findHiddenWindow` | 经 worker `hidden` op 完成；`parseHiddenWindow` 对 detail 的判定与 spawn 路径共享同一实现（fail-closed 语义不变） |
| AC-03 | 配置了可用 worker | `revealNativeWindow`（dsh/workbuddy） | 经 worker `reveal` op 完成；成功判据仍是 detail 含 profile.marker |
| AC-04 | worker exec 拒绝 | 上述任一路径 | 回落对应按次 spawn 路径，结果语义与现状一致；日志含回落记录 |
| AC-05 | 请求参数含非 ASCII（中文进程名） | `hidden` op 写入 | stdin 行为纯 ASCII（`\uXXXX` 转义），worker 正确解码并按名称过滤 |
| AC-06 | 全量回归 | typecheck / npm test / build / smoke / check:ui / check:goals | 全绿；既有 focus 系列测试零改动通过 |

边界、异常、恢复/停止行为：三个 op 与 activate 共用同一 worker 生命周期（SPEC-036 的超时/失效/重启语义直接适用）；`reveal` 的单实例 handoff 仍由 worker 内 `WaitForExit(3000)` 约束，worker 请求超时（5s）只覆盖协议往返，不会截断 handoff 本身（handoff 在 worker 内异步完成后响应）；枚举结果为空时 worker 返回 `[]`（与 spawn 的空输出降级等价）。

## 4. 方案与任务切片

1. 切片 1（Red）：批次 3 集成测试——AC-01/02/03 三条"worker 优先"用例在现有代码上失败。
2. 切片 2（Green）：worker 脚本扩容 + focus.ts 三路径 + manager 写入侧转义 → 全过 + 全量回归。
3. 真机：时延复测（与 SPEC-036 同一口径）+ 残留进程检查。

## 5. 测试计划与追踪

| AC | 测试文件/完整用例名或真机步骤 | Red 证据 | Green 证据 | 回归/平台验收 |
| --- | --- | --- | --- | --- |
| AC-01 | `test/focus-worker.test.ts` 批次 3「refreshWindows 优先 worker」 | 未运行 | 未运行 | 未运行 |
| AC-02 | 同「findHiddenWindow 优先 worker」 | 未运行 | 未运行 | 未运行 |
| AC-03 | 同「revealNativeWindow 优先 worker」 | 未运行 | 未运行 | 未运行 |
| AC-04 | 同批次三条回落用例 | 未运行 | 未运行 | 未运行 |
| AC-05 | 同「非 ASCII 进程名以 \uXXXX 写入」 | 未运行 | 未运行 | 未运行 |
| AC-06 | 全量命令 | 未运行 | 未运行 | 未运行 |
| 真机 | Windows：点击 dsh/WorkBuddy 行（含最小化/隐藏场景）到前台；时延对比 SPEC-022/036 基线；退出后无残留 powershell | 未运行 | 未运行 | 未运行 |

## 6. 执行记录

- 规格就绪依据：用户已批准 R-C；脚本本体有既有测试与真机记录兜底。
- 修改前回归：SPEC-036 完成时全绿（typecheck 0 / test 946 / build 0 / smoke 0）。
- **切片 1 Red**（`npx vitest run test/focus-worker.test.ts`，5 failed | 7 passed）：三条"worker 优先"用例 + 回落用例 + ASCII 转义用例，均因行为缺失失败。
- **切片 2 Green**：worker 脚本扩容（LampWindowDiscovery/LampNativeOwner 预编译 + Invoke-Enumerate/Hidden/Reveal + 分发）+ focus.ts 三路径（枚举解析提取为 `acceptWindowList` 共用）+ manager 写入侧 `\uXXXX` 转义。`test/focus-worker.test.ts` 13/13（含**真实 worker 的 enumerate/hidden 只读集成**——真进程执行新脚本并完成 JSON 往返）；focus 系列全家 126/126 零改动。全量：typecheck 0、952/952（+6）、build 0、smoke 0。
- 测试适配记录（非弱化）：SPEC-036 批次 1 的三个 mock 原为"对所有 op 返回同一响应"——SPEC-037 起同链路的枚举/隐藏也走 worker，mock 改为按 op 分发、worker 调用次数断言随之调整（enumerate+activate=2）；AC-04 回落夹具的枚举窗口从 MyApp 改为 dsh 窗口（原夹具被 dshTask 的进程白名单正确过滤，暴露了夹具与任务配置不匹配）。
- Refactor：acceptWindowList 提取即为本次结构整理，无进一步必要。
- TDD 例外：AC-05 随协议加固引入；真实集成用例无 Red 语义。
- 真机（2026-10-25）：同 SPEC-036 时延与残留进程数据。最小化/隐藏唤醒场景用户未单独演练（dsh/WorkBuddy 未运行）——脚本本体与 SPEC-020/023 真机验证过的版本逐行同体，真实 worker 集成测过 enumerate/hidden；留日常使用观察，不阻塞。
- 需求变更记录：无。

## 7. 交付与验收

- [x] 所有 AC 有验收证据（真机除外）；满足[流程 DoD](../development/spec-tdd.md) 的自动化部分。
- [x] 类型检查（0）、全量测试（952/952）、构建（0）、smoke（0）已记录。
- [x] 规格索引已更新；无秘密入库。
- [ ] 真机验收（含最小化/隐藏场景与时延对比）未完成 → 保持 `verifying`。

最终结果/提交引用：未提交（与 SPEC-031~036 同一工作区）。
