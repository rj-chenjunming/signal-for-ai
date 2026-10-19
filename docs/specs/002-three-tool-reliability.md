# SPEC-002：三工具状态与桌面切换可靠性

> 状态：verifying
> 类型：bugfix / feature / characterization refactor
> 日期：2026-10-19
> 来源：用户授权按判断优化项目；重构须采用特征重构；dsh、WorkBuddy、Codex 至少正确显示状态并点击切换。用户已确认 Codex 是桌面应用。
> 基线：6dbe5a6 + SPEC-001 未提交文档；Linux / Node 24；历史运行 608 通过、10 失败，smoke 6 失败。

## 目标与范围

指示灯表达工具中的任务事实：运行中、需关注、完成、无可靠信号；点击对应已打开的桌面工具。优先修复共用状态仓库与跳转链，再为 Codex 本地会话增加只读结构化事件监控，提供三工具配置及真机验收入口。

不把进程存活当成任务执行，不把任意非 working 数据库状态判成成功，不用日志正文关键词猜 Codex 状态。保留既有架构、配置兼容、失败不能直接洗绿、未知不能凭空成功等约束。不会替用户启动或修改 dsh/Codex/WorkBuddy，也不写入这些工具的历史或凭据。

Codex 数据面以公开 rollout 协议为依据：本地 sessions 中的 event_msg/task_started/task_complete/turn_aborted；兼容 turn_started/turn_complete 名称。其持久化策略不保证审批事件落盘，未观测到时不能宣称能精确判等待授权。云任务若不落到本地会话目录，不虚构本地状态。桌面目标按进程身份定位；应用多窗口时只保证切到匹配工具，精确到线程不在本轮范围。

## 验收条件

| ID | Given / When / Then |
| --- | --- |
| AC-01 | 同一任务持续上报相同有效状态时，心跳持续更新且不重复广播；真正停止信号才超时。连续完成更新确认水位，新一轮真实运行/等待能覆盖上一轮完成。缺失来源可从 idle 进入 unknown。 |
| AC-02 | 本地绝对/相对日志路径可匹配，基线测试不依赖个人凭据/环境；Windows PowerShell 真测保留为 Windows 必跑，Linux 明确跳过且披露。 |
| AC-03 | 给定显式桌面目标，即使装有 WT 也先定位该工具；支持进程名定位无品牌标题窗口，不抢无关窗口，不默认新增终端。窗口激活完成且获确认后才返回成功；失败有明确反馈。 |
| AC-04 | WorkBuddy 数据库中的 failed/aborted/unknown 等状态不被当成 success；仅明确完成值进入完成水位。保留 working 新鲜度判定、确认去重、只读查询。 |
| AC-05 | Codex 已有本地事件，新建/追加/半行/截断/多会话时，按结构化 turn 事件判定运行、完成、取消/失败；普通文字或工具错误不会伪造完成；旧已完成历史不在启动时刷提醒。读取不到、格式未知、运行信号陈旧须明确显示未知，不能假绿。 |
| AC-06 | Codex 监控可配置、被宿主创建、可重复停止、无重复定时器/停止后上报；完成确认不复亮，其他会话运行优先于已完成会话。只读必要本地 rollout，不读取 auth/凭据或上传正文。 |
| AC-07 | 提供 dsh/WorkBuddy/Codex 桌面配置、必要路径/端口的本地检查方式、已知信号边界和 Windows 状态/切换验收清单；示例可通过配置解析与集成验证。 |
| AC-08 | 类型检查、适用全量测试、构建后 smoke 通过；Windows/真实工具验收另记，缺环境时保持 verifying，不称已在用户本机通过。 |

## 规格调整依据

AC-01 明确替代旧 success 只能经 starting 回到执行的限制，以及 idle 不能失联的转移限制；这两处使正常持续监控/连续任务失真。failed/unknown 直接转 success 仍禁止。
AC-03 保留 URL/显式 spawn 的行为，显式窗口优先于自动 WT；修复异步请求被当成成功的旧行为。新 windowProcess 使用显式进程白名单，避免品牌标题依赖。
AC-04 收紧旧“非 working 就完成”为明确 completed（可配置）；这属于修复假绿灯，不将失败/取消改成完成。

## 特征重构与执行顺序

1. 运行既有状态/焦点/配置/监控特征测试，先记录保留的行为；针对观察到的错误新增回归测试并取得 Red。
2. 最小修复状态/路径与测试隔离；对于纯提取部分，先特征测试 Green，再提取，再复验，不伪造 Red。
3. 锁住显式 URL、进程过滤、找不到时不乱抢等既有行为，再调整窗口定位和确认流程；新策略先 Red。
4. Codex 解析器与只读监控按协议 fixture 和真实临时 JSONL 测试先行，接入配置/宿主。WorkBuddy 用真实临时 SQLite 验证 SQL 语义。
5. 全量验证与文档更新；用户 Windows 环境验证属于最后的实际验收。

## 测试与证据

工作目录统一为 /workspace/signal-for-ai。每个切片在下方记录新增测试、执行版本、Red/Green 命令与退出码；与既有基线失败区分。

Windows 桌面工具在当前 Linux 云机器不可访问；自动化结果见下文，实际桌面验收见[三工具指南](../development/desktop-validation.md)。

## Codex 采集设计边界（实现前补充）

每轮只读最近修改的 32 个 JSONL 文件末尾最多 512 KiB，最多遍历 5000 个目录项、6 层；超预算/无权限报告 unknown，不追踪符号链接。尾部快照重放自然覆盖追加、半行、截断与替换，避免轮询持有永久文件句柄。普通正文、未完成行与未知事件不猜状态；运行新鲜度由结构化事件时间判断。启动前完成仅作为空闲基线，启动后的明确完成才提醒；同一文件新 turn 的开始覆盖旧完成，旧 turn 的迟到完成忽略。多会话优先显示运行，陈旧运行不冒充完成。监控恢复时只有可靠的新开始才恢复运行；unknown 后只发现完成则保持 unknown，等待新轮次，保护 store 不变量。审批等待能力本轮不保证。失败/失联沿用现有浮窗隐藏规则，可从面板与通知诊断，不擅自覆盖历史用户选择。

AC-03 补充：缓存窗口在应用重启后可能失效，激活失败须重新枚举并仅重试新的匹配 HWND。AC-04 补充：暂停/停止不能有迟到数据库结果上报，重复 start 不创建重复定时器；进程闸门查询失败不作为“进程存在”证据。

AC-03 点击反馈补充：浮窗必须显示切换失败/IPC 异常的一次性提示，沿用现有 toast，不恢复悬停文案；完成确认仍独立于切换结果。用完整 renderer 脚本在最小 DOM harness 中验证点击与缓存行更新，先记录现状特征，再补失败反馈 Red；它不替代 Windows 的可视验收。

## 实施与验证记录

代码状态均为 `6dbe5a6` 上同一未提交工作区，以下按切片先后记录；不是已提交版本或发布声明。新增能力按 Red → 最小实现 → Green 执行；没有改动依赖清单，也没有进行整仓重写。现有状态、焦点、SQL 的特征测试先通过，再修改规格明确授权的行为；纯整理仅在通过后消除重复逻辑/过时注释。浮窗 toast 提取前已有两条行为特征通过。配置模板及说明属声明式文档，检查解析与链接，不虚构 Red。

### 特征基线

修改源码前运行：

```bash
npm test -- test/store.test.ts test/store-extra.test.ts test/store-ack-completion.test.ts test/focus.test.ts test/config.test.ts test/sqlite-monitor.test.ts --maxWorkers=2 --minWorkers=1
```

退出码 0，6 文件、157 用例全部通过。`/tmp/signal-002-characterization.log` 记录这次结果。保留状态机防洗绿、完成确认、URL/进程过滤和数据库新鲜度语义；将失真的旧行为按本规格明确替换。

### Red / Green 追踪

下表文件均在 `test/`；命令前缀为 `npm test --`，本地日志在 `/tmp/signal-002-*.log`（临时诊断文件，不要求跨环境存在）。Red 是对应行为实现之前的断言失败；Green 是该切片实现后的相邻回归。两阶段退出码分别为 1 / 0。

| AC / 切片 | Red 命令及结果 | Green 命令及结果 |
| --- | --- | --- |
| 01/02 心跳、完成水位、根路径 | `test/store-liveness.test.ts test/log-tail.test.ts --maxWorkers=2 --minWorkers=1`：18 通过、11 失败。其中新增 7 失败：同态 running/waiting 超时、新 running/waiting 被拒、水位未更新、idle 无法 unknown、绝对文件路径匹配为空；另 4 是原 glob 基线失败，不算新增 Red | 同两文件加 `store.test.ts store-extra.test.ts store-ack-completion.test.ts store-waiting.test.ts config-dsh.test.ts dsh-monitor.test.ts process-enum-script.test.ts`（每个文件带 `test/`）：176 通过、1 Windows 用例跳过 |
| 03 显式桌面定位及确认 | `test/focus-reliability.test.ts --maxWorkers=2 --minWorkers=1`：4 失败、1 通过；WT 抢优先级、未确认就成功、异步提前返回、windowProcess 配置丢弃 | 同文件加 `test/focus.test.ts test/config-jump-url.test.ts`：68 通过 |
| 04 WorkBuddy 状态 | `test/sqlite-state-integrity.test.ts --maxWorkers=2 --minWorkers=1`：6 失败、2 通过；真实 SQLite 的 failed/aborted/waiting/unknown 被当完成，failed/waiting 未映射 | 同文件加 `test/sqlite-monitor.test.ts`：41 通过 |
| 05/06 Codex 配置 | `test/config-codex.test.ts`：2 失败，任务被丢弃。首次捕获输出的 shell 未透传退出码；Vitest 明确报告失败，不据 shell 0 声称通过 | 同命令：2 通过；增加桌面模板解析后 3 通过 |
| 05/06 Codex 本地链路 | `test/codex-monitor.test.ts`：可执行接口骨架只报告 unknown，12 目标断言失败、1 通过；不是导入/编译失败。覆盖运行→完成→确认、旧历史、半行、普通文本/错误、取消、旧 turn、多会话、截断、陈旧活动、缺目录恢复、重复启动/停止、host 接入 | 同文件加 `test/config-codex.test.ts`：15 通过（当时配置 2 用例），真实临时 JSONL + 状态仓库/宿主；源码不读写个人会话样本 |
| 03/04 重启窗口与在途 SQL | `test/sqlite-lifecycle.test.ts test/focus-reliability.test.ts`：5 新断言失败、5 通过；旧 HWND 不重找、重复 timer、停止后成功/失败上报、闸门失败假定进程存在 | 同两文件加 `test/sqlite-monitor.test.ts test/sqlite-state-integrity.test.ts test/focus.test.ts test/store-liveness.test.ts`：102 通过 |
| 03 浮窗点击反馈 | `test/overlay-actions.test.ts`：2 特征通过（缓存行状态、既有通知），2 失败（返回失败/IPC reject 无可见文本）；执行完整 classic script，不读取源码片段断言 | 同命令：4 通过；保留确认独立发送，用既有 toast 显示失败 |

### 基线收敛

- B-01：保留路径根，修复 7 个原测试与 smoke 的 6 项日志失败。
- B-02：仅真实 `powershell.exe` 语法用例按平台执行。Linux 跳过，Windows 必跑，脚本生成/解析其他用例仍执行。
- B-03/B-04：测试自行设置 USERPROFILE 并恢复、临时构造凭据样本并清理，不读取个人凭据。这是测试隔离；不把旧基线失败冒充新行为 Red。

### 最终自动化检查

2026-10-19，Linux / Node 24.19.0 / npm 11.9.0，工作目录 `/workspace/signal-for-ai`。renderer 点击反馈修复后按以下顺序重新运行：

| 命令/检查 | 退出码 | 实际结果 |
| --- | --- | --- |
| `npm run typecheck` | 0 | main / renderer / test 三份检查通过 |
| `npm test -- --maxWorkers=2 --minWorkers=1` | 0 | 35 文件通过；664 用例通过，1 Windows PowerShell 用例跳过，0 失败，共 665 |
| `npm run build` | 0 | 主进程、classic renderer、资源复制通过 |
| `npm run smoke` | 0 | 22 项断言通过，包含真实文件追加/路径与 HTTP 闭环 |
| 本地 Markdown 链接检查 | 0 | 17 个新增/修改 Markdown，73 个本地文件链接无缺失 |
| `git diff --check` | 0 | 无空白错误 |

相对接管时 618 用例，本轮净增 47 个用例。原 10 失败中 9 已修复，1 明确划为 Windows 必跑而非在 Linux 伪造通过。完整最终命令输出保存在 `/tmp/signal-002-typecheck.log`、`/tmp/signal-002-full-test.log`、`/tmp/signal-002-build.log`、`/tmp/signal-002-smoke.log`。

已同步云环境配置草稿的 `install_script` / `start_skill`：系统 Node 24 前置、现有 checkout、无 GUI 安装、specTDD 与当前验收入口。保存成功，尚未发布；没有声称已验证新的任务恢复。Windows 真机尚未执行，不将协议 fixture 或 DOM harness 结果说成已在用户电脑可用。

### 兼容性与余项

新增 `monitor.type: codex` 与 `terminal.type: windowProcess`；SQLite 增加明确完成/等待/失败值映射。旧配置仍可解析，但“任意非工作状态亮绿”和“无目标盲抢终端”的旧行为按本规格收紧。现有浮窗隐藏失败/失联、点击完成与跳转独立、URL/显式 spawn、主进程统一写状态均保留。

源码、测试、示例和流程文档作为本次 Git 同步内容，用户已授权提交并推送；提交标识以 Git 历史为准，应用尚未发布。Windows 前台锁、进程名、各工具真实数据格式、等待信号与 toast 可见性须按桌面指南验收，SPEC-002 因此保持 verifying。todo 已进入索引的低优先级清单，没有开始实现。
