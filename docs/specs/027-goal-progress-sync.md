# SPEC-027：目标进展本地同步入口（file inbox + CLI）

> 状态：done
> 类型：feature（自动化/集成）
> 需求来源：用户 2026-10-22 会话——「以后在这个工作区有任何进展，帮我同步到相关的任务中《AI信号灯软件开发》」；确认「这个需要 spec，这个项目你就自己帮我写入就好了」。
> 负责人：lead + 开发者
> 基线提交：`186968b`（SPEC-026 已提交并推送）。
> 需求依据及假设：目标是【目标清单】里的长期目标「AI信号灯软件开发」（`goals.json` 中存在同名目标）。应用是本地优先的单实例桌面程序，目标数据由主进程持有，外部直接改 `goals.json` 会被内存状态覆盖；因此新增**本地文件收件箱**，由应用导入成时间线条目，CLI 给开发者/AI 使用。不引入网络端口与鉴权。
> 关联/替代条款：扩展 SPEC-024（目标数据）与 SPEC-026（排序）；不改变目标窗口 UI 与悬浮灯摘要。

## 1. 问题与目标

开发过程中的进展（完成一个 SPEC、跑完回归、修复问题）目前只能通过目标窗口手动输入。用户希望 AI/开发者在工作区完成工作后，用一条命令把进展写进目标「AI信号灯软件开发」的时间线，不必手动点 UI。

目标行为：`node scripts/goal-sync.mjs --goal "AI信号灯软件开发" --text "..."` 把一行 JSON 追加到应用 userData 下的 `goal-inbox.jsonl`；运行中的应用（或下次启动）在约 1 秒内导入为对应目标的「进展/问题」条目，并清理收件箱。失败行保留到 `.failed.jsonl` 供排查，不阻塞应用。

## 2. 范围与非目标

- 本次包含：
  - `goal-inbox.jsonl` 文件协议：`{ goal? , goalId? , kind?, text }`，按 id 或**唯一**标题匹配目标。
  - 应用侧轮询导入（1s），原子 rename 后处理，避免边写边读丢行；启动即 drain 一次。
  - 导入结果：合法行走 `GoalsStore.addEntry()`（触发窗口/悬浮灯摘要更新）；非法/找不到目标的行写入 `goal-inbox.failed.jsonl`（含原因）并记录日志。
  - CLI `scripts/goal-sync.mjs`：`--goal`/`--goal-id`、`--text`、`--kind progress|issue`、`--inbox`（测试/非常规 userData 用）、`--help`。
  - 单元测试、CLI 测试、`check:goals` 集成、真实应用 1 秒内导入验证。
- 本次不包含：
  - HTTP/WebSocket 接口、鉴权、远程同步、多人并发。
  - 通过收件箱修改/删除目标、改状态/进度（只追加记录）。
  - 目标窗口内的收件箱 UI（失败文件只在日志/文件里可见）。
  - 在 `goals.json` 上做文件监听/热载（避免与主进程写盘竞争）。
- 受影响模块/接口/用户文档：
  - 新增 `src/main/goals-inbox.ts`、`scripts/goal-sync.mjs`、`test/goals-inbox.test.ts`、`test/goal-sync-cli.test.ts`。
  - `src/main/index.ts`（启动/停止轮询）、`scripts/goals-window-check.cjs`（集成）、`README.md`、规格索引、本规格。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | 应用运行中，目标「AI信号灯软件开发」存在 | 执行 `node scripts/goal-sync.mjs --goal "AI信号灯软件开发" --text "SPEC-026 完成"` | CLI 退出码 0；约 1 秒内目标时间线新增一条「进展」，内容与文本一致 |
| AC-02 | 应用未运行（或刚启动） | 先写入收件箱，再启动应用 | 启动后自动导入；条目出现在目标时间线，收件箱被清空 |
| AC-03 | 收件箱有多行合法记录 | 一次 drain | 按行顺序全部导入；每行只导入一次；收件箱清空 |
| AC-04 | 行中使用 `goalId` | 执行导入 | 按 id 精确匹配，同名目标不会歧义 |
| AC-05 | 行中使用标题且存在两个同名目标 | 执行导入 | 不猜测：该行进入失败文件，原因说明「同名目标不唯一」 |
| AC-06 | 行包含非法 JSON、缺 text、超长 text、未知 goal、kind=done | 执行导入 | 其余合法行照常导入；非法行写入 `.failed.jsonl` 并带原因；应用不崩溃 |
| AC-07 | 收件箱为空 / 不存在 | 轮询触发 | 无操作、无写入、无日志噪音 |
| AC-08 | 应用运行中导入成功 | 查看目标窗口/悬浮灯 | 时间线立即出现新记录；进行中数量/平均进度不变（追加记录不影响摘要） |
| AC-09 | CLI 参数缺失 / `--kind` 非法 / text 超长 | 执行 CLI | 退出码非 0，stderr 说明原因；不写收件箱 |
| AC-10 | 处理过程中留下 `.processing-*` 文件（模拟崩溃） | 下次 drain | 遗留处理文件也会被导入并清理 |
| AC-11 | 现有功能 | 回归 | typecheck / 全量测试 / build / smoke / check:ui / check:goals 全通过 |
| AC-12 | Windows 真机 | 执行一次 CLI，观察目标窗口 | 1 秒内出现记录；无手动刷新；应用重启后仍可导入 |

边界、异常、恢复/停止行为：

- 收件箱按行解析，空行忽略；单行上限 8KB（超过直接失败），`text` 1–500 字符（trim 后）。
- 并发：应用用 `rename(inbox → inbox.processing-<ts>)` 抢占；CLI 追加到新文件不会丢。处理完删除临时文件。
- 失败行写入 `goal-inbox.failed.jsonl`（追加，含 `reason` 与原始行），不入库；收件箱本身清空，避免无限重试。
- 目标匹配：`goalId` 优先；否则按 trim 后的标题精确匹配；0 个或多个匹配都算失败。
- `kind` 只接受 `progress` / `issue`（`done` 由完成动作自动追加）。
- 轮询间隔 1000ms，`unref()`，应用退出时清理；导入复用 `GoalsStore.addEntry`，自然触发 UI 推送与持久化。
- 收件箱路径：`app.getPath('userData')/goal-inbox.jsonl`；CLI 默认 `%APPDATA%/ai-task-indicator/goal-inbox.jsonl`，可用 `--inbox` 或 `AI_INDICATOR_USER_DATA` 覆盖。

## 4. 方案与任务切片

### 4.1 文件协议

```jsonc
// goal-inbox.jsonl —— 每行一条，追加写
{"goal":"AI信号灯软件开发","kind":"progress","text":"SPEC-026 拖拽排序完成，918 tests 通过（186968b）"}
{"goalId":"<uuid>","kind":"issue","text":"Windows 真机验收发现 …"}
```

### 4.2 应用侧

- `src/main/goals-inbox.ts`（纯 Node，可单测）：
  - `drainGoalInbox({ inboxPath, store, logger, now }): { applied, failed }`：
    1. 收集 `goal-inbox.jsonl` 与遗留 `goal-inbox.jsonl.processing-*`；
    2. 对每个文件先 rename 为 `.processing-<ts>-<rand>`（若竞争失败则跳过本轮）；
    3. 逐行解析/校验/匹配/`store.addEntry`；失败行追加到 `goal-inbox.failed.jsonl`；
    4. 删除处理文件。
  - `GoalInboxPoller`：`start()` 立即 drain 一次 + `setInterval(1000)`（unref）；`stop()`。
- `index.ts`：创建 `GoalInboxPoller`，`start()`；`cleanup` 中 `stop()`。

### 4.3 CLI

- `scripts/goal-sync.mjs`（零依赖）：
  - 参数：`--goal <title>` 或 `--goal-id <uuid>`（二选一）、`--text <text>`（必填）、`--kind progress|issue`（默认 progress）、`--inbox <path>`、`--help`。
  - 校验后 `mkdir -p` + `appendFileSync` 一行 JSON；打印收件箱路径与「应用会在约 1 秒内导入」。
  - 失败原因输出 stderr 并 `process.exit(1)`；缺参数显示用法。

### 4.4 任务切片

1. **S1 导入逻辑**：`drainGoalInbox` 解析/匹配/失败文件/遗留文件；`test/goals-inbox.test.ts`。
2. **S2 CLI**：参数、写入、错误退出；`test/goal-sync-cli.test.ts`。
3. **S3 应用接线**：轮询 start/stop；`check:goals` 集成一次 drain。
4. **S4 真机**：应用运行时执行 CLI，1 秒内目标窗口出现记录；重启后仍可导入。
5. **S5 回归**：typecheck / 全量 / build / smoke / check:ui / check:goals。

## 5. 测试计划与追踪

| AC | 测试文件/完整用例名或真机步骤 | Red 证据 | Green 证据 | 回归/平台验收 |
| --- | --- | --- | --- | --- |
| AC-01 ~ AC-10 | `test/goals-inbox.test.ts`：按标题/id 导入、多行、清空、同名歧义、非法行失败文件、空文件、遗留 processing、kind 限制、text 校验 | 2026-10-22 14:00 首跑：6 failed / 2 passed，exit 1（`drainGoalInbox` 未实现） | 2026-10-22 14:02 复跑：6 passed | 全量 928 passed |
| AC-01、AC-09 | `test/goal-sync-cli.test.ts`：正常写入、缺 text、非法 kind、超长文本、--help | 2026-10-22 14:00 首跑：3 failed（脚本未实现；随后修正 .mjs 中的 TS 注解导致语法错误） | 2026-10-22 14:02：4 passed | 全量 |
| AC-02、AC-08 | `check:goals`：写收件箱 → drain → store 出现记录 → 收件箱清空 | 2026-10-22 14:04 首次集成加入后通过 | 2026-10-22 14:04 PASS | 真实 Electron |
| AC-11 | typecheck / full / build / smoke / check:ui / check:goals | — | 2026-10-22 14:04–14:05 全通过：64 files / 928 tests、smoke、check:ui 31、check:goals PASS | — |
| AC-12 | Windows 真机：运行中执行 CLI，目标窗口 1s 内出现记录 | — | 2026-10-22 14:06：应用运行中执行 4 条 `goal-sync`，日志 `[goals-inbox] 导入 4 条，失败 0 条`；`goals.json` 时间线出现 4 条记录；收件箱已清空 | 实机验证通过 |

## 6. 执行记录

- 规格就绪依据、仍需澄清项：用户明确要求由 AI 直接写入目标；本地文件收件箱为推导实现（不改目标数据归属、不引入网络）。若将来要 HTTP/CI 调用，另建规格。
- 修改前回归：`186968b` 上全量 918 / smoke / check:ui / check:goals 通过。
- 每个切片的 Red → Green → Refactor：
  - S1 Red：`test/goals-inbox.test.ts` 6 failed / 2 passed；实现 drain（rename 抢占、失败文件、遗留 processing）后 6 passed。
  - S2 Red：`test/goal-sync-cli.test.ts` 3 failed（脚本未实现）；实现 CLI 时修正了 .mjs 误写 TS 类型注解的语法错误，最终 4 passed。
  - S3 接线：`GoalInboxPoller` 1s 轮询 + `index.ts` start/stop；`check:goals` 增加 drain 断言 PASS。
  - S4 真机：应用运行中执行 4 条 `goal-sync`，14:06:21 日志显示导入 4 条 / 失败 0；`goals.json` 时间线出现 4 条记录，收件箱已清空。
  - S5：64 files / 928 tests、build、smoke、check:ui 31、check:goals 全通过。
- TDD 例外：CLI 进程行为用集成测试覆盖；真实应用 1 秒轮询用实机验证（本次已在 Windows 实机完成）。
- 需求变更记录：无。

## 7. 交付与验收

- [x] 所有 AC 有验收证据；满足[流程 DoD](../development/spec-tdd.md)。
- [x] 类型检查、全量测试、构建后 smoke 及所需真机验证结果已记录（实机 CLI→应用导入已验证）。
- [x] 相关文档、规格索引、配置示例已更新；没有秘密或本机配置进入提交。
- [x] 已知失败接受依据（如适用）、未完成项、回退步骤、发布状态已说明。

最终结果/提交引用：2026-10-22 实机验证通过（CLI 4 条 → 1 秒内导入，收件箱清空）；代码随本次提交合入。后续每个 SPEC 完成/重要修复由 AI 用 `goal-sync` 追加一条进展。
