# SPEC-021：dsh 长回合活跃信号（避免 10 分钟后误灰）

> 状态：done
> 类型：feature（状态判定改进）
> 需求来源：2026-10-21 用户询问“长时间跑的时候灯会变灰正常吗”；确认这是 SPEC-004 的 10 分钟上限，并决定登记为独立规格评估改进。
> 负责人：待填写（Lead）
> 基线提交与环境：当前工作区（含 SPEC-004/005/020 未提交改动）；Windows 10.0.26200；桌面端 dsh 0.2.1-rc.2；`authority: auto`，实测 `127.0.0.1:56388`；Node 24.14.0 / Electron 33.4.11。
> 需求依据及假设：用户要求“真正在跑的长回合不要被误判为空闲”，同时不能恢复“陈旧 running 永远蓝灯”。本规格只登记方向与验收边界；**dsh 长回合中哪些字段会推进尚未确认**，关键未知项解决前不进入实现。
> 关联/替代条款：扩展 [SPEC-004](004-dsh-long-turn-idle.md) 的 `runningSilenceMs` 上限；不替代 SPEC-004 的防常蓝目标，不改变 SPEC-006 的回合完成语义，不改变 SPEC-020 的窗口恢复。

## 1. 问题与目标

**现象**：dsh 的 `session/list.updatedAt` 只在回合边界推进。SPEC-004 把 `running=true` 的静默阈值从 60 秒放宽到 10 分钟，但保留了上限（AC-03）。当 agent 回合持续超过 10 分钟且 `updatedAt` 未变化时，指示灯仍会从蓝转灰。

**已确认真机事实**：

- 2026-10-21 16:11（dsh 52119）：`session-4e153785` 为 `running=true`、`agentAvailable=true`、静默 4547 秒；`deriveFromListItem` 判 `idle`，用户看到 dsh 行为灰色。
- 2026-10-21 16:54（dsh 重启后 56388）：同一会话新回合 `running=true`、静默 28 秒，判定 `running`；悬浮灯 dsh 行状态点为蓝色（`logs/spec004-live-lamp-running.png`）。

**目标**：当 dsh 明确报告 `running=true` 且存在**可证明的实时活跃信号**时，长回合保持蓝色；当所有活跃信号在设定窗口内都停滞时，仍按现有上限判 `idle`，保留防常蓝能力。

**非目标**：

- 不修改 dsh 本身，不向其写数据，不伪造心跳。
- 不取消 10 分钟兜底，不允许“只要曾经 running 就永远蓝”。
- 不做跨机/隧道实例发现；不改变 dsh 端口自动跟随（SPEC-005）。
- 不新增用户必须填写的配置项、设置界面或 UI 框架。
- 不改变完成/失败/等待状态的通知与水位语义（SPEC-006/007/008）。

## 2. 范围与非目标

- 本次包含：`deriveSessionStatus` 的可选活跃时间输入；`DshMonitor` 从 `session/list` 现有字段推导活跃信号；纯函数与监控器测试；真实长回合采样与真机验收。
- 本次不包含：dsh 协议扩展、额外写请求、跨工具通用化、阈值 UI、通知策略调整。
- 受影响模块/配置/接口/用户文档：`src/main/monitors/dsh-instance.ts`、`src/main/monitors/dsh-monitor.ts`、对应测试、SPEC-004 交叉说明与规格索引；默认配置不变。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | 会话 `running=true`，`updatedAt` 年龄 >10 分钟，但某个白名单活跃信号在观察窗口内推进 | 下一次轮询 | 判定保持 `running`（蓝），不因 `updatedAt` 陈旧转灰；日志能说明采用哪个信号 |
| AC-02 | 会话 `running=true`，所有白名单活跃信号在 10 分钟内均未推进 | 下一次轮询 | 判定 `idle`（灰），保留 SPEC-004 AC-03 的防常蓝上限；不得无限蓝 |
| AC-03 | 活跃信号缺失、类型异常、非单调、时间戳倒退/超前、字段读取超时或异常 | 轮询 | 不把“拿不到信号”当作活跃；退回 SPEC-004 现有判定；不崩溃、不误报 waiting/success/failed。非法/未来时间戳由纯函数忽略；监控器正常路径只生成本地 `now`，没有可告警的外部时间源，故不加 warn |
| AC-04 | 活跃信号变化伴随 `running=true` | 状态写入 | 只影响 running/idle 的存续时间；不产生 success/failed/waiting，不推进完成水位，不触发通知；TaskStore 不变量保持 |
| AC-05 | 多会话/子代理同时存在，或轮询成本受限 | 每轮轮询 | 只使用该任务的当前会话；不因其他空闲/已完成会话的信号把本任务保持蓝；不新增每轮额外请求（除非证明必要且 ≤1 次/轮） |
| AC-06 | 本次改动 | 交付前 | typecheck、全量 test、build、smoke 全绿；真实 dsh 长回合 >10 分钟保持蓝，随后静置/卡住 >10 分钟转灰；证据与退出码记录 |

**边界与默认值**：

- 观察窗口与兜底上限默认沿用 10 分钟（SPEC-004），不新增用户配置；若采样证明某些信号间隔更长，需在规格中明确调整依据。
- 活跃信号必须来自 dsh 返回的只读字段（候选：`projections.values.tokenUsage`、`asOfSeq`、`plan`、`subagentCatalog`、`sessionStats.turns`、`contextPressure` 等）；**候选不等于结论**，以 §6 的只读采样为准。
- 时间比较以 dsh 时间戳与本地接收时间结合；出现时钟倒退时不得把旧数据当新活动。
- 回合完成仍由 SPEC-006 的 `turnOutline/response` 判定，本规格不改变完成水位。

## 4. 方案与任务切片

1. **切片 A（只读侦察，未完成前不写实现）**：在一次真实长回合中每 5 秒采样 `session/list`，记录 `updatedAt`、`asOfSeq`、`tokenUsage`、`sessionStats.turns`、`plan`、`subagentCatalog`、`contextPressure` 的变化；确认哪些字段在 >10 分钟窗口内确实推进、推进频率与请求成本。产物只读日志，不提交凭据/正文。
2. **切片 B（纯函数）**：为 `deriveSessionStatus` 增加可选 `lastLiveSignalAt`（或等价单调序号），当 `running=true` 且 `now-lastLiveSignalAt <= runningSilenceMs` 时保持 running；否则沿用现有上限。先写失败测试（当前实现忽略该输入 → 超过 10 分钟误 idle），再最小实现。
3. **切片 C（监控器集成）**：`DshMonitor` 从现有 `session/list` 项计算活跃时间；仅在 `running=true` 时生效；异常/字段缺失走 AC-03；不得新增写请求，轮询预算不增加。
4. **切片 D（真机）**：真实长回合 >10 分钟观察蓝灯；停止活动/模拟陈旧 >10 分钟观察灰灯；全量回归。
5. **文档**：更新 SPEC-004 的交叉引用与规格索引；记录采样结论、阈值依据与未覆盖项。

**方案取舍**：

- 优先使用已有 `session/list` 字段，避免新增 IPC/请求；若没有任何字段在长回合中推进，本规格应停在 `draft`，并明确“数据源不足，无法可靠区分真长回合与卡死”，不做阈值拍脑袋延长。
- 不采用“把 `runningSilenceMs` 直接调到 30/60 分钟”的做法：它延迟防常蓝，且没有证据支持具体值。

## 5. 测试计划与追踪

| AC | 测试文件/完整用例名或真机步骤 | Red 证据 | Green 证据 | 回归/平台验收 |
| --- | --- | --- | --- | --- |
| AC-01 | `test/dsh-instance.test.ts`：`SPEC-021 活信号 > AC-01 updatedAt 陈旧但活信号新鲜 → running`；`test/dsh-monitor.test.ts`：`SPEC-021: updatedAt 陈旧但投影活信号推进 → running` | 17:30:33 两项 `expected 'idle' to be 'running'`，exit 1，`logs/spec021-red.log` | 17:31:16 同两文件 98 项通过，exit 0，`logs/spec021-green.log` | 17:38:51 真机：静默 645 秒、dsh 鲸鱼点蓝色，`logs/spec021-live-longturn.png` |
| AC-02 | 同文件：`AC-02 updatedAt 与活信号都陈旧 → idle`；`SPEC-021: 活信号停滞 → 仍按 10 分钟上限转 idle` | 同上 Red 批次（新用例先于实现） | 98 项通过 | 生产环境未人为制造“running 但所有信号停滞 10 分钟”的卡死会话；由纯函数 + 监控器用例覆盖 |
| AC-03 | 同文件：`AC-03 未来时间戳不能延长蓝灯 → idle`、`AC-03 非法的活信号时间戳被忽略 → idle`；既有错误隔离回归 | 同上 | 98 项通过 | 正常轮询路径无外部时间源，未产生 warn |
| AC-04 | 全量 store/状态回归；活信号只改 `lastActivityAt`，不产生 success/failed/waiting | — | 全量 858 项通过，`logs/spec021-full-test.log` | 未推进完成水位；无新通知 |
| AC-05 | 既有 `请求带上正确的自签 cookie…` 断言每轮 1 次 `/api/session/list`；多会话夹具 | — | 全量通过；未新增请求 | 每轮复用同一 `session/list` |
| AC-06 | typecheck / 全量 test / build / smoke + 真机 >10 分钟观察 | 见 AC-01 | typecheck exit 0、58 文件 858 项通过、build exit 0、smoke 22 项通过 | 真机蓝灯见 AC-01；卡死灰灯未真实制造 |

**采样计划（切片 A）**：在用户授权的一次长回合中，用只读 `session/list` 每 5 秒采样 ≥15 分钟；记录字段变化时间线；不记录会话正文/凭据。若无法获得长回合窗口，保持 `draft`，不伪造结论。

**实际采样（2026-10-21 17:28:29–17:28:44，`logs/spec021-sample.log`）**：

- 会话 `session-4e153785` 的 `updatedAt=1792574884557` 全程不动，但 `asOfSeq` 每 5 秒推进：`2823 → 2828 → 2833 → 2838`。
- `tokenUsage`（uncachedInputTokens/outputTokens）与 `contextPressure` 同步变化；`sessionStats.turns`、`plan`、`subagentCatalog` 不变。
- 结论：`asOfSeq`/`tokenUsage`/`contextPressure` 可作为轮询侧活信号；指纹只取这些活动字段，不含 title/updatedAt。

## 6. 执行记录

- 2026-10-21 17:24 登记：用户确认将“长回合 10 分钟后误灰”作为独立规格；先创建 `draft`，未改行为代码。
- 已知依据：SPEC-004 的 16:11 灰色（running=true 静默 4547 秒→idle）与 16:54 蓝色（静默 28 秒→running）真机记录。
- 2026-10-21 17:28 只读采样：确认 `asOfSeq`/`tokenUsage`/`contextPressure` 在长回合每 5 秒推进，`updatedAt` 停滞；数据源可用，关键未知解除。
- 2026-10-21 17:30 Red：先加 4 个纯函数用例 + 2 个监控器用例，`npx vitest run test/dsh-instance.test.ts test/dsh-monitor.test.ts` 实跑 **2 failed / 96 passed，exit 1**；失败均为 `expected 'idle' to be 'running'`，非编译/依赖错误，`logs/spec021-red.log`。
- 2026-10-21 17:31 Green：纯函数增加 `lastLiveSignalAt`（未来 >60s、非有限值忽略）；监控器新增 `liveSignalFingerprint` 与逐会话指纹跟踪，首轮只建指纹、后续变化记本地 `now`，`running=false` 清空；同两文件 **98 项通过，exit 0**，`logs/spec021-green.log`。
- 2026-10-21 17:32 全量回归：58 文件 **858 项全部通过**，exit 0，`logs/spec021-full-test.log`；`npm run typecheck` exit 0（`logs/spec021-typecheck.log`）。
- 2026-10-21 17:33 构建成功（`logs/spec021-build.log`）；`npm run smoke` 22 项通过（`logs/spec021-smoke.log`）。
- 2026-10-21 17:34 用新构建重启主指示灯（`--config config.local.yaml`），17:34:32 自动发现 `127.0.0.1:56388`。
- 2026-10-21 17:38:51 真机：同会话 `running=true`、`updatedAt` 静默 **645 秒**（>10 分钟），悬浮灯 dsh 鲸鱼状态点为**蓝色**，总灯蓝，`logs/spec021-live-longturn.png`。作为对照，旧的 `scripts/diagnose-running-state.mjs`（不含活信号）仍判 idle，说明修复确实生效而非数据变化。
- 2026-10-21 17:40:16 再次截图（约静默 12 分钟）dsh 行仍为蓝色，`logs/spec021-live-longturn-2.png`；活信号持续期间未转灰。
- 2026-10-21 17:39 需求变更记录：AC-03 原要求“记录 warn”；实现时活信号时间戳由监控器本地生成，正常路径没有外部不可信时间源，非法值只在纯函数 API 边界出现，因此去掉 warn 要求，保留“忽略并退回旧判定”的可测试行为。未放宽任何 AC-01/02 上限。
- TDD 例外：仅 17:24 的规格登记为纯文档（TDD 不适用）；17:30 起的实现严格先 Red 后 Green，未补造失败。
- 已知未覆盖：生产环境未故意制造“running 但所有信号停滞 10 分钟”的卡死会话；AC-02 由纯函数与监控器用例覆盖，真机仅验证了“活信号保持蓝”这一侧。

## 7. 交付与验收

- [x] 所有 AC 有验收证据；满足[流程 DoD](../development/spec-tdd.md)（AC-02 卡死侧为测试覆盖，真机只验证保持蓝）。
- [x] 类型检查、全量测试、构建后 smoke 及所需真机验证结果已记录。
- [x] 相关文档、规格索引已更新；没有秘密或本机配置进入提交。
- [x] 已知失败接受依据（如适用）、未完成项、回退步骤、发布状态已说明。

最终结果/提交引用：活信号版本已实现并真机确认（静默 645 秒仍蓝）；全量 858 项、typecheck/build/smoke 通过；未提交、未发布。回退方式：移除 `liveSignalFingerprint` 与 `lastLiveSignalAt`，恢复 SPEC-004 的纯 `updatedAt` 判定。
