# SPEC-012：轻量桌面 UI 与面板操作

> 状态：done
> 日期：2026-10-20
> 基线：13c6a98 + 已验收但未提交的 SPEC-011 工作区；保留全部改动。
> 来源：用户认为 UI 粗糙，明确选择同时优化悬浮灯和面板、精致轻量风格、贴边图标＋状态点、统一简约图标、同时整理交互，并要求继续。

## 目标与设计

悬浮灯采用柔和圆角、细边框、克制阴影的半透明底板；系统深浅色自适应。贴边时使用 32 DIP 图标点击区＋独立状态点：Codex 为代码符号、dsh 为波纹、WorkBuddy 为对话气泡，其他工具为通用网格。非贴边仍显示短名称。图标使用本地静态 SVG，零远程资源、零新依赖，不增加悬停文字。

面板统一为清晰的标题/监控状态、四项摘要、任务卡片、底部提示。默认宽 420 DIP、高不超过 520 DIP/工作区 70%，小屏限制在工作区内。任务名 14px、辅助信息至少 11px、控件至少 32px；任务卡片保留名称、状态文字、耗时、描述和进度。主要按钮“切回工具”常显；日志/目录/重试/已读折入原生 details 的“更多”，按配置能力和状态显示；Esc 优先收起菜单，再收起面板。键盘可用，状态不只靠颜色表达，减少动态效果时禁用动画。

顶部暂停按钮真正调用现有主进程暂停链路（沿用 30 分钟自动恢复），等待中禁用重复操作，失败明确反馈。托盘与面板共用状态，不由渲染层改业务状态。保留原悬浮灯完成确认/点击跳转、禁用/未知/失败可见性、Codex Hook 和完成留绿语义。

## 接口与兼容

- TaskState 增加可选 toolKind、availableActions 显示元数据，由主进程从现有任务配置推导并在热重载同步；旧快照有通用图标/动作兜底。不新增用户必须填写的配置。
- RendererApi 增加 setMonitoringPaused(boolean)，新受限 IPC 校验布尔参数、返回 ok/message；共享现有暂停流程，失败不提前显示成功。
- classic script 保持零 import；本地 UI 图标辅助脚本在 overlay/panel 前加载。停靠画布尺寸同步图标大小，长列表滚动，顶部受可用宽度限制。
- 本轮不新增任务管理/设置系统、监控来源或依赖，不改变原配置与 Hook 信任；不自动提交/推送。

## Given/When/Then 验收

| ID | Given / When | Then / 验证 |
| --- | --- | --- |
| AC-01 | 三工具/未知工具配置与热重载 | 图标正确、日志目录只在有能力时出现，原状态/未读/完成水位保留；TaskStore 单测 |
| AC-02 | 点击暂停/恢复，失败或重复点击 | 真正调用主进程；快照驱动状态；等待禁用；非法 IPC 拒绝；IPC/renderer 测试及本机实际暂停恢复 |
| AC-03 | 面板主操作/更多、键盘 Esc、错误返回 | 操作准确、不冒泡误跳转；菜单先收起，失败反馈；renderer 行为测试 |
| AC-04 | 0/1/3/20 任务、单灯/游离/三边停靠、长标签 | 单一形态、图标/状态点/阴影不裁切、长列表可滚动；几何单测和真实渲染尺寸 |
| AC-05 | 深浅色、七态、暂停/空态/长文本 | 层次清晰、文字可读、状态色稳定、减少动态效果可用；截图/真实 DOM 验收 |
| AC-06 | 旧实例在运行、已有本地配置 | 验证后正常重启，仅一份实例，保留位置/配置；全量类型检查→测试→构建→smoke；不以模拟点击冒充 Windows OS 点击 |

## specTDD 与验证记录

按元数据/IPC、面板行为、几何依次 Red→Green，记录命令/退出码/工作区阶段。纯 CSS 视觉调整记录 TDD 不适用，以实际截图、尺寸和交互验证。旧布局测试中锁定 93px 高度、纯圆点尺寸、停靠不滚动的断言已被本规格明确替代，更新为图标命中区与画布包含性，保留所有防裁切/跨屏/状态行为保护。

### Red → Green（2026-10-20）

基线为 13c6a98 加 SPEC-011 未提交改动；未回退或覆盖这些改动。

| 切片 | 测试 / 命令（均带 `--maxWorkers=2 --minWorkers=1`） | 实际 Red（exit 1） | Green |
| --- | --- | --- | --- |
| 元数据/IPC | `npm test -- test/ui-metadata.test.ts test/ui-pause-ipc.test.ts` | 09:08，4 用例：缺 toolKind/availableActions、缺暂停 handler；`logs/spec012-meta-red.log` | 元数据/IPC/既有 store-strip 19 项通过，`logs/spec012-meta-green.log` |
| 面板/几何 | `npm test -- test/ui-panel.test.ts test/ui-geometry.test.ts` | 09:10，3 用例：暂停未调用 IPC、旧主按钮文案、98px 放不下四个 32 DIP 目标；`logs/spec012-ui-red.log` | 连同既有浮窗/布局 52 项通过，`logs/spec012-ui-green.log` |
| 窗口边界 | `npm test -- test/ui-panel-window.test.ts` | 09:11，旧宽度 380 不满足 420，`logs/spec012-window-red.log` | 正常/小屏负坐标工作区通过 |
| 暂停反馈 | `npm test -- test/ui-panel.test.ts` | 19:53，全局暂停后卡片仍为空闲，`logs/spec012-pause-red.log` | 3 项通过，`logs/spec012-pause-green.log`；暂停快照锁定重试并标注保留状态 |

纯 CSS 皮肤、静态 SVG 和排版不以文本镜像测试冒充 TDD；通过实际 Electron 截图检查。未新增依赖、框架、远程图标资源或用户配置项。

### 验收范围

- `TaskStore` 推导图标/动作能力，配置热重载同步显示元数据并保留状态/完成水位。面板原生 details 菜单，主要动作常显，异常 IPC 有反馈；所有动态工具名称/消息仍以 textContent 写入。
- 新增 `npm run check:ui`，在独立隐藏 Electron 夹具窗口加载构建后的真实 HTML/CSS/JS；不读取用户配置、启动监控或写入工具数据。22 个场景覆盖 0/1/3/20 任务、游离/左/右/上停靠、深浅色、七态、暂停、空态、长文本、32 DIP 目标、末行滚动可达、状态点包含性，结果在 `logs/spec012-ui/results.json`，截图同目录。此类夹具不等同实际工具状态或 OS 鼠标命中。
- Windows 原生 computer-use 实际操作：点击总灯打开面板；点击暂停后显示恢复监控，再点击恢复；展开更多，再按 Esc 菜单收起且面板保留；点击 dsh“切回工具”后 DeepSeek Harness 文档取得焦点。当前 WorkBuddy 未运行，面板如实显示失联。
- 本次会话分时继续，晚间旧指示灯/dsh 已退出；核对无实例后重新启动本机已有 dsh，再启动指示灯。最初全量 753/754：唯一失败为真实 dsh 发现前提未满足，没有删断言或把失败当基线。dsh 实际启动后全量通过。
- 多屏/DPI、原生拖拽三个边缘、托盘目视和 Codex/WorkBuddy 实际窗口切换尚未全部执行，因此保持 verifying；不扩大 SPEC-002 的历史验收结论。

### 最终交付记录

2026-10-20，Windows 10.0.26200、Electron 33.4.11、系统 Node 24.16.0，工作区仍为 13c6a98＋SPEC-011/012 未提交改动：

| 检查 | 退出码 / 结果 | 证据 |
| --- | --- | --- |
| `npm run typecheck` | 0 | `logs/spec012-typecheck.log` |
| `npm test -- --maxWorkers=2 --minWorkers=1` | 0，45 文件 / 755 项 | `logs/spec012-full-test.log`（19:54:03） |
| `npm run build` | 0 | `logs/spec012-build.log` |
| `npm run smoke` | 0，全部通过 | `logs/spec012-smoke.log` |
| `npm run check:ui` | 0，22 场景通过 | `logs/spec012-render.log`、`logs/spec012-ui/results.json` |
| `git diff --check` | 0 | 本机执行，无差异空白错误 |
| 最终实例 | 19:57 正常重启，19:59 快照 visible / right / paused=false；真实图标为 32×32、no-drag | `logs/spec012-runtime.log`、`logs/spec012-final-runtime.json` |
| 配置 / Hook | 只读复核通过；原监控/跳转/通知等配置和六项中立 Hook 保留 | `logs/spec012-config-check.json` |

右贴边图标画布由 36 加宽至 52 DIP，原生定位写回仅将 x=1884 调整为 1868，y=167 保留，同一右边界。原 SPEC-011 配置校验脚本因锁定旧 x 数值退出 1；没有宣称原坐标完全不变，单独核对其他字段严格一致。未写工具数据库、认证文件或重新安装 Hook。

最终截图脚本曾在隐藏面板的 CDP 查询超时（exit 1），该次不记面板验收通过；悬浮灯只读快照检查重跑 exit 0，可见面板交互以原生 computer-use 记录为准。渲染夹具 runner 初版逐窗销毁时触发默认退出，修正测试进程生命周期后完整 22 场景通过；没有把空结果或提前退出当通过。

应用使用 `npm start -- --config ./config.local.yaml`（额外仅绑定本机的调试端口）保持运行。配置仍为 dsh authority:auto、真实 WorkBuddy 数据库路径、Codex sessionsDir/ChatGPT.exe 和既有 approvalEventsFile；未自动提交或推送。

20:01 最终实例原生点击再次打开面板，并确认暂停后各卡片显示“监控已暂停”。一次旧窗口绑定失效，经重新枚举并获取实际句柄后重试成功，没有使用失效坐标继续操作。恢复监控后保持运行；Obsidian 仅追加本项目已确认偏好与有边界的验收进展。

### 用户确认图标（2026-10-20）

用户将 WorkBuddy 指定为小猫、GPT 指定为小机器人，补充 dsh Web 形式，并回复“没问题”确认四款画稿。此轮替换本规格最初的代码符号/波纹/对话气泡图形：现有 dsh 映射鲸鱼、WorkBuddy 映射小猫、Codex（当前 ChatGPT 主窗口）映射机器人；另保留浏览器＋鲸鱼的 dsh Web 图形素材。不从运行消息猜 Web/桌面类型，不改变现有 monitor/toolKind/IPC 或进程跳转规则。

本切片仅替换静态 SVG 路径，视为纯视觉素材调整；TDD 不适用，不补造 Red。类型检查 exit 0（`logs/icons-typecheck.log`）、全量 45 文件 / 755 项 exit 0（`logs/icons-full-test.log`，20:09:57）、构建 exit 0（`logs/icons-build.log`），构建后 smoke exit 0（`logs/icons-smoke.log`）、22 场景 Electron 渲染 exit 0（`logs/icons-render.log`）。已查看深浅色实际渲染，新路径用 currentColor 跟随主题。

正常退出旧实例并确认调试端口关闭后，使用原 config.local.yaml 重新启动唯一实例（`logs/icons-runtime.log`），保留监控/配置/Hook。运行快照与悬浮灯截图记录为 `logs/icons-final-runtime.json`、`logs/icons-live-overlay.png`。原 DPI/托盘/多屏待验收项继续保留，未提交或推送。

### 2026-10-21 15:38–15:44 真机 GUI 复验（完全权限）

- 环境：最终构建（SPEC-020 修复后），指示灯主进程 7956；Windows 10.0.26200、Electron 33.4.11。
- 真实点击悬浮灯总灯（坐标 3820,137）→ 应用日志 `任务列表面板已创建（420x520）`；面板窗口标题 `AI 任务指示灯 — 任务列表`，截图 `logs/spec012-live-panel.png` 显示 dsh（本地客户端）、dsh（web 13080）及各自图标/状态/「切回工具」。
- 真实点击面板 dsh「切回工具」→ 日志 `聚焦请求：任务 dsh-local`、`已通过 Win32 激活窗口「… — DeepSeek Harness」`；只读前台探针 `Foreground=460928 (DeepSeek Harness)`，面板按设计在失焦后自动收起。
- 面板「暂停 30 分钟」→ 日志 `监控已暂停（30 分钟）`；再次点击「恢复监控」→ 日志 `监控已恢复`；悬浮灯尺寸随任务可见数在 52×168/52×131 间调整，未残留暂停状态。
- 工具：真实鼠标点击用 `logs/click.ps1`，按钮操作用 `logs/postclick.ps1`（向窗口投递 WM_LBUTTONDOWN/UP，不依赖桌面焦点）；窗口枚举/截图见 `logs/enum-electron-windows.ps1`、`logs/capture-rect.ps1`。
- 仍保持 verifying：多屏/DPI、原生拖拽三个边缘、托盘目视、Codex/WorkBuddy 实际窗口切换矩阵未在本轮覆盖。

### 2026-10-21 16:15 用户真机确认（收口）

- 用户把悬浮灯拖到屏幕左/上/右边缘并观察停靠、悬浮灯/面板表现（含多屏/DPI）：回复“都正常”。
- 结合 15:38–15:44 的真实点击面板、dsh「切回工具」、暂停/恢复，以及 15:18 `check:ui` 24 个渲染场景、几何单测与全量 852 项，AC-01～AC-06 均满足。
- 本规格状态改为 `done`。托盘/通知/toast 的确认记在 [SPEC-002](002-three-tool-reliability.md) 的真机记录中；Codex 实际窗口矩阵仍归 SPEC-002，不并入本规格。
