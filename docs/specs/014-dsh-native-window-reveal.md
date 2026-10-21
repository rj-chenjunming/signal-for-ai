# SPEC-014：dsh 恢复后保留正常关闭行为

> 状态：done
> 类型：bugfix
> 需求来源：2026-10-21 用户确认侧边图标能恢复 dsh，但截图所指的 dsh 自身右上角关闭按钮无响应。
> 负责人：Codex
> 基线：HEAD 13c6a98＋全部保留的 SPEC-011/012/013 暂存及未暂存修改；Windows 10.0.26200，Node 24.16.0，Electron 33.4.11，dsh 0.2.1-rc.2。
> 需求依据及假设：只修复当前 dsh 窗口生命周期，不更改其他工具或新增配置。
> 关联/替代条款：替代 SPEC-013/AC-05 中“隐藏 dsh 直接 Win32 恢复”的实现策略；保留其进程限定查找和失败反馈。

## 1. 问题与目标

本机复现：通过 dsh 安装程序自身的单实例入口恢复已有 HWND 527050，再点右上角 X，窗口隐藏；通过指示灯直接 ShowWindow 恢复相同 HWND，再点 X，窗口仍可见。安装包只读代码显示 close 事件防止退出并调用 BrowserWindow.hide，而单实例 second-instance 回调调用 restore/show/focus。仅用系统 ShowWindow 恢复不能保证 Electron 自身的可见性状态同步；此为有实测支持的原因判断，不改 dsh 的内部文件来绕过。

目标：点击指示灯恢复后，dsh 的 X 仍能正常隐藏到后台，任务与进程继续存在，再次点击可以恢复。

## 2. 范围与非目标

- 仅显式 windowProcess＋dsh monitor＋实际 DeepSeek Harness 进程使用其单实例入口恢复；普通可见 dsh 也走此入口以修复此前不一致状态。
- 使用当前已匹配 HWND/PID，核对窗口归属与进程仍存活，读取同一进程的真实可执行路径；仅允许文件名 DeepSeek Harness.exe。启动同一已安装程序的临时单实例客户端，不传会话/命令/URL、不启动一个未运行的工具；等待客户端在时限内退出，然后只读确认原 HWND 已在前台。
- 不再对 dsh 目标执行 ShowWindow 或 AppActivate；原生恢复失败、目标消失、路径读取失败、客户端异常/超时、前台未确认均失败关闭，保留现有可操作说明/配置降级。
- 其他工具仍保留 Win32 恢复及句柄归属保护；不新增依赖/配置，不改监控状态、dsh 数据库/认证/安装内容，不结束正在执行的任务。
- 不保证操作系统拒绝前台时仍能强制成功；查询与临时客户端均有超时，不注册定时器/常驻进程。核对后原应用恰好退出的极短竞争窗口无法与第三方启动实现原子化，不能保证外部用户在该瞬间退出时仍完全避免其重启。

## 3. 验收条件

| ID | Given | When | Then |
| --- | --- | --- | --- |
| AC-01 | 配置中的 dsh 主窗口隐藏或可见 | 点击图标/面板切回 | 核对现有 HWND/PID/进程名，走同一程序单实例客户端；前台 HWND 确认后才成功，不执行 ShowWindow/AppActivate。**SPEC-020 修订**：目标最小化（`IsIconic=true`）时，handoff 后允许一次 `SW_RESTORE` 兜底；隐藏窗口（`IsWindowVisible=false`）仍禁止 ShowWindow；命中配置 `processNames` 的 dsh 目标不再要求 `terminal.type: windowProcess` |
| AC-02 | 目标消失/句柄换主/路径不符，或客户端失败/超时、未到前台 | 恢复请求 | 返回失败或原配置明确降级，不强行显示窗口、不报告假成功；无重复常驻实例 |
| AC-03 | WorkBuddy/Codex/其他进程或仅标题目标 | 切回 | 保留既有进程限定/标题及 Win32 跳转行为，无 dsh 专用客户端 |
| AC-04 | 本机 dsh 有后台任务 | 连续两轮：图标恢复→点 X 隐藏→再次恢复；另一次面板恢复 | X 可用，主 PID/HWND 不变，任务未被终止；指示灯保持运行。需真实 Windows 验收 |

## 4. 方案与任务切片

先用注入执行器为 AC-01/02 加回归并确认有效 Red，再新增进程/句柄限定的单实例恢复脚本及前台确认。真实脚本测试仅验证解析/保护分支，不在自动化测试中启动个人 dsh；临时客户端正常路径由本机 UI 闭环验收。同步更新 SPEC-013 的当前结果和未完成项，不抹除历史失败记录。

## 5. 测试计划与追踪

| AC | 测试/步骤 | Red | Green | 平台 |
| --- | --- | --- | --- | --- |
| AC-01/02 | test/dsh-native-reveal.test.ts，隐藏/可见、归属保护、失败/超时/前台未确认 | 7项有效失败见下 | 14项通过，真实 guard 执行通过 | 原生恢复前台已确认；用户确认 X 隐藏正常 |
| AC-03 | 原 focus 回归及非 dsh 路径 | 已有保护 | 92相邻及803全量通过 | 不扩大为三工具矩阵全通过 |
| AC-04 | Windows computer-use 两轮 X/恢复及面板请求，元数据/应用日志佐证 | 用户截图＋本机已复现 | 一次恢复→用户 X 隐藏通过；2026-10-21 16:06 用户确认隐藏/最小化后侧边图标与面板均恢复、X 仍可后台 | 多轮及面板路径已通过，不以单测代替 |

## 6. 执行记录

关键行为已由用户明确反馈及本机对比确认，无需重复审批。修改前 789 项回归/类型/构建/smoke 为 SPEC-013 上轮结果，仅为历史参考，不继承本轮通过。执行目录为 C:\Users\chen\PRJ\ai-signal；保留全部本地改动和 config.local.yaml。TDD 例外无；实现前先完成 Red。

- Red：01:14:09，`npm test -- test/dsh-native-reveal.test.ts --maxWorkers=2 --minWorkers=1`，7/7 断言失败、exit 1，`logs/spec014-red.log`。旧代码未请求 dsh 自身恢复、仍 ShowWindow，并在 native reveal 失败/前台未确认的夹具中报告成功。是有效行为断言，不是导入/编译错误。
- Green：新增 dsh-native-reveal.ts 及 FocusService 专用分支后同命令 7/7、exit 0，01:14:41，`logs/spec014-green.log`。
- 相邻首轮：原 SPEC-013 dsh 夹具仍只模拟 LAMPFOCUS，4/85 失败、exit 1，`logs/spec014-neighbor-first.log`。按本规格改为模拟 LAMPDSHREVEAL＋独立 LAMPVERIFY；句柄归属断言从“ShowWindow 前”转为“单实例 handoff 前”，保留原 HWND/进程/失败/降级断言，额外要求拒绝错误候选时不执行任一恢复路径。新增其他工具仍走 Win32 且先校验 PID 的保护，未删除断言或跳过失败。
- 相邻 Green：01:15:29，五文件 92/92、exit 0，`logs/spec014-neighbor-green.log`。含 Windows powershell.exe 实际编译归属验证，stale-owner 在启动客户端前拒绝，不拉起个人 dsh；身份非法值在构建命令前拒绝。没有必要额外重构监控/UI。

## 7. 交付与验收

- `npm run typecheck`：exit 0，`logs/spec014-typecheck.log`。
- `npm test -- --maxWorkers=2 --minWorkers=1`：01:16:15，51文件803项通过、无跳过、exit 0，`logs/spec014-full-test.log`。
- `npm run build`：exit 0，`logs/spec014-build.log`；随后 `npm run smoke`：exit 0，`logs/spec014-smoke.log`。
- `git diff --check` 与 `git diff --cached --check`：exit 0。配置/Hook 复核通过，除之前已记录的原生窗口位置写回外，原值保留；没有把个人配置或工具数据放入 Git。
- 使用同版本临时 Electron 启动原配置，避免另一个仓库运行时目录异常；该问题不在本规格修复范围。
- 01:17 正常退出旧指示灯并启动新实例，主 PID 13792，`logs/spec014-runtime.log`。01:17:28.435 真实点击侧边 dsh 图标，01:17:30.285 应用日志确认“dsh 自身恢复成功，前台 HWND 已确认”。随后检测到用户正在操作窗口，停止自动点击；用户明确回复“可以正常关闭到后台”。01:18 只读复核 dsh 主 PID 34092 及其余子进程与此前一致，所有 MainWindowHandle=0，说明 X 已隐藏窗口而非结束进程；没有临时客户端常驻。服务仍是原 authority / 5会话，指示灯继续运行。
- 两轮恢复及面板触发的完整 AC-04 仍未执行，因此保持 verifying，不扩大用户一次确认的结论。不改 dsh 安装/认证/数据库或中断其任务。

### 2026-10-21 真机验收：AC-04 失败（最小化场景无法恢复）

- 现象（用户反馈，14:49）：dsh 窗口**最小化**后，点指示灯侧边图标或面板「切回工具」都不会把窗口拉回前台；X 隐藏后恢复是正常的。用户要求先记录，未进入修复。
- 判定：AC-04 未通过。`verifying` 保持，不得标 `done`。
- 根因（两层，均已定位到代码）：
  1. **恢复执行层**：`focus.ts:742-749` 的 `activate()` 对 `windowProcess` + `deepseek harness`（以及 `workbuddy`）直接 `return this.revealNativeWindow(...)`，**不会**落到带 Win32 降级链的 `focusExistingWindow()`。而 `native-window-reveal.ts:16` 的脚本只做「启动同一 exe 的单实例 handoff」，全文没有 `IsIconic` 判断、没有 `ShowWindow(SW_RESTORE)`。最小化窗口的 `hwnd` 仍然有效，但 Electron 侧收到 `second-instance` 通常只 `focus()` 不 `restore()`，于是窗口保持最小化；随后 `verifyForeground()` 前台确认失败，返回「未能切回」。
  2. **窗口发现层**：`hidden-window.ts:71` 的过滤条件是 `r.Visible !== false` 即拒绝，也就是**只接受 `IsWindowVisible=false` 的窗口**。而 Windows 的最小化窗口 `IsWindowVisible=TRUE`（`Visible=true` + `IsIconic=true`），因此 `findHiddenWindow()` 不可能找到最小化窗口，只有 X 隐藏（`Visible=false`）才命中。
- 连带影响：**SPEC-015（WorkBuddy，已 done）走的是同一个 `revealNativeWindow` 分支**（`focus.ts:745`），同样没有 restore 兜底。它的 `done` 只覆盖了「X 隐藏→恢复」，**最小化场景是当时验收的盲区**，需重新纳入验收范围。
- 修复方向（未实施，待决策）：
  - A：`buildNativeWindowRevealScript` 在 handoff 前判断 `IsIconic(hwnd)`，为真先 `ShowWindow(hwnd, SW_RESTORE)`，再做单实例启动。
  - B：`activate()` 在 `revealNativeWindow()` 返回 false 时，对 `workbuddy`/`dsh` 降级到 `focusExistingWindow()`（其降级链已含 `ShowWindow(SW_RESTORE)`），改动最小。
  - C：同时放宽 `hidden-window.ts` 的可见性过滤，把 `IsIconic=true` 的窗口纳入候选（需避免把真实最小化但已退出任务的窗口误判为可恢复）。
  - 注：A/C 与 AC-01「不执行 ShowWindow」的克制原则冲突，实施前需先修订本规格的 AC-01 与 SPEC-015 的对应条款。
- 历史依据（供修复时判断，勿重复走过的弯路）：
  - [round21](../../round21-窗口抢占必须最小化再恢复.md)（2026-10-14）证明 Chrome 这类「浏览器窗口」必须 `SW_MINIMIZE` → `SW_RESTORE` 往返才能抢到前台，这是 `focus.ts:896-910` 现有降级链的由来。
  - [round22](../../round22-用dsh本地客户端解决切换.md)（2026-10-14）把 dsh 桌面端改为单实例 handoff，理由是要保住 dsh 自身的窗口生命周期（X 只隐藏、不退出进程），因此本规格 AC-01 才禁止 `ShowWindow`/`AppActivate`。
  - 由此推得的关键区分：**「最小化」与「隐藏」是两个不同掩码**（`IsIconic=true` / `IsWindowVisible=false`）。对隐藏窗口调 `ShowWindow` 会绕开 dsh 的单实例语义（故禁止）；而对最小化窗口调 `SW_RESTORE` 只是取消最小化、不改变 dsh 的显示归属，语义上不与 AC-01 冲突——**方案 A 的可行性取决于能否在规格里把这两种状态显式分开**，而不是整体推翻「不 ShowWindow」。
  - `docs/round*.md` 为外部同步副本，本规格只引用、不编辑。
- 证据：本轮未取得日志（用户仅要求记录）。复现与修复验证需在用户桌面会话进行。
- 本地 Git：用户此前“先提交一版到git上”授权仍适用，本次把 SPEC-011～014 的最终修复、素材与测试一起保存；提交引用为包含本节的本地提交，无推送授权。个人配置、日志、事件、依赖与 dist 排除。

### 2026-10-21 15:21 修复：由 SPEC-020 接管“隐藏/最小化”恢复

- 根因更正（真机复现后）：dsh 的实际后台状态是**隐藏**（`Visible=false`、`IsIconic=false`、`Process.MainWindowHandle=0`），不是 `IsIconic` 最小化；用户配置的 `dsh-local` 使用 `windowTitle`＋`processNames`，而隐藏查找当时只在 `windowProcess` 分支执行，因此点击必然“未找到”。WorkBuddy 才是真正的 `IsIconic` 最小化场景。
- 修复（[SPEC-020](020-window-reveal-hidden-minimized.md)）：`windowTitle`＋`processNames` 也启用隐藏查找；**只有隐藏查找得到的 dsh 候选**才按进程身份走自身单实例恢复，可见/最小化的 `windowTitle` dsh 继续既有 Win32 恢复（真机发现把可见窗口交给 handoff 会前台确认失败，已收窄并加回归测试）。
- 真机证据：`logs/spec020-real-verify.log` 与 `logs/spec020-real-hidden-verify.log` 显示 dsh 可见/系统最小化（Iconic）→ `ok:true`、`已通过 Win32 激活窗口`、窗口回到可见且非最小化；`windowProcess` 配置的最小化 dsh 仍走单实例 + 守卫 `SW_RESTORE`。全量 852 项、typecheck/build/smoke 全绿（见 SPEC-020 §7）。
- 仍保持 `verifying`：AC-04 需要用户用 dsh 自身的最小化/X 触发隐藏后，点击侧边图标与面板两条路径、连续两轮并确认 X 仍可后台；Agent 不以外部 ShowWindow 或程序化关闭冒充该验收。
- 15:38 真机补齐“面板触发”一档：真实点击悬浮灯打开面板，点击 dsh「切回工具」→ 应用日志 `聚焦请求：任务 dsh-local` → `已通过 Win32 激活窗口`，只读前台 `Foreground=460928 (DeepSeek Harness)`。该次目标为可见 dsh（SPEC-020 收窄后走 Win32），不是隐藏/最小化原生入口；隐藏场景与 X 闭环仍待用户确认。
- 15:45 真机补齐“侧边图标”一档：向悬浮灯 dsh 行投递真实点击 → `聚焦请求：任务 dsh-local` → `已通过 Win32 激活窗口`，前台 HWND 460928。两条入口一致；仍未覆盖隐藏状态与 X 闭环。

### 2026-10-21 16:06 用户真机确认（AC-04 收口）

- 用户按提示用 dsh 自身的最小化/X 把窗口藏到后台，随后点侧边鲸鱼图标与面板「切回工具」均恢复前台；再点 X 仍能隐藏到后台。
- 用户明确回复“两项都正常（恢复 + X 后台）”。结合 15:38 面板、15:45 侧边图标、15:58 隔离夹具与 15:31 最小化真机证据，AC-04 的所有目标条件均有可复核证据。
- 本规格状态改为 `done`。保留历史失败记录与修复过程，不抹除 14:49 的 AC-04 失败。
