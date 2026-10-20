# SPEC-011：Codex 授权等待 Hook

> 状态：done
> 类型：feature / bugfix
> 基线：`13c6a98`，Windows 11 / Node 24.16.0；2026-10-20。
> 来源：用户反馈授权时灯未变化，明确选择“先接 Hook：审批时黄灯，工具返回后恢复蓝灯”。
> 负责人：Codex
> 关联：补充 SPEC-010 只读 rollout 不保证审批等待的边界；保留原回合完成和确认规则。

## 1. 问题与目标

本机 rollout 没有审批事件；桌面日志仅记录发送审批结果，不能用来认定等待开始。官方 App Server 提供请求/解决事件，但当前文件监控没有连接其活跃传输。系统 Codex 版本 `0.163.0-alpha.10.2` 的 hooks 功能为 enabled。

按用户选择，用官方 `PermissionRequest` 触发黄色等待，匹配的 `PostToolUse` 清理等待；工具执行期间可能继续黄色，到返回时恢复。不是“点击批准瞬间变蓝”的精确模式。来源：[官方 Hooks](https://learn.chatgpt.com/docs/hooks)、[App Server](https://learn.chatgpt.com/docs/app-server)。

## 2. 范围与非目标

- 新增旁路 Hook 脚本和可选 `monitor.approvalEventsFile`；与真实 rollout 的 session/turn 绑定。
- Hook 仅写应用自己的忽略事件日志；不改 Codex 数据库、rollout 或认证，不批准/拒绝/改写工具，不导出正文/命令。
- 安装时合并用户 hook 配置并备份，保留已有 Hook；信任必须由用户完成，不能绕过 trust 或把未信任 Hook 当作已工作。
- 本轮不自动提交/推送；前轮授权的本地提交已经完成，不外推为后续自动提交授权。

## 3. 验收条件

| ID | Given | When | Then |
| --- | --- | --- | --- |
| AC-01 | 官方 Hook 输入 | PermissionRequest / PostToolUse / Stop / Interrupt / SessionEnd / UserPromptSubmit | 输出中立 JSON `{}`，仅写版本、事件、session/turn、工具输入摘要和时间；命令/正文/输出不写入，未知/坏输入不改变审批决定 |
| AC-02 | 可靠 rollout 开始及同 session/turn 的新审批 | 轮询 | running→waiting，黄灯可见；其它会话运行不遮蔽等待；缺开始证据不洗成 waiting |
| AC-03 | 多个待批工具 | 对应工具返回、其它工具返回、重复轮询 | 只清理匹配输入摘要的一项计数，全部返回后恢复蓝；无关工具不清理，重复读取不复亮 |
| AC-04 | 新回合、结束、中断、老记录、超时或读取错误 | 轮询/停止/恢复 | 正确隔离 turn；结束/中断清理，过期未知；半行不生效；可选文件未连接不破坏原任务监控；停止无迟到上报 |
| AC-05 | 新配置与旧配置 | 校验/加载 | 可选字段保留、非法值警告，旧配置兼容；原全量回归通过 |
| AC-06 | 本机已有指示灯和用户确认的 Hook 方案 | 构建、合并安装、重启 | 配置保留，正常运行；实际 trust/授权黄灯未验证前维持 verifying，并明确用户最后需要做的步骤 |

匹配策略：session/turn 相同，工具名与规范化输入的 SHA-256 相同；Bash 只取 command/cmd（不含权限理由）。相同命令并发用计数；不处理无法证明对应的工具返回。等待最长沿用 `waitingTimeoutMs`，过期不猜已批准。普通 token 活动不清理其它并行审批。

## 4. 实现切片与边界

1. 先测试 Hook 发布器的隐私和中立输出，再实现；默认禁用旁路时原监控完全兼容。
2. 先测试配置与聚合，再接入有界 JSONL 读取；复用经过特征测试保护的增量读取器（最多 512 KiB/轮、短半行 256 KiB），不另造无限日志扫描。
3. Hook 状态最多保留 128 个会话/回合、每回合 128 种工具摘要、同摘要 128 个计数、128 个清理水位；过量/异常明确降级。过期非等待记录在新事件到来时清理，待批证据保留以识别超时。
4. 只准备/安装 Hook 配置，不写信任存储。用户 trust 是平台要求的最后步骤，不代替人工审批。

## 5. 追踪

| AC | 验证 | Red | Green |
| --- | --- | --- | --- |
| 01 | `test/codex-status-hook.test.ts`：独立 Node、真实临时文件、隐私/坏输入/中立输出 | 6 失败 / 3 通过 | 9 通过 |
| 02–05 | `test/codex-approval.test.ts`：真实 JSONL + TaskStore；并行、清理、超时/半行/缺失、配置 | 主切片 11 失败 / 1 通过；边界 3 失败 / 12 通过 | 15 通过 |
| 06 | 本机配置 diff、运行 snapshot；用户 trust 后真实审批 | 不适用：部署验收 | 安装/重启/DOM 通过；用户确认信任后真实黄→蓝 PASS |

## 6. 证据与执行记录

- 实现前只读调查：当前聊天 6 个 task_started、4 个 task_complete、1 个 turn_aborted 等，0 审批 event_msg；不输出正文。数据库无可用待批状态，桌面日志记录 Sending server response，不提供审批开始。
- 用户已明确选择 Hook 粗粒度恢复语义，关键产品范围已确认。不得把它描述成批准后立刻恢复。
- 官方说明要求非 managed Hook 经用户审核信任；本机暂无 hooks.json。安装之外的信任步骤不自动执行。
- 命令、退出码、Red/Green 与本机结果执行后补记。原有代码/配置继续保留。

### 2026-10-20 切片记录（工作目录为仓库根）

- 基线 `13c6a98` + SPEC-011 测试/规格未提交。发布器先提供仅消费 stdin、返回 `{}` 的中立壳；未实现事件写入。`npm test -- test/codex-status-hook.test.ts --maxWorkers=2 --minWorkers=1`，退出 1，6 个目标断言失败（没有脱敏事件/匹配摘要/清理事件），3 个中立输出用例通过，非缺文件/编译错误。日志 `logs/spec011-hook-red.log`。
- 实现发布器后同一命令连同 `test/codex-monitor.test.ts`，沙箱 EPERM 阻止 Windows 临时文件替换；该环境失败不计为行为 Red。在 Windows 沙箱外重跑，退出 0，9 + 26 = 35 通过，`logs/spec011-hook-green-windows.log`。
- 共享 JSONL 读取器从原实现机械提取，外部行为不变，Red 不适用；原 26 个 Codex 用例先通过再提取后复验，退出 0，`logs/spec011-reader-refactor.log`。
- `npm test -- test/codex-approval.test.ts --maxWorkers=2 --minWorkers=1`，原监控忽略新字段，退出 1，11 失败/1 通过（实际蓝而非黄、字段丢弃等），`logs/spec011-monitor-red.log`；接入后 12 通过，连同旧配置 3 个共 15 通过，`logs/spec011-monitor-green.log`。
- 增加晚到旧请求、无关会话不能恢复丢失证据、单回合工具上界，原第一版退出 1，3 失败/12 通过，`logs/spec011-boundary-red.log`；修复水位和有界状态后，审批 15 + 发布器 9 = 24 通过，退出 0，`logs/spec011-boundary-green.log`。
- `npm run typecheck` 退出 0（含主进程、Electron、测试三个 strict TS 项目），`logs/spec011-typecheck.log`。全量和真机结论随后追加，切片结果不替代实际审批信任验收。

### 全量与本机部署

- `npm test -- --maxWorkers=2 --minWorkers=1`，Windows 沙箱外退出 0，40 文件 746 项全部通过，无跳过；包括真实 PowerShell 解析、SQLite、HTTP 回环。`logs/spec011-full-test.log`。
- `npm run build` 退出 0，`logs/spec011-build.log`；随后 `npm run smoke` 沙箱外退出 0，原 22 项闭环通过，`logs/spec011-smoke.log`。
- 已生成后安装本机 `C:/Users/chen/.codex/hooks.json`，原文件不存在；合并器已检查预览哈希/源文件哈希，避免覆盖生成预览之后的编辑。本地 YAML 保留其余值及注释，仅新增 Codex `approvalEventsFile: C:/Users/chen/PRJ/ai-signal/logs/codex-hook-events.jsonl`；备份为 `config.local.yaml.bak-spec011-2026-10-19T16-37-41-893Z`（UTC 文件名，北京时间 10 月 20 日）。安装记录 `logs/codex-hooks-install.json`。没有更改 trust、数据库、认证或 rollout。
- 旧主 PID 13068 和三子进程经指示灯自身 quit API 正常退出、确认消失，再以原 `npm start -- --config ./config.local.yaml` 和仅回环诊断参数隐藏启动新版；主 PID 29928，窗口句柄 393976。进程、真实 snapshot 和 DOM 检查退出 0，`logs/spec011-live-lamp.log`；右侧布局、透明度 0.92、三行仍可见，初次检查灰色空闲且明确 Hook 尚未连接。GPU 回退日志未影响窗口/渲染。
- 部署时安装不等于信任。该时点未注入模拟审批，真实审批黄灯、工具返回恢复仍须用户信任后验收，因此当时保持 verifying（下方后续记录替代这一待验收状态）。当前工具集无可用桌面操作能力，托盘目视/真实点击仍沿用 SPEC-002 未验收边界。文件面板打开请求返回 queued，不能据此声称用户已经看到或信任。
- 00:39:55 再次只读 snapshot：当前 Codex 已为 `running`，仍明确“授权 Hook 尚未连接”；dsh / WorkBuddy 为 idle，界面 visible，布局 right。没有把初次恢复的 idle 写为当前一直空闲，也没有假称 Hook 已执行。
- `git diff --check` 通过。没有提交/推送，本轮源码、测试和文档留在工作区；本机配置/备份/日志均被忽略。详见[安装和信任指南](../development/codex-approval-hooks.md)。

### 用户完成信任后的真实审批闭环（2026-10-20 北京时间）

- 用户回复“完成了”，表示已完成前述 Hook 信任。只读核对发现本聊天的真实 UserPromptSubmit / PostToolUse 已进入事件文件，界面 Codex 为 running，未连接诊断已消失；无需再次安装或重启。
- 为验证实际审批，启动一个最多五分钟的只读观察器，随后执行需要桌面回环访问权限的真实诊断。没有直接调用发布器制造事件，没有写 rollout/数据库，也没有替用户批准操作。
- `logs/spec011-real-approval.jsonl`：00:42:45.932 真实 PermissionRequest，00:42:47.612 snapshot/DOM 同为 waiting、行可见、黄色 `rgb(245, 158, 11)`；00:43:04.679 同 session/turn/toolKey 的真实 PostToolUse，00:43:05.899 snapshot/DOM 同为 running、行可见、蓝色 `rgb(59, 130, 246)`，观察器记录 PASS 并自动退出。中间蓝色过渡值未提前算作稳定蓝。
- 真实黄灯期间，`node logs/check-real-approval.mjs` 返回 realYellowObserved:true、退出 0；事件日志均由已信任 Hook 自动产生。只读检查未改变产品代码，因此本次无新增行为测试/构建要求，沿用本规格上一轮 746 项及构建/smoke 的代码版本证据。
- 本规格的请求黄灯、匹配工具返回蓝灯目标已闭环，标 done；不扩大为同输入并发精确匹配、点击批准瞬间变蓝，或三工具托盘/点击完整矩阵已通过。SPEC-002 继续 verifying。仍不自动提交或推送。

## 7. 交付

- [x] 自动测试、类型检查、构建与 smoke。
- [x] 安装配置保留/备份、无敏感字段输出。
- [x] 用户 trust 后真实审批黄灯/工具返回恢复蓝灯，日志 PASS。
- [x] 文档/索引/限制与恢复步骤。
