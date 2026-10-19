# SPEC-006：dsh 回合完成后不亮绿灯

> 状态：verifying
> 类型：bugfix / 能力补齐
> 需求来源：用户 2026-10-19 反馈「刚才完成似乎没有亮绿灯」，随后「好像也没有 我看的时候变灰了」「还是灰」
> 基线提交：`2895db2` + SPEC-003/004/005 未提交工作区；Windows 11 / 桌面端 dsh 0.2.1-rc.2
> 需求依据及假设：用户期望"dsh 里一回合跑完，灯变绿并保持到点击确认"。不改变 running/waiting/failed 的既有判定。
> 关联/替代条款：补齐 SPEC-002/AC-01 未覆盖的"完成＝成功"一侧；与 SPEC-004 的静默阈值结论一致（都源自 `updatedAt` 不可靠）。

## 1. 问题复现与根因

现象：桌面端 dsh 里一回合跑完，指示灯不亮绿灯（直接回灰）。

取证（读码 + 真机数据，2026-10-19 17:11–17:24）：

1. `deriveSessionStatus()` 的返回值域是 `failed / waiting / running / starting / idle` —— **没有 `success`**；插件信号 `mergeExactIntoPolled()` 也只能升级成 `failed/waiting`。**dsh 型监控从来不可能亮绿灯**（process/sqlite/webhook/codex 都可以，只有 dsh 不行）。
2. 真机 `session/list` 里有可用的完成证据：已完成回合在 `turnOutline` 里的 `response` 非空，正在跑的回合是空串；同时 `sessionStats.turns` 与 `turnOutline` 长度随回合增长。
3. **第一版修复（按 `updatedAt` 判断新鲜度）在真机上失败**，暴露出两个独立缺陷：
   - **`updatedAt` 在回合完成时不推进**。每 2 秒采样（17:20–17:24）显示：回合结束后 `updatedAgoSec` 一路涨到 400+ 秒，`updatedAt` 停在上一回合边界。用它做"完成是否新鲜"的判据，会把**刚刚完成**的回合当成历史而不点亮。
   - **完成只结算一次**：即使点亮，下一轮轮询就不再有"新完成"，聚合回落到 idle，绿灯只亮约 5 秒就变灰。而产品语义是"绿灯保持到点击确认"。

## 2. 范围与非目标

- 包含：`DshMonitor` 依据"已完成回合数"识别完成、绿灯保持到确认、`completionAt` 取 `lastPromptAt`；启动基线（历史完成不补亮）；中断不算完成；running 优先；`failed/unknown` 后不点亮成功；单元测试；规格与索引。
- 不包含：UI 配色/通知策略（沿用 success 既有行为）；插件精确信号；`dsh-web` 隧道实例的特殊处理（同一套逻辑）。

受影响接口：`DshSessionListItem` 类型补 `turnOutline` / `sessionStats` / `sessionListMetadata.lastPromptAt`（只读）；`DshMonitor` 内部状态。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | 第 1 回合已完成、第 2 回合在跑 | 第 2 回合完成（`turnOutline` 末项 `response` 非空，**`updatedAt` 可能仍旧**） | 聚合状态 `success`，`completionAt=lastPromptAt`；**再轮询一次仍为 success 且水位不变**（绿灯保持到点击确认） |
| AC-02 | 指示灯启动前就已完成的会话 | 首轮轮询 | 判 `idle`，不补亮绿灯、不刷提醒（启动基线） |
| AC-03 | 回合被打断（末回合 `response` 为空） | 轮询 | 不算完成（不得为 `success`） |
| AC-04 | 一个会话在跑、另一个会话刚完成 | 轮询 | 判 `running`（正在跑优先于完成） |
| AC-05 | 上一轮已判 `failed` 或 `unknown` | 本轮回合完成 | 不点亮 `success`（禁止转移），落回 `idle` 并留一条 info |
| AC-06 | 连续两个回合各自完成 | 两轮完成 | 各点亮一次，`completionAt` 递增（不复用旧水位）；中间新回合开始时回到 `running` |
| AC-07 | 本次改动 | 交付前 | `npm run typecheck`、全量 `npm test`、`npm run build`、`npm run smoke` 全绿；真机：回合结束变绿并保持、点击确认后不复亮 |

## 4. 方案与任务切片

**第一版方案（已废弃）**：用 `updatedAt` 判断"完成是不是新鲜"，且只在识别到的那一轮点亮 success。真机连续两次失败（见 §1 第 3 条），因此废弃。

**最终方案**（本规格实现）：

1. **按"已完成回合数"计数**：`turnOutline` 里 `response` 非空的条目数 `doneTurns`。首轮成功轮询记录每个会话的基线（启动前完成的回合不补亮）；之后 `doneTurns` 增加 → 记一次完成。完全不依赖 `updatedAt`。
2. **完成水位取 `lastPromptAt`**（`sessionListMetadata`）：每回合稳定、且随回合递增，正好可做 store 的确认水位；缺失时退回 `updatedAt`。
3. **绿灯保持（sticky）**：识别到完成后记 `pendingCompletionAt`，之后每轮都上报同一水位，直到 (a) 观察到新回合在跑（清空，等这轮结束）或 (b) 用户点击确认（store 的闸门丢弃同水位上报并回落 idle）。
4. 既有约束不变：`running` 优先于完成；被打断（末回合 response 为空）不算完成；`failed/unknown -> success` 禁止，落回 idle 并留 info。

## 5. 测试计划与追踪

| AC | 测试 | Red 证据 | Green 证据 | 回归/真机 |
| --- | --- | --- | --- | --- |
| AC-01 | `test/dsh-monitor.test.ts`「回合结束 → success（updatedAt 陈旧也不影响）」 | `npx vitest run test/dsh-monitor.test.ts` → **2 failed / 37 passed**：`expected 'idle' to be 'success'`（旧实现按 updatedAt 过滤），以及 AC-06 同样失败 | 同文件 **39/39** 通过；含"再轮询一次绿灯仍保持、`completionAt` 不变" | 真机：回合结束变绿并保持 |
| AC-02 | 同文件「启动前就完成的会话不补亮绿灯」 | 初始即通过（锁基线语义） | 通过 | 重启后不复亮旧绿 |
| AC-03 | 同文件「被打断（末回合 response 为空）不算完成」 | 初始即通过 | 通过 | — |
| AC-04 | 同文件「一个会话在跑、另一个刚完成 → running 优先」 | 初始即通过 | 通过 | — |
| AC-05 | 同文件「failed 之后不点亮 success」 | 初始即通过 | 通过 | — |
| AC-06 | 同文件「连续两个回合各自点亮一次（completionAt 递增）」 | 同批 2 failed 之一 | 通过 | — |
| AC-07 | typecheck / test / build / smoke | — | 2026-10-19 17:28 Windows：typecheck 0；37 文件 **692** 用例全部通过（较迭代 1 的 691 +1）；build 0；smoke 22 项通过 | 本机 Windows |

## 6. 执行记录

- 规格就绪依据：`deriveSessionStatus` 值域取证（无 success）；真机 27 会话字段分布；2 秒采样时间线证明 `updatedAt` 在回合结束时不推进。
- 修改前回归：`npm run typecheck` 0；`npm test` 37 文件 686 用例通过。
- 迭代 1（已废弃）：`startedAt` 基线 + `updatedAt > startedAt` 判定 → 自动化 38/38 通过，但**真机仍不亮绿**（用户连续两次反馈灰）。诊断日志 + 采样时间线定位到 `updatedAt` 不推进、以及"完成只结算一次"。
- 迭代 2（当前）：重写测试为"已完成回合计数 + 绿灯保持"语义 → 取红 **2 failed / 37 passed** → 实现 `advanceCompletedTurns()` / `completionAtOf()` / `pendingCompletionAt` 粘滞上报 → 同文件 39/39 通过 → 全量验证见 AC-07。
- 过程中修正的自身问题：AC-01 首轮把 `updatedAt` 设成 1 小时前又期望 `running`，与 SPEC-004 的"陈旧 running 降级"冲突；改为"首轮新鲜、完成轮陈旧"，让用例只检验完成检测本身。
- 需求变更记录：迭代 2 更换了完成判定依据（`updatedAt` → 已完成回合计数），需求未变。

## 7. 交付与验收

- [x] AC-01~AC-06 有自动化证据。
- [x] 规格索引已更新。
- [ ] 真机目视：dsh 回合结束变绿并**保持**、点击确认后不复亮（用户确认项）。

最终结果：dsh 型监控在回合完成时上报 `success` + `completionAt`（取 `lastPromptAt`，不依赖 `updatedAt`），并保持绿灯直到用户确认或新回合开始；启动前的历史完成不补亮，打断不算完成，`failed/unknown` 后不制造非法转移。未提交、未发布。
