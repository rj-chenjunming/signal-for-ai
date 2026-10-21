# SPEC-004：dsh 桌面端"在跑却显示空闲"

> 状态：done
> 类型：bugfix
> 需求来源：用户 2026-10-19 反馈「刚刚运行的时候，发现本地客户端的灯并不会发生任何变化」；现场诊断见 §1
> 基线提交：`2895db2` + SPEC-003 未提交工作区；Windows 11 / 桌面端 dsh 0.2.1-rc.2 / Node 24.14.0
> 需求依据及假设：用户期望"桌面端 dsh 在跑任务时，灯应显示运行中"。不新增配置项，不改既有语义边界。
> 关联/替代条款：细化 SPEC-002/AC-01 的"同态心跳"结论；**收紧**而不是推翻 D6/PRD §5.4 的"防灯一直是蓝的"。

## 1. 问题复现与根因

用户现象：桌面端 dsh 里跑任务，指示灯对应那一行没有任何变化。

排查得到**两个独立原因**：

**原因 A（配置层，已即时修复）**：`dsh-local` 任务的 `authority` 写死 `127.0.0.1:19387`，但桌面端 dsh 本次启动监听的是 `127.0.0.1:52119`（端口每次启动都会变：3080 → 19387 → 52119）。监控每轮 `transport/unreachable` → 任务被判 `failed`，而 `failed` 行在浮窗里是**隐藏**的，于是"灯完全没变化"。
证据：本机仅 `52119` 在监听且属于 `DeepSeek Harness` 进程；用真实 `DshMonitor` + 本机凭据探测 `52119` 返回 `ok, 23 会话`，探测 `19387` 返回 `transport/unreachable`。
处理：`config.local.yaml` 的 authority 改为 `127.0.0.1:52119`（热重载已生效）。端口自动跟随属于新能力，另立规格（见 §5 候选），不在本规格内。

**原因 B（代码缺陷，本规格要修）**：`deriveSessionStatus()` 里"静默过久 → idle"的判定**无条件优先于** `running`，阈值 60 秒。但桌面端 dsh 的 `session/list` 里 `updatedAt` **只在回合边界推进**，长回合期间不更新。
证据（真机取样 2026-10-19 16:55）：`running=true`、`agentAvailable=true`、`updatedAt` 距今 **289 秒** → 现判定为 `idle`；同一时刻 `tokenUsage`/`plan` 等投影显示该会话确实在跑。也就是说：回合开始约 60 秒后，灯就从蓝变灰并一直灰着。
对照历史证据：SPEC-002 曾用 `running=true + 静默 727 秒` 作为"执行完了还显示运行中"的回归样本，那条经验仍要保留。

**结论**：静默判定不能对所有状态用同一个阈值——`running=true` 时 dsh 自报"在跑"，只是没有心跳字段；`running=false` 时静默 60 秒就该灭。

## 2. 范围与非目标

- 包含：`deriveSessionStatus()` 为 `running===true` 使用独立的静默阈值（10 分钟）；新增/调整单元测试；规格与索引。
- 不包含：端口自动发现（新能力，另立规格）、dsh 插件精确信号、`success` 判定、UI 颜色语义、通知策略。

受影响接口：`deriveSessionStatus()` 新增可选参数 `runningSilenceMs`（默认 600000）。缺省行为对既有调用方透明。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | 桌面端会话 `running=true`，`updatedAt` 距今 289 秒（真机数字） | 监控轮询一轮 | 该会话判 `running`（灯为运行中），不再因为超过 60 秒静默被压成 `idle` |
| AC-02 | 同一会话 `running=true` 静默 9 分钟 | 轮询 | 仍判 `running`（长回合不被误灭） |
| AC-03 | `running=true` 但静默已超过 10 分钟（历史样本 727 秒 / 3600 秒） | 轮询 | 判 `idle`——"防灯一直是蓝的"仍然有效，既有回归用例不得放宽 |
| AC-04 | `running=false`，静默 120 秒 | 轮询 | 判 `idle`（非 running 的 60 秒阈值不变） |
| AC-05 | 本次改动 | 交付前 | `npm run typecheck`、全量 `npm test`、`npm run build`、`npm run smoke` 全绿并记录退出码 |

## 4. 方案与任务切片

单一切片：先加 AC-01/AC-02 的失败断言（现实现为 `idle`），再让 `deriveSessionStatus()` 在 `running===true` 时使用 `runningSilenceMs`（默认 10 分钟）作为静默阈值，其余路径保持 60 秒。阈值取在两条实测值之间：长回合实测 289 秒仍在跑；陈旧 `running` 实测 727 秒。

## 5. 测试计划与追踪

| AC | 测试/真机步骤 | Red 证据 | Green 证据 | 回归/平台验收 |
| --- | --- | --- | --- | --- |
| AC-01 | `test/dsh-instance.test.ts`「running=true 静默 289s → running」 | `npx vitest run test/dsh-instance.test.ts` → 2 failed / 50 passed；`expected 'idle' to be 'running'`（退出码 1） | 同文件 52/52 通过；新 dist 对真实 `127.0.0.1:52119` 探测 → `status=running, 1 个活跃` | 真机：桌面端跑任务时该行应为蓝 |
| AC-02 | 同文件「静默 9 分钟仍 running」 | 同上一并失败 | 通过 | — |
| AC-03 | 同文件既有「727s → idle」+ 新增「601s → idle」 | 既有用例保持通过（防回归） | 通过 | — |
| AC-04 | 同文件既有「>60s → idle」（running=false） | 既有通过 | 通过 | — |
| AC-05 | typecheck / test / build / smoke | — | 2026-10-19 16:53 Windows：typecheck 0；36 文件 **675** 用例全部通过（较基线 671 +4）；build 0；smoke 22 项通过 | 本机 Windows |

另：端口漂移的即时修复（改 `config.local.yaml` 的 authority 19387 → 52119）属配置操作，不进测试；其自动化（端口自动跟随）已作为下一轮候选登记在[规格索引](README.md)。

## 6. 执行记录

- 规格就绪依据：真机取样 + 真实 `DshMonitor` 探测，两处原因都有可复现数字；`running=true` 的判断只在阈值上放宽，不改状态机与优先级顺序。
- 修改前回归：`npm run typecheck` 0；`npm test` 36 文件 671 用例通过（含 SPEC-003）。
- 切片：先加 AC-01/AC-02 失败断言取红（2 failed）→ 让 `running===true` 用 `runningSilenceMs`（默认 600000，显式 `silenceMs` 时沿用全局收紧语义）→ dsh 三组测试 93 项通过 → 全量 675 项通过。
- 真机验证：新 dist 直连 `127.0.0.1:52119`，同一时刻真实 `DshMonitor.pollOnce()` 返回 `running`（`23 会话，1 个活跃`），修复前同一数据返回 `idle`。
- 需求变更记录：无。

## 7. 交付与验收

- [x] AC-01~AC-05 有证据（AC-01 另有真机数据）。
- [x] 规格索引已更新（含端口自动跟随候选）。
- [x] 真机目视确认：新回合开始后 10 分钟内 dsh 行为蓝色（16:54 截图 + API）；>10 分钟静默为灰色属 AC-03 预期。

2026-10-21 真机验收：用户选择**跳过**本条真机目视（含 AC-03 的静默 >10 分钟变灰、以及长回合灯保持蓝的独立确认），未提供通过或失败结论。因此本项不记为通过，也不记为失败；「回合结束后回灰」的表述已由 SPEC-006 的「结束变绿并保持」取代，不应再作为本规格的判定口径。状态保持 `verifying`。

### 2026-10-21 16:11 长回合灰色诊断（本轮补充）

- 用户观察：当前这一轮是很长的回合，悬浮灯 dsh（本地客户端）行显示灰色（面板显示“空闲”，`dsh 127.0.0.1:52119：27 会话`）。
- 只读诊断 `node scripts/diagnose-running-state.mjs 127.0.0.1:52119`（`logs/spec004-running-state.log`）：27 个非空白会话中只有 `session-4e153785` 为 `running=true`、`agentAvailable=true`，静默 **4547 秒**；`deriveFromListItem` 判定为 `idle`，全部会话 0 个 running。
- 结论：这是 AC-03 的预期行为（`running=true` 静默超过 10 分钟 → `idle`，防止灯永远蓝），不是原 60 秒静默误判的回归。当前长回合已远超 10 分钟，灰色符合规格；但用户期望“长回合蓝”的目视项只能在新回合开始后的 10 分钟内验证，本轮未覆盖。
- 仍保持 `verifying`：需要在下一次新回合开始后 10 分钟内观察 dsh 行为蓝；>10 分钟的灰色已由用户观察 + 真实 API 数据确认。
- 附注：16:03 dsh-local 出现一次 `transport/timeout` 并触发自动重发现；与长回合/本诊断相关，未把它当作产品回归，后续新回合观察时一并核对。

### 2026-10-21 16:54 新回合蓝色真机确认（收口）

- dsh 于 16:52–16:53 重启并换端口到 `127.0.0.1:56388`；指示灯在 16:53:41 自动发现选中该实例（31 会话）。
- 新回合开始后（本对话续接）只读诊断 `node scripts/diagnose-running-state.mjs 127.0.0.1:56388`：`session-4e153785` 为 `running=true`、静默 **28 秒**、判定 **running**（`logs/spec004-running-state-3.log`）。
- 实机悬浮灯截图 `logs/spec004-live-lamp-running.png`：总灯为蓝，dsh 鲸鱼行状态点为**蓝色**；同帧 WorkBuddy 为绿（真实完成）、dsh-web 为灰（空闲）。
- 结合 16:11 的 `running=true` 静默 4547 秒 → `idle`（AC-03 预期，用户当时观察灰色），AC-01～AC-05 的证据链完整；本规格改为 `done`。
- 说明：“回合结束后回灰”的口径仍由 SPEC-006 的“结束变绿并保持”取代，不作为本规格失败。

最终结果：`running=true` 的静默阈值改为 10 分钟，桌面端长回合不再被判空闲；端口漂移已由 SPEC-005 接管。新回合 10 分钟内蓝色与 >10 分钟灰色均已有真机证据，状态 `done`。未发布。

后续改进：[SPEC-021](021-dsh-long-turn-liveness.md)（done）用 dsh 的 `asOfSeq`/`tokenUsage`/`contextPressure` 活信号覆盖 >10 分钟的真实长回合，同时保留本规格的防常蓝上限；本规格不改变已验收行为。
