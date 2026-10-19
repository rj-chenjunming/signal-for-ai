# 三工具桌面配置与验收（SPEC-002）

2026-10-19 已补充一次[Windows 本机执行记录](windows-local-validation-2026-10-19.md)，涵盖实际配置、检查和启动；交互验收尚未完成，下方待验收项不能据此整体改为通过。

目标是让灯表达任务事实，并点击切回对应已打开的工具。2026-10-19 已在 Windows 验证真实 dsh/WorkBuddy 数据读取和 Codex 运行行；完整任务/点击矩阵仍待验收，详见本机记录和 [SPEC-010](../specs/010-codex-completion-continuity.md)。本页不是三工具已全部通过的报告。

## 安装与配置

在 Windows 的仓库目录使用系统 Node 24，安装本平台的 Electron 依赖；不要复制云端 node_modules。

```powershell
npm install --package-lock=false
if (!(Test-Path config.local.yaml)) { Copy-Item config.desktop.example.yaml config.local.yaml }
npm run build
```

编辑忽略的 `config.local.yaml`：已有文件保留并合并三个任务，不覆盖个人配置。模板见 [config.desktop.example.yaml](../../config.desktop.example.yaml)。

| 工具 | 需要核对 | 状态来源及限制 |
| --- | --- | --- |
| dsh | 本地 authority，默认 `127.0.0.1:19387`；主窗口进程名 | 既有 dsh API + 本地凭据链。模板不配置 SSH，不开启 `plan.pending` 近似等待；精确等待仍依赖现有插件信号接入，API 缺信息时不保证黄灯 |
| WorkBuddy | 真实 `workbuddy.db` 路径、`WorkBuddy.exe` 进程名 | 只读 `sessions` 表，`working` 且活动新鲜才蓝；`completed` 才完成；失败/等待值可配置。若本机版本改列名/状态值，需先核对，不放宽成“任意非 working 都成功” |
| Codex 桌面 | 本地 sessions 目录、带主窗口的进程名 | 缺省主目录 `.codex/sessions`；若用了自定义 `CODEX_HOME`，显式设置 `sessionsDir` 为其 sessions 子目录。只解析 rollout JSONL 结构化事件 |

`windowProcess.processNames` 是实际主窗口进程名，大小写和 `.exe` 后缀不敏感；`titleContains` 可选，用于多个窗口中进一步缩小范围。模板值是候选，须用下方进程查询核对。它保证切到匹配应用窗口，不保证定位应用内某个线程。模板省略 `cwd`/`openUrl`，因此找不到应用时会给出失败反馈，不以打开目录冒充切换成功。

```powershell
# 只查看顶层窗口对应的进程，不修改三个应用
Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object Id, ProcessName, MainWindowTitle
# 检查 dsh 端口是否监听（不等于已通过鉴权/API 验收）
Get-NetTCPConnection -State Listen -LocalPort 19387
# 只列文件元信息，不打印会话正文或 auth 文件
Get-ChildItem "$env:USERPROFILE/.codex/sessions" -Recurse -File -Filter *.jsonl | Sort-Object LastWriteTime -Descending | Select-Object -First 3 Name, LastWriteTime, Length
# 改成真实数据库路径；脚本执行只读 SQL 并打印汇总计数
node scripts/sqlite-monitor-check.mjs 'D:/your-appdata/.workbuddy/workbuddy.db'
# 用启动器清理 ELECTRON_RUN_AS_NODE 等影响 Electron 的变量
npm start -- --config ./config.local.yaml
```

不要把真实 token、完整会话文件或凭据贴入聊天/提交。诊断数据库脚本使用默认状态名；如本地配置定制了状态名，需以应用实际结果核对。三个工具的数据仍留在本地。

## 状态语义

- 蓝：观测到执行；黄：数据源明确给出等待信号；绿：明确完成且尚未确认。点击完成灯仍沿用现有行为，同时发起切换和确认完成；即使切换失败，确认动作仍生效，可从面板重试切换。
- 灰：可信来源没有执行中任务。`unknown` 与 `failed` 沿用已有浮窗隐藏规则，面板保留诊断，失败可通知，总灯仍计入异常；不要把消失当成任务完成。
- 同态轮询会续心跳；新一轮开始可覆盖上一轮绿灯；连续完成确认最新水位，确认后不会被同一完成重新点亮。
- WorkBuddy 缺库/进程枚举错误按失败阈值降为 unknown；失败期间不产生新完成证据。数据库表与毫秒时间戳必须符合本机版本。启动时可能提醒数据库尚未确认的历史完成，这是既有行为；确认水位当前不跨应用重启持久化。
- Codex 启动前的历史完成不会刷提醒。`task_started/turn_started` → 蓝，`task_complete/turn_complete` → 绿，终止错误 → failed，中止 → idle；多会话中正在运行优先。普通文字与工具级错误不用于猜任务完成。
- SPEC-010：历史 unknown/启动前陈旧回合不再抹掉本轮明确完成；实际观测为活跃而后失联的回合仍保护为 unknown。完成后保留绿灯至点击确认或默认十分钟自动确认，随后保持灰色空闲行；新回合重新蓝灯。只看到完成而缺少真实开始证据不会洗绿。
- Codex 审批等待不保证落到 rollout，不能承诺精确黄灯；没有新鲜结构化活动超过 `activeWithinMs`（默认 5 分钟）会转 unknown。没有看到开始、失联后只看到完成，也不能绕过状态机凭空亮绿。
- Codex 取最近修改的 32 个 `.jsonl`，每文件每轮最多读取 512 KiB（包括最多 256 字节首尾摘要样本），首次从头逐轮追平，再只读新增字节。文件很大时首次恢复状态需要多轮；新增正文跨块时保留上次可靠观测。单行最多缓存 256 KiB，超长正文跳过至换行，随后继续读取生命周期；半行只在补齐后生效。文件删除/替换/截断清理旧证据，停止清理缓存与句柄。每轮仍最多扫描 5000 个目录项/6 层，超限可缩小 `sessionsDir`。
- 不支持 `.jsonl.zst`、归档目录或未落本地的云端会话；最近 32 文件之外的会话不被采集，Windows 的 mtime 更新可能滞后。CLI 与桌面会话目前共同聚合，未识别为仅桌面任务。关闭程序不会即时提供终止事件，运行记录会按新鲜度过期；仅凭 mtime 刷新不会清空已读取的完成状态。同长度重写用文件身份及首尾摘要发现，不保证检测只改中部且首尾完全相同的原地编辑。

公开协议核对来源（2026-10-19 读取，非本机版本承诺）：[Codex protocol](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs)、[rollout persistence policy](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/policy.rs)。升级工具后需要重新核对样本与协议。

## Windows 验收表

先运行 `npm run typecheck`、`npm test`、`npm run build`、`npm run smoke`。Windows 上 PowerShell 真实脚本用例必须执行，不能沿用 Linux 的跳过结论。

| 操作 | 预期 | 实际 |
| --- | --- | --- |
| 三工具均开着，启动指示灯 | 可读来源进入对应状态；缺路径/端口明确 unknown，不假绿 | 待验收 |
| 每工具执行一个短任务；再执行第二个 | 蓝→明确完成绿→新任务蓝；持续运行不因重复状态而失联 | 待验收 |
| 绿灯点击后等待两轮轮询 | 切到对应窗口，完成被确认，同一完成不复亮 | 待验收 |
| 任务明确失败/取消 | 不误报完成；面板/通知呈现来源能证明的状态 | 待验收 |
| Codex 两个并行会话，一个完成一个仍运行 | 保持蓝，全部结束再提醒未确认完成 | 待验收 |
| Codex 重启指示灯 | 不重放旧完成；新回合仍正常提醒 | 待验收 |
| 窗口在后台、最小化；安装了 WT；同名浏览器页面存在 | 点击对应程序，无新 WT 标签、不误切同名浏览器；激活被系统拒绝有失败反馈 | 待验收 |
| 重启一个工具再点击；关闭工具再点击 | 缓存 HWND 失效后重找新窗口；关闭后不抢无关窗口 | 待验收 |
| 暂停/恢复监控，随后退出指示灯 | 无迟到状态复亮；恢复只有一份监控，无残留应用定时器 | 待验收 |
| 工具要求审批/输入 | 对照信号能力核对；无权威事件的 Codex/dsh 不宣称等待精确识别 | 待验收 |

验收时记录 Windows/工具/Node 版本、构建版本、脱敏配置差异、每项实际结果；失败记录对应动作和不含会话正文的诊断。完成后更新 [SPEC-002](../specs/002-three-tool-reliability.md)，才可由 verifying 改为 done。简单 todo 已登记在[后续清单](../specs/README.md)，本轮未实现。
