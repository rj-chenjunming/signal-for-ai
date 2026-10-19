# SPEC-007：自动熄灭后同一个完成会被重新点亮

> 状态：verifying
> 类型：bugfix
> 需求来源：用户 2026-10-19 反馈「workbuddy 明明没有在运行东西，但是隔一段时间他就会自己亮绿灯」
> 基线提交：`2895db2` + SPEC-003~006 未提交工作区；Windows 11
> 需求依据及假设：用户期望"没有新任务完成时不该反复亮绿灯"。不改变"完成任务亮绿灯、亮到点击或自动熄灭"的既有语义。
> 关联/替代条款：修正 SPEC-002/AC-01 与 store 确认水位闸门之间缺失的一环；与 `markRead` 的既有做法对齐。

## 1. 问题复现与根因

现象：WorkBuddy 没有在跑任何东西，指示灯每隔一段时间自己亮一次绿灯。

排查：
1. 库里已完成会话的 `updated_at` 最新是 **6.3 小时前**（54 条 `completed`），没有周期性写入 —— 不是数据源头在变。
2. `deriveSqliteVerdict()` 的绿灯条件是 `lastDoneAt > ackedCompletionAt`：只要"已确认水位"没推进，每一轮轮询都会读到同一个 6 小时前的完成并上报 `success`。
3. `TaskStore.tick()` 的 `dismiss_after`（默认 `dismissAfterMs = 10 分钟`）把 `success/failed` 自动转回 `idle`，**但没有推进 `ackedCompletionAt`**（只有用户点击 `markRead` 才推进）。
4. 于是形成循环：亮绿 → 10 分钟后自动熄灭（ack 仍为 0）→ 下一轮轮询读到同一个完成 → 再亮绿 → …… 周期正好是 `dismissAfterMs`。

结论：**自动熄灭没有把"这次完成"记成已确认**，`dismiss_after` 与确认水位闸门之间缺了一环。

## 2. 范围与非目标

- 包含：`TaskStore.tick()` 在 `dismiss_after` 熄灭 `success` 前推进 `ackedCompletionAt`；单元测试；规格与索引。
- 不包含：确认水位的**持久化**（跨应用重启仍会重亮一次历史完成，属既有行为，另立规格）；`dismissAfterMs` 默认值调整；通知策略。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | 任务处于 `success`（带 `completionAt`），用户未点击 | 超过 `dismissAfterMs` 触发 `tick()` | 状态回 `idle`，且 `ackedCompletionAt = lastCompletionAt`；监控随后上报**同一个**完成被丢弃，不再复亮 |
| AC-02 | 同上，已自动熄灭 | 监控上报一个**更晚**的完成 | 正常点亮 `success`（功能没被砍掉） |
| AC-03 | 用户主动点击（`markRead`） | 随后上报同一完成 / 更晚完成 | 行为与自动熄灭一致：同完成丢弃、更晚完成点亮 |
| AC-04 | 本次改动 | 交付前 | `npm run typecheck`、全量 `npm test`、`npm run build`、`npm run smoke` 全绿；真机观察 20 分钟以上不再自发亮绿 |

## 4. 方案与任务切片

单切片，测试先行：在 `tick()` 的 `success/failed` 分支里，`apply(idle)` 之前把 `lastCompletionAt` 并入 `ackedCompletionAt`（与 `markRead` 完全相同的语义），然后照原逻辑回 `idle`。`failed` 没有完成水位，行为不变。

## 5. 测试计划与追踪

| AC | 测试 | Red 证据 | Green 证据 | 回归/真机 |
| --- | --- | --- | --- | --- |
| AC-01 | `test/store-ack-completion.test.ts`「dismiss 之后状态回 idle，且同一个完成不再复亮」 | `npx vitest run test/store-ack-completion.test.ts` → **1 failed / 11 passed**：`expected undefined to be 1700000000000`（`ackedCompletionAt` 未推进） | 同文件 **12/12** 通过 | 真机：20 分钟内不再自发亮绿 |
| AC-02 | 同文件「dismiss 之后新的完成仍然会点亮」 | 初始即通过（防"砍功能"） | 通过 | — |
| AC-03 | 同文件「用户主动点击与自动熄灭效果一致」 | 初始即通过 | 通过 | — |
| AC-04 | `test/sqlite-state-integrity.test.ts`「完成早于启动基线 -> idle」 | 同文件 → **1 failed / 11 passed**：`expected 'success' to be 'idle'` | 同文件 **12/12** 通过 | 真机：重启后不为 6 小时前的旧完成亮绿 |
| AC-05 | 同文件「刚完成（宽限内）-> success」「不传基线保持既有语义」 | 初始即通过 | 通过 | — |
| AC-06 | typecheck / test / build / smoke | — | 2026-10-19 17:42 Windows：typecheck 0；37 文件 **699** 用例全部通过（较 SPEC-006 的 692 +7）；build 0；smoke 22 项通过 | 本机 Windows |

补充说明（AC-04/AC-05，同一句反馈的另一半）：确认水位不跨进程持久化，所以**重启后**库里 6.3 小时前的旧 `completed` 会立刻把灯点亮一次。因此给 `deriveSqliteVerdict` 增加可选参数 `earliestCompletionAt`，监控传"启动时刻 − 10 分钟"：宽限内完成的仍提醒，更早的历史完成不再补亮。不传时行为与原来一致（向后兼容）。

## 6. 执行记录

- 规格就绪依据：库里 `completed` 会话 `updated_at` 最新 6.3 小时前（无周期性写入）+ `deriveSqliteVerdict` 的 `lastDoneAt > acked` 条件 + `tick()` 的 dismiss 分支不推进 ack。
- 修改前回归：`npm run typecheck` 0；`npm test` 37 文件 692 用例通过。
- 切片：测试先行取红（1 failed / 11 passed）→ 在 dismiss 前并入 `ackedCompletionAt` → 同文件 12/12；相关回归（store / store-liveness / sqlite-state-integrity / sqlite-monitor）共 84 项通过 → 全量验证见 AC-04。
- 连带效果：SPEC-006 的 dsh 绿灯也走同一个闸门，自动熄灭后同样不会复亮。
- 需求变更记录：无。

## 7. 交付与验收

- [x] AC-01~AC-04 有自动化证据。
- [x] 规格索引已更新。
- [ ] 真机：静置 20 分钟以上，WorkBuddy 不再自发亮绿；真正跑完一个任务仍会亮绿（用户确认项）。

最终结果：自动熄灭现在会同时确认完成水位，轮询型监控不会再把同一个完成反复点亮。未提交、未发布。
