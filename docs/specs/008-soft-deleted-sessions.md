# SPEC-008：软删除的 WorkBuddy 会话被当成"刚完成"

> 状态：verifying
> 类型：bugfix
> 需求来源：用户 2026-10-19 反馈「workbuddy 明明没有在运行东西，但是隔一段时间他就会自己亮绿灯」；SPEC-007 修掉 dismiss 循环后继续追查数据面
> 基线提交：`2895db2` + SPEC-003~007 未提交工作区；Windows 11；本机 WorkBuddy 数据库（58 行，路径按仓库惯例脱敏）
> 需求依据及假设：用户期望"没有新任务完成就不该亮绿灯"。只修状态判定，不改 WorkBuddy 自身行为。
> 关联/替代条款：修正 SPEC-002/AC-04 的 SQL 语义；与 SPEC-007（自动熄灭确认水位）互补。

## 1. 问题复现与根因

现象（同一句用户反馈的第二层原因）：WorkBuddy 没在跑东西，绿灯仍会隔一段时间自己亮。

取证明细（2026-10-19 17:36–17:45，只读查询）：

1. 库里 `deleted_at` 分布：`null` 46 条、`-1` 3 条、**正数时间戳 9 条（软删除）**；其中 6 条状态是 `completed`。
2. 观察到一个已完成会话 `0fb703d2`：`last_activity_at` 停在 6.4 小时前，但 `updated_at` 在**被删除的那一刻**刷新（`deleted_at ≈ updated_at`）。
3. 我们的完成水位 SQL 是 `MAX(updated_at) WHERE lower(status) = 'completed'`，**没有排除软删除行**。于是 WorkBuddy 清理旧会话时，`updated_at` 一刷新就被当成"刚完成一次" → 绿灯凭空亮起。
4. 叠加 SPEC-007 的 dismiss 循环（自动熄灭不确认水位），就形成"隔一段时间自己亮一次"的观感。
5. `deleted_at = -1` 是 WorkBuddy 的"未删除"哨兵（3 条，其中 1 条 cloud 会话仍在用），不能当删除处理。

## 2. 范围与非目标

- 包含：SQL 增加软删除过滤（`deleted_at IS NULL OR deleted_at <= 0`），并做 schema 兼容探测（老版本库没有该列时保持原行为）；单元测试；规格与索引。
- 不包含：`deleted_at` 其它业务语义；`totalCount` 的展示口径调整（随过滤一起变化，属于同一语义修正）；跨重启的确认水位持久化。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | 库里只有一条软删除的 `completed` | 查库 | `lastDoneAt = 0`，判定 `idle`（不亮绿灯） |
| AC-02 | 未删除与软删除 `completed` 并存 | 查库 | 水位只取未删除那条，正常亮绿灯 |
| AC-03 | `deleted_at = -1`（WorkBuddy 的"未删除"哨兵） | 查库 | 视为未删除，仍参与判定 |
| AC-04 | 老版本库没有 `deleted_at` 列 | 查库 | 查询仍然成功、行为与改动前一致（向后兼容） |
| AC-05 | 本次改动 | 交付前 | `npm run typecheck`、全量 `npm test`、`npm run build`、`npm run smoke` 全绿 |

## 4. 方案与任务切片

`buildQueryScript()` 生成的子进程脚本里先查 `PRAGMA table_info(sessions)`：有 `deleted_at` 就拼 `WHERE (deleted_at IS NULL OR deleted_at <= 0)`，没有就不加过滤。状态计数（active/fresh/waiting/failed/completed 水位/total）统一走这个过滤。

## 5. 测试计划与追踪

| AC | 测试 | Red 证据 | Green 证据 | 回归/真机 |
| --- | --- | --- | --- | --- |
| AC-01 | `test/sqlite-state-integrity.test.ts`「只有软删除的 completed -> 不产生完成水位」 | 同文件 → **1 failed / 15 passed**：`expected 1792403071563 to be +0` | 同文件 **16/16** 通过 | 真机：删会话不再亮绿 |
| AC-02 | 同文件「未删除 + 软删除混合 -> 水位只取未删除那条」 | 初始即通过 | 通过 | — |
| AC-03 | 同文件「deleted_at = -1 视为未删除」 | 初始即通过 | 通过 | — |
| AC-04 | 同文件「老版本库没有 deleted_at 列时仍能查询」 | 初始即通过 | 通过 | — |
| AC-05 | typecheck / test / build / smoke | — | 见 §6 | Windows 本机 |

## 6. 执行记录

- 规格就绪依据：`deleted_at` 分布实测 + `0fb703d2` 的 `deleted_at ≈ updated_at` 证据 + 现有 SQL 未过滤软删除。
- 修改前回归：`npm run typecheck` 0；`npm test` 37 文件 699 用例通过。
- 切片：测试先行取红（1 failed / 15 passed）→ 实现 schema 探测 + WHERE 过滤 → 同文件 16/16；相关回归（sqlite-monitor / sqlite-lifecycle）53 项通过。
- 与 SPEC-007 的关系：SPEC-007 修"自动熄灭后重复点亮"的循环；本规格修"删除会话被当成完成"的假信号。两条合起来才解释完用户看到的现象。
- 需求变更记录：无。

## 7. 交付与验收

- [x] AC-01~AC-05 有自动化证据。
- [x] 规格索引已更新。
- [ ] 真机：静置观察 WorkBuddy 不再自发亮绿（用户确认项）。

最终结果：软删除会话不再参与状态判定，删除操作不会再点亮绿灯。未提交、未发布。

### 2026-10-21 15:24 真库只读复核（完全权限）

- `node scripts/sqlite-monitor-check.mjs 'D:/wb_data/.workbuddy/workbuddy.db'`：16 项全部通过，`logs/spec008-sqlite-check.log`。真库 `totalCount=51`、`lastDoneAt=1792565742300`；确认水位演示：未确认→`success`、已确认同一完成→`idle`、更晚完成→`success`。
- 直接对比软删除过滤（`logs/spec008-soft-deleted-check.cjs`、`.log`）：`deleted_at` 列存在；`completed` 共 58 条，其中未删除 50 条、软删除 8 条、`deleted_at=-1` 哨兵 3 条。软删除行的最大 `updated_at` 为 `1792552075265`，早于未删除行的 `1792565742300`；因此本次采样下未过滤 SQL 恰好也会取到未删除水位（`unfilteredWouldUseNewerWatermark=false`），但过滤确实排除了 8 条软删除行，AC-01/02/03 的语义在真库上成立。
- 全量 851 项、typecheck/build/smoke 全绿（`logs/spec020-*.log`）。
- 仍保持 `verifying`：用户侧“静置观察不再自发亮绿”的时序观感未确认；本次真库采样只能证明过滤语义，不冒充 20 分钟以上的观察结论。

### 2026-10-21 16:13 真库复核（新完成，不是软删除幽灵）

- 真库 `completed` 共 58 条：未删除 50 条、软删除 8 条、`deleted_at=-1` 哨兵 3 条。
- 最新未删除完成 `max(updated_at)=1792570330301`（2026-10-21 16:12:10），软删除行最大 `updated_at=1792552075265`（更早）；当前面板 WorkBuddy“已完成”来自真实新完成，不是软删除会话被当成完成。
- 仍待静置观察（SPEC-007 的 16:22 自动熄灭复核一并覆盖）；不因这次真实完成把本规格标 done。

### 2026-10-21 16:25 复核（真实活动解释了绿灯）

- 最新会话 `f315adfb`（`is_playground=1`）在 `completed` 与 `working` 间切换，`updated_at` 与 `last_activity_at` 同步前进；16:22 的绿灯对应真实完成/活动，不是软删除行被当成完成。
- 软删除行（8 条）最大 `updated_at` 仍为 `1792552075265`（早于最新未删除完成），过滤语义未回退。
- 要证明“无新完成时不自发亮绿”，需要 WorkBuddy 静置 ≥20 分钟的干净窗口；当前 WorkBuddy 有活动，不能据此闭环。状态保持 `verifying`。
- 2026-10-21 16:30 用户明确选择**跳过**该静置观察。本规格不记为通过或失败；软删除过滤与真库语义证据保留，时序观感项如实保持未验收。
