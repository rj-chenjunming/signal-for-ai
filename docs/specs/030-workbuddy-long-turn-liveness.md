# SPEC-030：sqlite 监控的长回合活信号与等待态（WorkBuddy 运行中不亮灯）

> 状态：done
> 类型：bugfix（状态判定）
> 需求来源：用户 2026-10-22 17:44 会话——「现在 workbuddy 明明有在运行为啥没灯」。
> 负责人：lead（根因调查：workbuddy-probe）
> 基线提交：`7aadfa7`（工作区含 SPEC-028/029 未提交改动）
> 需求依据及假设：用户要「WorkBuddy 真在干活时灯是蓝的、等权限时是黄的」。不改变「进程不在隐藏」「陈旧 working 不亮蓝」「完成亮绿到点击」的既有语义。
> 关联/替代条款：与 SPEC-021（dsh 长回合活信号）同构，本规格补 WorkBuddy/sqlite 这条支路；不改 SPEC-017 的进程存在性可见性规则。

## 1. 问题与目标

用户看到 WorkBuddy 行**在**（灰点），但 WorkBuddy 明明正在跑任务。

根因（可复核）：

| 证据 | 内容 |
| --- | --- |
| 读库（只读，18:1x） | `sessions` 表 `f416b6cb…`：`status=completed`、`last_activity_at=17:25:57`、`updated_at=17:44:13`（相差 18.3 分钟）；全库 64 条会话状态只有 `completed 60 / working 2 / terminated 2`，两条 `working` 是 10-13 的遗留记录 |
| WorkBuddy 自身状态机日志（UTC，+8） | 同一会话 17:18:31 `working` → 17:33:21 起 `pending`/`working` 交替（权限确认）→ 17:44:13 `completed`。**17:18:31–17:33:21 之间有 14 分 50 秒没有任何状态写入** |
| 判定代码 | `src/main/monitors/sqlite.ts`：`freshActiveCount` 只看 `last_activity_at` 是否在 `activeWithinMs`（默认 120 秒）内；不新鲜就落到 idle（灰） |
| 结果 | 一条**真正在跑**的会话，在长工具执行期间 `last_activity_at` 不推进 → 超过 2 分钟后灯转灰；用户看到的就是「有在运行但没灯」 |

次因：配置 `waitingStatuses: [waiting, awaiting_approval, needs_input]` 在本机库里**从未出现**；WorkBuddy 真实的等待态是 `pending`（上面日志里 10 次 `runtime-status:persisted {"status":"pending"}`）。`pending` 不在任何名单里 → 走 idle 兜底，于是「弹权限确认时灯是灰的而不是黄的」。

目标行为：

1. 长回合里只要 WorkBuddy 还在写状态（回合开始/权限请求/权限通过/完成），灯保持蓝；20 小时前的遗留 `working` 仍然不能亮蓝。
2. 权限确认（`status='pending'`）时灯是黄（waiting）。
3. 进程不在、陈旧 working、完成亮绿到点击等既有语义不变。

## 2. 范围与非目标

- 本次包含：
  - `src/main/monitors/sqlite.ts`：`freshActiveCount` 的"新鲜度"改用 `MAX(COALESCE(last_activity_at,0), COALESCE(updated_at,0))`（`updated_at` 会在每次状态写入时推进，`last_activity_at` 在长工具执行期间不推进）。
  - 默认活动窗口 `DEFAULT_ACTIVE_WITHIN_MS` 120000 → 600000（10 分钟），与 SPEC-004/021 的 10 分钟兜底口径一致；配置示例同步。
  - `buildQueryScript` 的默认 `waitingStatuses` 增加 `pending`；配置示例与本机 `config.local.yaml`（本地、不提交）同步。
  - `test/sqlite-monitor.test.ts`：新增真实 SQLite 临时库集成用例（不得依赖用户库）。
  - 规格索引与本文档。
- 本次不包含：
  - 进程闸门每 5 秒 spawn 一次全量 CIM 的降本（本轮只记录为放大器；需要单独规格评估缓存/复用 presence）。
  - 监控侧"粘性 running"（连续静默 >10 分钟的极端回合）——见残余风险。
  - 日志可观测性增强（每次判定结果/隐藏分支日志），单独立项。
  - 状态机、可见性规则、完成确认水位、IPC、UI。
- 受影响模块/接口/用户文档：`src/main/monitors/sqlite.ts`、`test/sqlite-monitor.test.ts`、`config.desktop.example.yaml`、`config.dsh.example.yaml`、本机 `config.local.yaml`（未提交）；`docs/specs/README.md`。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | 临时库：`status='working'`、`last_activity_at` 已陈旧 18 分钟、`updated_at` 在 1 分钟内；窗口 600000 | 执行 `buildQueryScript` 生成的查询 | `freshActiveCount === 1`；`deriveSqliteVerdict` 判 `running`（蓝） |
| AC-02 | 临时库：`status='working'`、`last_activity_at` 与 `updated_at` 都是 20 小时前 | 同上 | `freshActiveCount === 0` → `idle`（灰），不得亮蓝（20 小时遗留记录回归） |
| AC-03 | 临时库：`status='pending'`、`updated_at` 在 1 分钟内；使用默认 waiting 名单 | 同上 | `freshWaitingCount === 1`；`deriveSqliteVerdict` 判 `waiting`（黄） |
| AC-04 | 临时库：`status='completed'`、`updated_at` 5 分钟前 | 同上 | `lastDoneAt` 为该完成时刻；`freshActiveCount === 0`；既有的"完成亮绿到点击"判定不变 |
| AC-05 | 现有测试与构建 | 执行 | `typecheck` / 全量测试 / `build` / `smoke` 全通过，无新增失败 |
| AC-06 | Windows 真机：WorkBuddy 跑一个 >10 分钟、含连续工具调用/权限确认的回合 | 观察悬浮灯 | 干活期间蓝；权限确认时黄；完成后绿到点击；不再出现「运行中却灰」 |
| AC-07 | 本机 `config.local.yaml` | 应用热重载后 | WorkBuddy 配置带 `activeWithinMs: 600000` 与 `waitingStatuses` 含 `pending`；无配置校验告警 |

边界、异常、恢复/停止行为：

- `last_activity_at` 为 NULL 时用 `updated_at` 兜底；两者都 NULL 视为陈旧（不亮蓝）。
- 陈旧 `working`（10-13 的两条 20 小时记录）仍判 idle，不因 `updated_at` 兜底而复活。
- 窗口只影响"新鲜"判定，不改变 `lastDoneAt` 的无窗口语义与 store 的确认水位。
- `waitingStatuses` 里保留库里不存在的枚举不报错（向后兼容其它 WorkBuddy 版本）。
- 长回合若出现 >10 分钟完全没有状态写入的极端情况，仍可能短暂转灰 —— 记入残余风险，不在本轮解决。

## 4. 方案与任务切片

最小方案：

1. `buildQueryScript` 的 `freshActiveCount`：
   ```sql
   SUM(CASE WHEN lower(status) = lower(?)
            AND (? - MAX(COALESCE(last_activity_at,0), COALESCE(updated_at,0))) <= ?
       THEN 1 ELSE 0 END)
   ```
2. `DEFAULT_ACTIVE_WITHIN_MS = 600_000`；`config.desktop.example.yaml` / `config.dsh.example.yaml` 的 `activeWithinMs` 同步为 600000。
3. `buildQueryScript` 默认 `waitingStatuses` 加 `pending`；配置示例和本机 `config.local.yaml` 同步。

备选取舍：

- 只调窗口（120s→600s）：本例 17:18:31–17:33:21 的 14 分 50 秒静默仍会吃掉一段时间；且无法反映"权限请求在推进状态"。故同时用 `updated_at`。
- 只看 `status`：会重新踩 20 小时遗留 `working` 常蓝的坑（`sqlite.ts` 顶部注释就是这条教训）。
- 监控侧粘性 running：更稳，但需要在 monitor 里维护跨轮状态，且无法用临时库测试覆盖；本轮先做数据层修复，粘性留作后续。

任务切片：

1. **S1（Red）**：`test/sqlite-monitor.test.ts` 新增临时库集成用例（AC-01/AC-02/AC-03/AC-04），在未改监控的代码上运行，确认 AC-01、AC-03 失败。
2. **S2（Green）**：改 `buildQueryScript` 的新鲜度表达式与默认 waiting 名单、`DEFAULT_ACTIVE_WITHIN_MS`；重跑目标测试与全量。
3. **S3（配置与文档）**：同步配置示例与本机 `config.local.yaml`；更新索引与本文档；真机验证交用户。

## 5. 测试计划与追踪

| AC | 测试文件/完整用例名或真机步骤 | Red 证据 | Green 证据 | 回归/平台验收 |
| --- | --- | --- | --- | --- |
| AC-01、AC-02、AC-04 | `test/sqlite-monitor.test.ts`：`updated_at 新鲜但 last_activity_at 陈旧 -> 仍算活跃（长回合不再误判灰）`、`last_activity_at 为 NULL 时也能用 updated_at 兜底`、`两者都陈旧 -> 不活跃（20 小时遗留 working 仍不能亮蓝）`、`completed 的水位不受活动窗口影响（仍然亮绿到点击）` | 2026-10-22 18:05 `npm test -- test/sqlite-monitor.test.ts` exit 1：3 failed / 35 passed；前两条 `expected +0 to be 1`（`freshActiveCount` 仍是 0，证明只看了 `last_activity_at`） | 18:06 同命令 exit 0：38 passed（真实 SQLite 临时库 + 系统 node） | 真实 SQLite（临时库，不碰用户库） |
| AC-03 | 同上：`pending 计入等待态（默认 waiting 名单已含 pending）` | 同上：`freshWaitingCount` `expected +0 to be 1` | 18:06 通过：`freshWaitingCount === 1`，判 `waiting` | 同上 |
| AC-05 | `npm run typecheck`、`npm test -- --maxWorkers=2 --minWorkers=1`、`npm run build`、`npm run smoke` | — | 18:08：typecheck 0；65 files / 937 tests passed；build 0；smoke 0；`git diff --check` 0 | Windows 本机 |
| AC-06 | 真机：WorkBuddy 长回合 + 权限确认，观察灯色（建议配合 `--remote-debugging-port` 采样 data-status） | 用户 2026-10-22 17:44 现场（运行中灰灯）+ 读库/WorkBuddy 日志证据 | 2026-10-23 用户真机确认「SPEC-030 看着也没问题了」 | 真实 WorkBuddy |
| AC-07 | 本机 `config.local.yaml` 已带 `activeWithinMs: 600000` 与 `pending`；应用热重载后配置校验无告警 | — | 2026-10-23 用户重启指示灯后确认无异常（配置于 2026-10-22 18:06:43 热重载，代码改动随重启生效） | Windows 本机 |

## 6. 执行记录

- 规格就绪依据、仍需澄清项：根因由只读读库 + WorkBuddy 自身状态机日志锁定，无需再澄清。`pending` 是否真写入 `sessions.status` 属强推断（持久化事件与 DB 终值一致），本轮按"加入等待名单、不改变其它语义"处理。
- 修改前状态：工作区含 SPEC-028/029 未提交改动；本机 WorkBuddy 配置 `activeWithinMs: 120000`。
- 切片 Red → Green：
  - S1（Red，18:05）：`test/sqlite-monitor.test.ts` 新增 5 条真实临时库用例后 `npm test -- test/sqlite-monitor.test.ts` exit 1（3 failed / 35 passed）：`updated_at 新鲜但 last_activity_at 陈旧`、`last_activity_at 为 NULL`、`pending 计入等待态` 三条的 `freshActiveCount/freshWaitingCount` 都是 0（期望 1）。
  - S2（Green，18:06）：改 `buildQueryScript` 新鲜度为 `MAX(COALESCE(last_activity_at,0), COALESCE(updated_at,0))`、默认 waiting 名单加 `pending`、`DEFAULT_ACTIVE_WITHIN_MS` 600000；同命令 exit 0（38 passed）、`npm run typecheck` exit 0。
  - S3（配置与回归，18:07–18:08）：`config.desktop.example.yaml`、`config.dsh.example.yaml` 的 `waitingStatuses` 加 `pending`、`activeWithinMs` 改 600000；本机 `config.local.yaml` 同步（本地文件，不提交）。`npm run typecheck` 0；`npm test -- --maxWorkers=2 --minWorkers=1` 65 files / 937 tests passed，exit 0；`npm run build` 0；`npm run smoke` 0；`git diff --check` 0。
- 残留风险：若某个回合出现 >10 分钟完全没有状态写入的连续工具执行，灯仍可能短暂转灰（需要监控侧粘性 running，另行立项）。
- 放大器（本轮未修，留作后续规格）：进程闸门每 5 秒 spawn 一次全量 CIM（今日 4 次 5s 超时）、查库 15s 超时 3 次、tasklist 失败 26 次；`maxFailures=3` 今日从未触发，未造成整行消失。
- 可观测性缺口（本轮未修）：日志没有 workbuddy 的状态变更记录，`verdict.hidden` 分支静默 —— 本次排查只能靠读库与截图，建议后续单独补。
- TDD 例外：无。
- 需求变更记录：无。

## 7. 交付与验收

- [x] AC-01 ~ AC-05 有真实 SQLite 临时库用例与全量回归证据；AC-07 本机配置已同步；AC-06 已于 2026-10-23 用户真机确认。
- [x] 类型检查、全量测试、构建后 smoke 及相关集成检查结果已记录（见执行记录）。
- [x] 配置示例、规格索引已更新；本机 `config.local.yaml` 只做本地同步，不提交。
- [x] 残留风险（>10 分钟完全无状态写入的极端回合、闸门 CIM 成本、可观测性缺口）已记录，不阻塞本规格；无遗留失败、无跳过或删除断言。

最终结果/提交引用：已随提交 `9290ee1`（「fix: SPEC-028/029/030 …」）推送 `origin/main`；2026-10-23 用户确认「SPEC-030 看着也没问题了」。回退方式是还原 `sqlite.ts` 的 `MAX(COALESCE(...))` 新鲜度表达式、`DEFAULT_ACTIVE_WITHIN_MS` 与 waiting 默认名单，并重启指示灯。
