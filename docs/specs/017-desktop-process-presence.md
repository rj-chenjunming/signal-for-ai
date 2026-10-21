# SPEC-017：桌面工具存在时才监控

> 状态：done
> 类型：bugfix / behavior
> 需求来源：2026-10-21 用户要求dsh退出后不报红；当前几个工具应存在才监控，不存在不监控。
> 负责人：Codex
> 基线：662f41b＋保留SPEC-015/016未提交改动；上一轮824项通过。Windows本机，Node24.16.0。
> 依据及假设：这里“存在”指主应用进程存在，最小化/关闭到后台仍存在，应继续监控；真正退出才停止。保留配置enabled，不把自动等待与用户暂停混用。
> 关联/替代：覆盖SPEC-002桌面工具退出时的异常语义；保护TaskStore非法转移、完成水位和主渲染共享可见性。

## 1. 问题与目标

桌面工具退出后采集器仍读取API/数据库/会话，导致旧失败或连接错误驱动异常总灯。对配置明确进程名的本地dsh、sqlite/WorkBuddy和Codex桌面目标，确认进程缺席后停止真正数据适配器，等待重新出现；进程仍在时的任务失败、权限/数据异常照常保留。

## 2. 范围与非目标

- 从windowProcess或带processNames的windowTitle取进程白名单，只对dsh/sqlite/codex数据监控启用。不改变普通process/log/webhook、没有桌面进程约束的CLI/网页来源及远程dsh（ssh或非回环authority）。不新增必填配置。
- 使用只读tasklist进程名枚举（包含隐藏/最小化窗口，绝不依赖MainWindowHandle），共享短期缓存与在途查询。只识别确定缺席，枚举失败/畸形/超时不得假装程序已退出。
- TaskState增加可选processPresent运行元数据；缺席由TaskStore统一合法转idle，清除旧错误/未读/耗时，排除悬浮行、聚合、计数、隐藏异常数和通知；面板保留“未运行，等待启动”。不修改enabled/paused或源数据。
- 缺席时确认旧完成至退出观测时刻，重开不重播已关闭实例的完成；新实例产生的新完成照常。此为“退出后不监控”推导的恢复口径，记录为本规格假设，不伪造用户已手动确认。
- 进程恢复自动创建一份新数据适配器，停止旧在途回调/结果，不清洗failed→success、unknown→success/waiting等不变量。首次确定存在不重置已有真实失败；仅确定退出时重置为idle。
- 存在检查间隔默认应用pollIntervalMs，最少1秒；失败/unknown事件转发前强制复查存在性，避免正常退出报红。暂停/配置热重载/停止须释放源适配器与检测定时器，晚到结果不得复亮。
- 不自动启动/退出这些工具，不改数据库/认证；不把程序运行中但服务故障一概静默。

## 3. 验收条件

| ID | Given / When | Then |
| --- | --- | --- |
| AC-01 | 三个桌面目标启动时未运行，或运行后真正退出 | 数据采集器不启动/立即停止，idle+processPresent=false，不红不通知不占灯行；enabled保留 |
| AC-02 | 隐藏/最小化进程仍在；或程序重新出现 | 保持正常监控或自动恢复唯一数据源，新任务可报真实状态，无重复计时器；旧错误/旧完成不复播 |
| AC-03 | 程序仍在但源失败；或进程查询失败/畸形/超时 | 前者真实失败不压制；后者不声明absent，不以枚举错误清洗旧失败；明确unknown/日志诊断 |
| AC-04 | 检测/启动/读源在途时暂停、停止、移除、热重载或再次退出 | 幂等清理，无晚到状态复亮/新源启动/健康重建误触发；恢复配置仅一份源 |
| AC-05 | absent/存在混合，重启指示灯 | 主渲染可见性/聚合/计数一致；面板未运行清楚；真实Windows枚举及安全验收，不将mock当真机 |

## 4. 方案与切片

先补TaskStore/可见性Red，再实现元数据与退出语义；然后用可注入进程检测的适配器包装层编排源生命周期（保留源适配器逻辑），补Red/Green及停止/异常竞态。宿主统一包装符合条件的数据源，配置变化hash包括进程约束。最后UI文案Red/Green、真实tasklist查询/原配置重启；不主动退出用户工具制造失败，用隔离适配器证明关闭路径，必要真机项如实留待用户确认。

## 5. 测试追踪

| AC | 测试（完整用例名） | Red | Green | 平台 |
| --- | --- | --- | --- | --- |
| AC-01 | `process-presence-monitor.test.ts > does not start a desktop data source when its process is absent`；`process-presence-reader.test.ts > gates all three explicit desktop tools, but excludes web/CLI/remote and generic monitors`；`process-presence-store.test.ts > confirmed absence clears an old failure and excludes the task from lights, counts and hidden errors`；`process-presence-notify.test.ts > confirmed absence does not notify even when idle is explicitly in the notification whitelist` | 未单独留存（见执行记录说明） | 4 项通过 | Windows 逻辑层 |
| AC-02 | `process-presence-monitor.test.ts > alive (including hidden windows), exit and reopen maintain exactly one source and drop late events`；`process-presence-store.test.ts > closing suppresses old completion replay, but a new completion after reopening is valid` | 同上 | 2 项通过 | Windows 逻辑层 |
| AC-03 | `process-presence-monitor.test.ts > fresh presence check suppresses an exit error before the next poll; real failures remain`；`process-presence-monitor.test.ts > enumeration failure is not absence and cannot wash a real failure`；`process-presence-store.test.ts > present metadata alone does not wash a real failure into success`；`process-presence-reader.test.ts > parses a complete Windows inventory, rejecting empty/malformed/partial error payloads` | 同上 | 4 项通过 | Windows 逻辑层 |
| AC-04 | `process-presence-monitor.test.ts > stop during initial process query prevents a late data source start`；`stop during source start waits for cleanup and ignores its late status`；`changing process names restarts presence detection, while ordinary title changes do not`；`removing an absent task and reloading while paused creates no sources or timers`；`CLI source without a desktop process constraint is monitored without the presence gate`；`initial enumeration failure is diagnostic unknown; recovery starts just one source`；`process-presence-reader.test.ts > shares in-flight reads and short cache, bypasses cache for errors and retries after read failure` | 同上 | 7 项通过 | Windows 逻辑层 |
| AC-05 | `process-presence-store.test.ts` 可见性/聚合/计数断言（含在上列用例） | 同上 | 通过 | 逻辑层通过 |
| AC-05 | `process-presence-io.test.ts > Windows real hidden process + real session IO: absent / running / exit / reopen`；`process-enum-script.test.ts` 真实 `tasklist` 查询 | 未运行 | 通过（15:33 全量 852 项）；2026-10-21 16:10 用户真机确认退出/重开行为符合 | Windows 真机通过 |

## 6. 执行记录

保留所有本地改动/配置，先实际Red再实现，不继承824项结论。最终类型→全量→构建→smoke，另按影响真实UI及Windows验证。无CI自动强制。TDD例外默认无；未验收保持verifying。

2026-10-21回归发现既有`dsh-discovery.test.ts`把“本机始终有私人dsh运行”写成断言，真实dsh退出时841通过/1失败（`logs/spec017-full-first.log`，退出1）；这与本规格的缺席场景前置冲突，不能用来证明产品回归。将其扫描目标改为自建临时127.0.0.1 HTTP标记夹具，保留原发现数量、端口与分类断言，并增加确切所属端口断言；真实dsh桌面验证另列，不把夹具冒充实际应用。此为测试隔离修正，不改变产品发现行为，Red不适用；原失败证据保留。

2026-10-21 复核（本机 Windows 10.0.18363，managed Node 22.22.2）：
- 状态更正：实现早在本次复核前已随提交落地（`src/main/monitors/process-presence.ts`、`process-enum.ts`，集成于 `host.ts`/`store.ts`/`notify.ts`/`base.ts`），但规格与索引仍停在 `ready`，本次据实更新为 `verifying`。
- 重新执行 6 个测试文件：`4 passed / 2 failed`，共 37 项中 35 项通过。
  - 通过：`process-presence-monitor.test.ts` 10 项、`process-presence-reader.test.ts` 3 项、`process-presence-store.test.ts` 3 项、`process-presence-notify.test.ts` 1 项，覆盖 AC-01～AC-05 的逻辑层。
  - 失败：`process-presence-io.test.ts > Windows real hidden process + real session IO`（`processPresent` 断言得到 `undefined`）与 `process-enum-script.test.ts` 真实 `tasklist` 项（`powershell.exe` 调用返回非零）。两者均依赖真实子进程与 `powershell`，在本次执行上下文中子进程统一以 `0xC0000409` 退出且 `Add-Type` 不可用，属环境前置缺失，不是产品回归。
- Red 记录缺口（如实披露）：本规格实现与测试同批提交，未保留「先失败后通过」的分步证据；没有回退到实现前版本来补造 Red，避免把编译失败或人为改动冒充 Red。后续新增行为仍按 specTDD 记录。

## 7. 交付

- 代码：`process-presence.ts`（缺席不启动源、退出停源、错误上报前强制无缓存复查、generation 版本号丢弃晚到事件）、`process-enum.ts`（`tasklist /fo csv /nh` 只读枚举 + 严格负载校验）、宿主与可见性集成。
- 本轮证据：类型检查通过；6 个 presence 测试文件 35/37；全量 846 项中 811 通过 / 35 失败，失败全部为真机 IO 类（`0xC0000409` 子进程退出码、`powershell`/`Add-Type` 不可用、`dsh-discovery` 网络超时、`sqlite` 子进程），与逻辑层无关。
- 保持 `verifying`：AC-05 的真实 `tasklist` 枚举、隐藏/最小化窗口、真实退出→重开以及指示灯真机表现，需在用户桌面会话验收；不在 Agent 执行上下文标注通过。
- 不自动提交或推送（本轮文档与规格更新由用户确认后处理）；指示灯保持运行。

## 8. 2026-10-21 15:16 复核（完全权限真机）

- 全量回归：`npm test -- --maxWorkers=2 --minWorkers=1`，58 文件 **851 项全部通过**、exit 0，`logs/spec020-full-test.log`。此前记录的 35 项环境失败（含本规格的 `process-presence-io` 与 `process-enum-script` 真实子进程/`powershell` 项）在本次执行上下文下全部通过，不再以“环境不可用”解释这两项。
- AC-05 的真实 Windows 证据补齐：
  - `test/process-presence-io.test.ts` → `Windows real hidden process + real session IO: absent / running / exit / reopen` 通过（真实隐藏进程与会话 IO 的缺席/运行/退出/重开）。
  - `test/process-enum-script.test.ts` → 真实 `tasklist`/`Get-CimInstance` 解析及“真正拿 powershell.exe 解析一遍”用例通过。
- 仍保持 `verifying` 的只剩“指示灯在用户桌面上的真机表现”（例如真的退出某个工具后灯行隐藏/不红、重新打开后恢复唯一数据源）；本机退出 dsh 会中断当前会话，未由 Agent 触发，需用户确认。逻辑层与真实枚举证据已齐，AC-01～AC-04 不再是“未运行”。（已由 §9 的用户确认收口。）
- 历史 Red 缺口（实现与测试同批提交）不补造；本条只更新本轮真实运行事实。

## 9. 2026-10-21 16:10 用户真机确认（AC-05 收口）

- 用户把 WorkBuddy 真正退出：面板显示未运行、悬浮灯不红不占行；重新打开后该行自动恢复，唯一数据源重新启动。用户回复“已测，行为符合”。
- 结合 15:33 全量 58 文件 852 项通过（含真实进程 IO 与真实 `tasklist` 枚举）、typecheck/build/smoke 全绿，AC-01～AC-05 均有可复核证据，DoD 满足。
- 本规格状态改为 `done`；已知限制与历史 Red 缺口如实保留，不补造历史 Red，不声称本规格由自动化关卡强制。
