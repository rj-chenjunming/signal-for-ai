# Windows 本机运行与验证记录（2026-10-19）

本记录区分自动检查、真实数据集成、实际运行与尚未完成的桌面交互；不宣称三工具整体验收通过。来源为本次用户授权操作和保存在忽略的 `logs/` 下的输出。

## 环境与 Git

- Windows 11 专业版，10.0.26200；系统 Node 24.16.0、npm 11.13.0、Electron 33.4.11、TypeScript 5.9.3、Vitest 2.1.9。
- 用户所指目录起初为空，没有 `.git`、源码或本机配置。用户提供 `https://github.com/rj-chenjunming/signal-for-ai.git` 后克隆到当前目录。
- 克隆后的 `main`、`origin/main` 同为 `dbca9cf81d4b346f2847c2001a1780acbf15a8fc`，0 ahead/0 behind，初始工作区干净；没有覆盖本地修改、stash、reset、提交或推送。
- 本轮仅修复启动器参数转发，按 [SPEC-009](../specs/009-start-cli-arguments.md) 执行 Red/Green。其余应用行为保持原实现。

## 安装及配置

- `npm install --package-lock=false --no-audit --no-fund` 沙箱外成功安装 448 个依赖；未生成 lockfile。沙箱内安装无进展后中止并保留诊断。
- 首次启动报 Electron 安装不完整；`dist/` 只有许可证文件，未出现可执行文件或 `path.txt`。重跑安装器缓存命中后仍未补齐，根因未进一步确认，没有把成功退出码当成可运行证据。
- 使用缓存的官方 `electron-v33.4.11-win32-x64.zip`，先比对 npm Electron 包附带的 SHA-256：`f64c8a5a81d9b420b636fdba13e180f49d69f2198e1d86a8b01f858b17a9483c`，一致后用 PowerShell `Expand-Archive` 补齐依赖目录，写入 `path.txt`。`require('electron')` 返回实际 exe，文件版本 33.4.11、188784128 字节。没有关闭校验、复制其他平台依赖或改系统设置。
- 原先没有 `config.local.yaml`，从桌面模板复制后只填实际值；文件被 Git 忽略。
- dsh：`authority: auto`，主窗口 `DeepSeek Harness.exe`。本次自动发现并以现有本地凭据链认证 `127.0.0.1:63282`，4 会话；没有输出凭据。
- WorkBuddy：真实用户目录 `.workbuddy/workbuddy.db`；进程 `WorkBuddy.exe`。脚本使用 `DatabaseSync(..., { readOnly: true })`，只读表结构和聚合；没有执行写 SQL、修改认证文件或复制快照作为监控源。
- Codex：真实用户目录 `.codex/sessions`，未采用过时示例进程名。本次承载 Codex 界面的主窗口属于 `ChatGPT.exe`，标题 `ChatGPT`；配置同时指定进程名和 `titleContains: ChatGPT`。后台 `codex.exe` 是执行服务，没有主窗口，不能拿它充当界面目标。
- 未开启自动登录启动；dsh 的等待启发式保持关闭。

## 命令及结果

工作目录为仓库根，每项保留底层退出码。

| 命令 | 退出码 | 结果/证据 |
| --- | --- | --- |
| `npm run typecheck` | 0 | main/renderer/test；`logs/typecheck.log` |
| `npm test -- --maxWorkers=2 --minWorkers=1`（沙箱内） | 1 | 657 通过、52 失败；网络 EACCES/Windows PowerShell 限制，`logs/test.log` |
| 同一全量命令（沙箱外） | 0 | 38 文件、709 用例通过，0 失败、0 跳过；真实 PowerShell 用例执行，`logs/test-windows.log` |
| `npm run build` | 0 | 三步构建成功；`logs/build.log` |
| `npm run smoke`（沙箱内） | 1 | 本机 HTTP EACCES；`logs/smoke.log` |
| `npm run smoke`（沙箱外，构建后） | 0 | 22 项通过；`logs/smoke-windows.log` |
| `node scripts/sqlite-monitor-check.mjs <实际数据库路径>`（沙箱内/外） | 1 / 0 | 沙箱内无法读实时库；外部只读检查 16 项通过，读取 16 个未软删会话、当前 0 working；`logs/workbuddy-check-windows.log` |
| `node scripts/inspect-live-lamp.mjs`（沙箱外） | 0 | 真实渲染进程 DOM/颜色/显示规则一致；`logs/live-lamp.log` |
| 本机状态诊断 `node logs/inspect-runtime.mjs`（沙箱外） | 0 | 调用已运行界面的只读 snapshot API；`logs/runtime-state.json` |

WorkBuddy 诊断中的“完成水位”分支是将真库聚合值喂给纯函数，并非点击真机测试；该脚本未传入启动时间基线，其示例 success 不能当成运行界面误报旧完成的证据。实际运行界面此时为 idle。

## 启动及实际观测

启动前查询本仓库 Electron 安装路径对应的进程，确认没有现有实例；两次启动分别是缺运行时失败和补齐后成功，没有并行启动重复实例。

实际命令：

```powershell
npm start -- --config ./config.local.yaml --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
```

通过隐藏的启动器后台常驻，stdout/stderr 分别在 `logs/startup.stdout.log`、`logs/startup.stderr.log`。诊断参数用于仓库已有只读 DOM 检查；`Get-NetTCPConnection` 确认端口实际仅绑定 `127.0.0.1:9222`。浏览器扩展桥接为应用既有行为，本次没有安装扩展。

- 23:19（北京时间）主进程 PID 5216，真实主窗口句柄 328056，标题“AI 任务指示灯”；另有三个 Electron 子进程，是同一实例。
- 应用日志确认 `--config 指定（3 个任务）`、托盘创建、悬浮窗创建和启动完成。日志位置在用户 Roaming 数据目录 `ai-task-indicator/logs/`。
- 实时渲染 `document.visibilityState=visible`；右侧停靠，灯带可见，当前两条行：dsh idle、WorkBuddy idle；颜色均与状态一致。
- dsh 本机自动发现和认证真实成功（不是 fixture）；WorkBuddy 使用真库和真实进程闸门。
- Codex 监控启动且目录可读，但 snapshot 为 `unknown`，消息“Codex 无可靠本地事件或活动已陈旧”，按已有规则隐藏此行。当前会话文件约 1.38 MB；只读诊断末尾 512 KiB 发现新鲜 token_count 和 item_completed，但没有开始事件。现有采集器从尾部重建状态，缺开始事件时不能凭 token_count 推断 running。这符合指南已披露的采集边界，没有伪造蓝/绿状态或放宽状态机。
- Chromium stderr 有 GLES context 警告；进程与渲染仍正常，未把警告直接当成启动失败，也不将其描述成完全没有错误输出。

## 未完成的桌面验收与下一步

Computer Use 技能已完整初始化并按恢复规则重试/重建 JS 会话，均返回：`Computer Use native pipe is unavailable ... 系统找不到指定的文件 (os error 2)`。未用模拟鼠标结果代替真机验收。

- 未目视核对 Windows 通知区域中的托盘图标；当前证据仅为真实应用创建日志。
- 未通过桌面截图确认悬浮窗的合成外观；当前证据为主窗口句柄、实时 DOM 可见性和计算样式。
- 未实际点击三个工具的灯/面板切换，未测试最小化恢复、重启目标窗口、拒绝前台激活等路径；窗口枚举已匹配三工具候选，不等于点击通过。
- 尚需用户启动一个新的短 Codex 回合，检查尾部包含开始/完成事件时蓝→绿及点击确认；长会话尾部丢开始事件仍是已知限制，未在本启动任务顺带更改采集策略。
- dsh/WorkBuddy 的真实任务运行→完成→点击确认、失败/取消、并发、暂停恢复等完整矩阵未执行。

指示灯保持运行；本机配置、依赖、构建产物和日志均不入 Git。SPEC-002 及相关监控规格保持 verifying；SPEC-009 仅启动参数范围可标 done。任何后续采集策略修复应另走 specTDD。

## 23:40 后补验：SPEC-010 Codex 完成灯与长回合修复

用户进一步反馈“只有运行的时候有，一旦结束就消失了”。按 [SPEC-010](../specs/010-codex-completion-continuity.md) 补充测试先行修复，替代上文把尾部丢开始事件作为未修复限制的当前状态，早先记录保留为历史证据。

- 原因：历史 unknown/陈旧 running 覆盖新完成；末尾快照丢失长回合开始。现改为有界分块增量读取并缓存结构化生命周期；历史噪声不抹去新完成，已观测活跃而后失联仍受保护。
- 修复后目标：蓝→明确完成绿→确认/默认十分钟到期后灰，Codex 行在健康空闲时保留；多回合仍运行优先。配置、TaskStore、共享可见性规则和其他工具未修改。
- 本轮先后保存有效聚合/长文件/追平/mtime Red 与 Green，13 个新增回归；`typecheck`、38 文件 722 项测试（0 跳过）、构建、22 项 smoke 均退出 0。详细命令与日志见 SPEC-010。
- 通过应用自身退出 API 正常关闭旧 PID 5216 及三个子进程，确认退出后再启动新版。备份为 `config.local.yaml.bak-before-spec010`，配置 SHA-256 前后一致；未覆盖用户移动灯位置等设置。新版主进程 PID 13068，窗口句柄 3541572。
- 真实 snapshot 已观察到当前 Codex 回合 `running`；真实 DOM 有三行，Codex 为蓝色 `rgb(59, 130, 246)`，界面可见。`logs/spec010-live-lamp.log` 检查退出 0；dsh、WorkBuddy 仍正常空闲。
- 当前回复尚未结束，不能宣称本轮自然完成绿灯已实测。已留一个最多五分钟、自动退出的只读观察器，结果写 `logs/spec010-natural-completion.jsonl`，PASS 必须包含自然 running→success 与绿色行连续两轮保留；若超时则 NOT_VERIFIED，不注入事件。该观察器不会发消息、点击或改工具数据。
- 真机点击/托盘目视仍沿用前述未验收状态；SPEC-010 保持 verifying，不用单测通过冒充完整交互通过。应用保持运行，没有提交或推送。

## 后续闭环：自然完成保留通过、用户确认并授权提交

上述“自然完成待验证、SPEC-010 verifying”现由以下实测替代，前文保留为按时序记录的历史状态：

- `logs/spec010-natural-completion.jsonl`：23:41:45.839 观测蓝色 running；23:43:20.477 观测自然 success、未读、行可见、绿色 `rgb(34, 197, 94)`；23:43:22.491 同一完成跨两次检查仍为绿色，结果 PASS。没有模拟/注入事件或点击操作，观察器自动退出。
- 用户随后明确“看着没问题了”，确认当前效果并要求提交 Git。SPEC-010 状态显示修复及其验收闭环，标记 done；SPEC-002 的完整点击/托盘矩阵仍为 verifying，不扩大验收范围。
- 按本次明确授权，将 SPEC-009/010 修复、测试和验证文档创建本地提交；配置及备份、依赖、构建和日志继续忽略，未授权自动推送。提交引用见 Git 历史，指示灯保持运行。
