# SPEC-013：桌面跳转失败与窄灯条反馈

> 状态：done
> 类型：bugfix
> 需求来源：2026-10-20 用户截图：点击 dsh 图标后显示逐字竖排的 cwd/logFile/聚焦失败提示。
> 负责人：Codex
> 基线：13c6a98＋未提交 SPEC-011/012；Windows 10.0.26200，Node 24.16.0，Electron 33.4.11。保留全部本地改动。
> 关联：SPEC-002 的显式窗口跳转；SPEC-012 的失败反馈显示；不修改历史同步副本。

## 1. 问题与目标

20:14:15/21 日志为 dsh 窗口未找到，只有 2 个候选，未进入 Win32 激活；末级通用报错误导用户填写 cwd/logFile。贴边画布只有 52 DIP，toast 左右各 6、内边距各 7，文本宽 26 DIP，长错误逐字堆叠。20:18 原生点击恢复最小化 dsh 成功、枚举到 3 个候选；此前为何短暂缺失尚不能确认，不能宣称查明是改名或最小化导致。

目标：每次显式桌面切换先重新枚举，仅匹配配置进程/标题；无法找到或激活时给出对应工具的可操作说明。完整点击失败反馈转到现有宽任务面板，窄灯条不承载长错误。不自动启动工具、改工具配置或添加假 cwd。

## 2. 范围与非目标

- FocusService 桌面目标刷新、缺失/激活失败说明；保留配置目录/日志降级、URL 链及前台确认。
- 新增受限 UI IPC：showPanelMessage(string)、takePanelMessage()；面板缓存最后一条未消费提示，订阅先于握手，懒加载/重开不丢消息。只传普通文字，长度上限 2000，非法参数返回失败。
- overlay 点击动作失败/IPC 抛错调用面板消息；失败确认与完成已读仍独立。反馈通道异常时仅显示简短单行退化提示，不无限重试。
- 短暂系统 toast 保持单行省略，避免竖排；不新增悬停 tooltip。面板消息用 textContent、长文本换行；不引入新依赖或新增窗口类型。
- 不修改 TaskStore 状态语义、Hook、工具数据库/认证文件、本地配置、图标与进程映射；不把此修复当作支持恢复所有缩到托盘的工具。

## 3. 验收条件

| ID | Given / When | Then |
| --- | --- | --- |
| AC-01 | 原缓存有旧 HWND，点击配置桌面目标 | 先枚举当前目标再激活，目标失踪不抢无关窗口；失败区分未找到/激活未确认；配置目录/日志降级保留 |
| AC-02 | 浮窗点击失败或请求拒绝，终态行 | 完整反馈交给面板，独立 mark_read 仍发送；反馈通道失败不产生未处理异常 |
| AC-03 | 面板首次加载、已打开、重复消息、关闭重建 | 最后一条未消费消息可由握手获取，订阅先建立；已就绪直接推送、关闭清理 readiness；非法 IPC 拒绝 |
| AC-04 | 右侧 52 DIP 灯条收到长消息，深浅色面板显示错误 | 灯条无逐字竖排/尺寸变更；面板完整文字可读、无 HTML 注入；真实渲染和原生点击复核 |

## 4. 测试计划与追踪

按 FocusService、反馈 IPC/面板交接、renderer 行为逐片 Red→Green；新测试及实际 Red/Green 命令与原因待记录。纯 CSS 单行/换行以真实 Electron 几何检查，不伪造 Red。

最终顺序：typecheck → 全量 test → build → smoke，另 check:ui 和 SPEC-013 渲染用例；真实点击 dsh 与必要失败路径验收。不主动关闭用户工具以制造失败；用隔离夹具验证不存在目标，真实状态缺口如实记录。

## 5. 兼容与边界

新 API 缺失/抛错要降级；面板尚未创建的提示保留，重复时仅保留最近一条，不堆积。提示不包含会话正文/凭据。窗口枚举不可用与窗口确实缺失在用户层均提示先打开主界面，日志保留诊断；不将 API 返回码当作已在前台。

## 6. 执行与交付

### 2026-10-21 追加：dsh 隐藏主窗口恢复（ready）

需求来源：用户再次截图确认“最小化之后的 dsh 找不到”。本机只读枚举证实 dsh 主进程仍在，所有 `MainWindowHandle=0`，而 `EnumWindows` 仍找到 HWND 527050：隐藏、非最小化、无 owner、非工具窗口、1296×828、`Chrome_WidgetWin_1`，标题含 DeepSeek Harness。此前“刷新可见窗口后成功”只证明普通窗口路径；不能解决本次后台隐藏状态。此证据替代“具体为何缺失未确认”的当前状态，历史记录保留。

追加范围：仅在显式 `windowProcess` 目标缺失时只读枚举该配置进程的顶层窗口；唯一满足主窗口约束的隐藏 Electron 窗口才交给既有 Win32 恢复和前台 HWND 确认。标题没有显式 `titleContains` 时必须包含进程品牌名；不激活浏览器、工具窗口、空标题、owned 窗口、非法句柄或多个有歧义的候选。保留原配置、URL 路径、目录/日志降级，不启动或结束 dsh，不改变工具数据/认证、不修改系统权限。仅支持上述可辨认的隐藏 Electron 主窗口，不保证所有工具的托盘实现。查询无常驻进程/订阅；异常、超时、进程退出与畸形结果失败关闭，不沿用旧隐藏 HWND。每次重试重新查询。

> **2026-10-21 由 [SPEC-020](020-window-reveal-hidden-minimized.md) 修订**：实际 `config.local.yaml` 的 dsh 任务使用 `windowTitle`＋`processNames`，按本条范围不会查隐藏窗口，导致用户“最小化”（dsh 实际是隐藏）后无法切回。SPEC-020 将隐藏查找触发条件扩展为“`windowTitle` 也声明了 `processNames`”，并把命中的 dsh/WorkBuddy 窗口改走各自单实例恢复；无 `processNames` 的纯标题目标仍不启用隐藏搜索（AC-06 保持）。

| ID | Given / When | Then / 验证计划 |
| --- | --- | --- |
| AC-05 | 配置 dsh 进程仍在，但普通枚举没有主窗口；点击切回 | 查询该进程隐藏主窗口，恢复唯一合格 HWND；只有前台 HWND 确认才成功。`test/focus-hidden-window.test.ts` 有效 Red→Green；真机隐藏后从图标和面板切回 |
| AC-06 | 同名浏览器/辅助窗/owned/无标题/坏 PID/HWND/多候选；或查询超时/异常/畸形 JSON | 不误激活，不自动拉起工具；保留明确错误与已配置降级。隔离测试覆盖；没有配置进程的 windowTitle 不启用隐藏搜索 |
| AC-07 | 真实 Windows / dsh 0.2.1-rc.2 | 新脚本真实执行无 PowerShell 语法错误；反复隐藏/恢复、任务栏最小化恢复、从隐藏状态重启指示灯后点击均验证；停止指示灯无遗留查询进程。未执行项仍记 verifying |

切片顺序：先在现有 FocusService 上添加隐藏窗口回归，实际运行确认失败，再实现只读查询与严格筛选；以真实 PowerShell 执行验证脚本。最终重新 typecheck→全量测试→build→smoke，并用原配置重启验收；沿用临时目录内的同版本 Electron（仓库内运行时提前退出另记，非本规格修改目标）。不把旧 761 测试当作本次结果。

追加执行记录（工作目录 C:\Users\chen\PRJ\ai-signal；HEAD 13c6a98、保留原 55 项暂存修改；此次新改动尚未暂存）：

- AC-05 Red：01:01:56，`npm test -- test/focus-hidden-window.test.ts --maxWorkers=2 --minWorkers=1`，exit 1；21 项中唯一隐藏主窗口恢复用例 `restores the unique hidden dsh main HWND when MainWindowHandle enumeration is empty` 在 `result.ok` 预期 true、实际 false，非编译/依赖错误。实现前 focus.ts SHA-256 可由当时 Git 暂存区版本复核；日志 `logs/spec013-hidden-red.log`。实现只读隐藏查询及唯一性筛选后，同文件＋三份相邻 focus 回归 73/73，exit 0，`logs/spec013-hidden-green.log`。
- AC-06 句柄复用切片 Red：01:03:01，新增两项恢复前 PID 校验及禁止 stale 后 AppActivate 用例，同命令 exit 1，两个断言分别因无 GetWindowThreadProcessId 和错误调用 AppActivate 失败；`logs/spec013-hidden-owner-red.log`。Green：01:03:15，四份 focus 测试 75/75、exit 0，`logs/spec013-hidden-owner-green.log`。恢复前核对 HWND 的 PID，stale 只允许重新发现，不调用旧 PID 激活。
- AC-07 查询真实执行：01:04:21，`npm test -- test/hidden-window-script.test.ts --maxWorkers=2 --minWorkers=1`，两项通过、exit 0；Windows powershell.exe 真实编译 C# 并调用 EnumWindows，非只走进程不存在的早退。附配置名称编码/注入保护断言。`logs/spec013-hidden-powershell.log`。此为平台检查及已有切片保护的补充，不补造独立 Red。
- **更正上一条的平台结论**：01:06 真实 dsh 查询返回空，追查发现 PowerShell 5.1 的 `@(... | ConvertFrom-Json)` 将 JSON 数组嵌套，导致进程名筛选提前退出。01:04 的 exit 0 只证明脚本可退出，未证明 Add-Type/EnumWindows 执行，撤销这部分结论。先强化测试要求尾部 `DISCOVERY_COMPLETED`（早退 exit 不会输出），01:06:38 得到有效 Red：预期 marker、实际 `[]`，exit 1，`logs/spec013-hidden-powershell-red.log`。移除多余外层数组后，01:06:49 两文件 25 项通过、exit 0，marker 确认真实查询完成，`logs/spec013-hidden-powershell-green.log`。不隐藏该新增失败或继承前轮结果。其后补充配置标题/大小写、目录降级与激活未确认断言。
- Refactor：只读脚本构建及结果筛选放到 hidden-window.ts，类型引用不引入运行时 Electron/循环依赖；没有改监控器与状态机。不引入轮询或常驻查询进程。

追加结果与后续更正：01:07 最终 50 文件789项、typecheck/build/smoke 均 exit 0，日志 `logs/spec013-hidden-{typecheck-final,full-final,build-final,smoke-final}.log`。01:09:00 找到真实隐藏 HWND 527050，01:09:01.381 Win32 前台确认成功，原生窗口列表也出现同一 dsh 窗口。用户随后按 Esc 停止桌面操作，因此未完成多轮恢复。用户进一步反馈“好像可以了”，但 dsh 自身 X 无效；本机对比复现直接 Win32 恢复后的关闭异常。由 [SPEC-014](014-dsh-native-window-reveal.md) 接管 dsh 原生恢复策略；不能把 789 项或一次前台确认写成窗口生命周期已完整通过。

### specTDD 记录（2026-10-20，基线工作区如上）

| 切片 | 实际 Red（exit 1） | Green（exit 0） |
| --- | --- | --- |
| 显式目标刷新/错误说明 | `npm test -- test/focus-refresh-feedback.test.ts --maxWorkers=2 --minWorkers=1`，20:25:41 两项断言失败：旧 HWND 100 被使用、缺失目标仍提示 cwd/logFile。`logs/spec013-focus-red.log` | 同文件＋既有 `test/focus.test.ts`，46 项通过，`logs/spec013-focus-green.log` |
| 面板缓存/IPC | `npm test -- test/panel-feedback.test.ts test/feedback-ipc.test.ts --maxWorkers=2 --minWorkers=1`，20:26:15 两项因缺反馈方法/handler 断言失败。`logs/spec013-feedback-red.log` | 连同窗口尺寸回归 3 项通过，`logs/spec013-feedback-green.log` |
| 渲染层交接 | `npm test -- test/overlay-actions.test.ts test/ui-panel.test.ts --maxWorkers=2 --minWorkers=1`，20:27:37 四项断言失败：未转面板、无反馈降级、首次消息未显示；保留独立 mark_read 断言。`logs/spec013-renderer-red.log` | 反馈/面板/IPC 共 11 项通过，`logs/spec013-renderer-green.log` |

不存在目标最多重新枚举两次，不盲抢或自动启动；已有但首次激活失败时继续保留既有 HWND 变更重找及目录/日志降级。没有必要重构监控；只提取 renderer 错误反馈函数。纯 CSS 处理单行省略与面板换行，TDD 不适用，以实际渲染替代验证。未改工具数据/认证、本机配置或监控状态不变量。

### 最终验证

| 检查 | 结果与证据 |
| --- | --- |
| `npm run typecheck` | exit 0，`logs/spec013-typecheck.log` |
| `npm test -- --maxWorkers=2 --minWorkers=1` | exit 0，48 文件 / 761 项，20:32:24，`logs/spec013-full-test.log` |
| `npm run build` | exit 0，`logs/spec013-build.log` |
| `npm run smoke`（构建后） | exit 0，`logs/spec013-smoke.log` |
| `npm run check:ui` | exit 0，24 个真实 Electron 夹具场景；增加深浅色长错误/普通文字注入/边界与所有窄灯条单行高度检查，`logs/spec013-render.log`、`logs/spec013-ui/results.json` |
| `git diff --check` | exit 0 |
| 配置与 Hook | 原值复核通过；未修改监控参数、跳转参数、认证/数据库，`logs/spec012-config-check.json` |

全量首轮 760/761（exit 1）保存为 `logs/spec013-full-first-failure.log`。旧重启夹具将应用重启设在点击前，原断言要求先激活缓存 500 再激活 501；本规格恰好禁止尝试该旧缓存。为继续保护原来“激活失败后重找新窗口”的路径，改为模拟点击前刷新仍读到 500、随后应用重启，下一次枚举才得到 501；原 `[500,501]` 断言不变。另有新测试严格保护点击前旧缓存不被使用，未删除断言或将新增失败归基线。

### Windows 实机与证据边界

- 修复前，20:18 原生点击 dsh 图标后 Win32 前台 HWND 确认成功；此前 20:14 两次失败仅能确认缺少枚举候选，未确认缺失的确切原因。
- 修复后正常退出旧实例，确认本机 9222 端口关闭后再用原 config.local.yaml 启动，只有一份实例，`logs/spec013-runtime.log`。20:34:46 的实际 dsh 聚焦请求先枚举 3 个候选，再于 20:34:47.764 记录前台 HWND 确认成功；日志来自本机应用当天日志，不以 mock 当作真机成功。
- 20:36:04 通过本应用反馈接口发送明确标记为“诊断验证、不表示当前 dsh 失败”的文字；接口返回 ok=true、paused=false、right 布局。首次创建的真实任务面板经 Windows 原生可访问性读取到完整文字，验证懒加载握手实际生效。收据 `logs/spec013-live-feedback.json`。此操作没有注入任何监控状态，也不冒充真实目标缺失。
- 尝试自动化准备最小化场景时，桌面接口未提供可靠的按钮几何，期间检测到用户输入后重新观察，未将未确认的最小化动作当成功。完整最小化/缩到托盘恢复矩阵尚未完成，因此本规格保持 verifying；未知窗口缺失与激活拒绝由隔离单测/渲染覆盖，不能扩大为所有隐藏窗口均已恢复。
- 原 SPEC-002/012 的其他 DPI/多屏/托盘验收缺口继续保留。应用保持运行、监控已恢复，未自动提交或推送。

本地配置比较仅排除原生位置写回：最终观察 x=1868、y=211（较旧备份 y=167 有变化）；保留当前真实位置，未强制覆盖。其余配置与六项 Hook 严格一致。

### 本地 Git 交付（2026-10-20）

用户明确要求“先提交一版到git上”，授权将已验证的 SPEC-011/012/013、简笔图素材及相关测试/文档一起保存为本地提交。此授权替代前述不自动提交的限制；没有推送授权。本轮不再改变已验证的产品代码，提交前核对 761 项全量测试、24 项渲染、类型检查、构建和 smoke 证据及差异空白检查。本地配置/备份、日志、Hook 事件、工具数据、依赖和构建产物继续排除；SPEC-012/013 的 verifying 状态与未完成桌面矩阵保持不变。提交引用以包含本节的 Git 提交为准。

### 2026-10-21 16:06 隐藏恢复收口（AC-05）

- dsh 隐藏窗口查找与恢复由 [SPEC-020](020-window-reveal-hidden-minimized.md) 完成：`windowTitle`＋`processNames` 也查隐藏窗口，命中的 dsh 走自身单实例恢复。
- 用户 16:06 确认：dsh 隐藏后侧边图标与面板均恢复前台、X 仍可后台。因此 AC-05 的隐藏主窗口恢复获得真机通过。

### 2026-10-21 17:14 受控失败真机测试（AC-01～AC-04 收口）

- 方法：启动**独立第二个指示灯实例**（独立 `--user-data-dir`、临时 `logs/spec013-test.yaml`、CDP 9223），配置两个 `process` 任务匹配 `Notepad3.exe`、`jump.terminal.windowProcess: NoSuchSpec013Window.exe`；不修改用户 `config.local.yaml` 或主实例。
  - AC-01：点击任务行后日志为 `聚焦请求` → `已枚举 0 个候选窗口` → `未找到唯一的隐藏主窗口` → `桌面目标未找到或激活未确认：NoSuchSpec013Window.exe` → `无法定位任务现场`；面板提示为 **“未找到 Spec013 missing target 主窗口，请先打开工具后重试”**，不含旧的通用 cwd/logFile 误导；未配置 cwd/logFile，未发生目录/日志兜底或无关窗口抢占。
  - AC-02/03：失败后真实面板被创建/复用并显示完整提示（CDP DOM：`.panel-toast` 文本、`class="panel-toast show"`、`white-space: normal`、380×43）；截图 `logs/spec013-test-panel-cdp.png`。面板消息走真实 `showPanelMessage` 通道，`mark_read` 独立性由既有 renderer 测试保护。
  - AC-04：把测试实例强制到右停靠窄布局后，用真实渲染层给 `.lamp-toast` 灌入 201 字长消息：`white-space: nowrap`、`overflow: hidden`、`text-overflow: ellipsis`、高度 29（≤36），`scrollWidth 1339 > clientWidth 88`，无逐字竖排/尺寸撑爆；截图 `logs/spec013-lamp-toast-cdp.png`。生产路径中该灯条兜底只在面板通道失败时触发（`showActionError` 先走面板），本次面板通道成功因此灯条不显示；兜底调用路径与 52 DIP 长消息布局由 `overlay-actions`/`ui-panel` 测试与 `check:ui` 24 场景断言保护，本条真实渲染证据为**强制窄布局 + 真实 DOM/CSS**，不把夹具结果冒充为一次真实面板通道失败的灯条弹出。
  - 全量回归仍为 58 文件 852 项通过、typecheck/build/smoke 全绿（代码未变）；测试实例与临时配置已清理，主实例不受影响。
- 结论：AC-01（刷新/失败说明/不抢无关窗口）、AC-02（面板完整反馈、renderer 独立确认由测试保护）、AC-03（面板握手/消息）、AC-04（窄灯条长消息单行省略、面板完整换行）、AC-05/06/07（隐藏恢复、异常隔离、真实脚本）均有证据；AC-04 的灯条兜底触发路径以“面板通道成功时不弹灯条”为设计事实，窄布局渲染用真实 DOM/CSS 复核并注明。本规格状态改为 `done`。
