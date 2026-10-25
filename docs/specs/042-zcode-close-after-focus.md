# SPEC-042：ZCode 点击恢复后 X 无法关闭（单实例接力修复）

> 状态：done
> 类型：bugfix（回归/交互，与 SPEC-023 同类）
> 需求来源：2026-10-25 23:40 用户反馈原话：「会出现和之前其他客户端一样的问题 最小化恢复后 窗口无法点击x进行关闭」（SPEC-041 真机验收期间发现）
> 负责人：AI 协作（dreaming 审阅）
> 基线提交与环境：SPEC-041 工作区（未提交）；Windows 真机；Electron 34.5.8；ZCode 桌面端 `C:\Users\chen\AppData\Local\Programs\ZCode\ZCode.exe`
> 需求依据及假设：与 SPEC-014/023 同根因——Win32 激活脚本的 `SW_MINIMIZE → SW_RESTORE` 往返破坏 Electron 应用自身的关闭处理。假设 ZCode 桌面端具备单实例接力能力：其 `resources/app.asar` 中已确认存在 `requestSingleInstanceLock`（2026-10-25 只读验证）。
> 关联/替代条款：沿用 [SPEC-023](023-dsh-close-after-focus.md) 的 dsh 口径（visible/minimized/hidden 一律自身单实例恢复 + 无最小化前台补齐）与 [SPEC-022](022-focus-latency.md) 的前台确认；不改变 dsh/WorkBuddy 路由。

## 1. 问题与目标

**现有行为**：zcode 任务的 `jump.terminal` 配置为 `windowProcess [ZCode.exe]`，点击 Z 行走 `focusExistingWindow` → `activateViaWin32`（LAMPFOCUS 脚本），其中为保证前台权限执行 `ShowWindow(SW_MINIMIZE)` → `SW_RESTORE`。该往返会让 ZCode（Electron）窗口进入坏状态：恢复后到得了前台，但点 X 无法关闭——与 SPEC-014/023 的 dsh、SPEC-015 的 WorkBuddy 完全同类。

**目标行为**：zcode 任务的显式窗口目标（visible/minimized/hidden）**一律经 ZCode 自身单实例接力恢复**（重新拉起 `ZCode.exe`，由其 second-instance 处理原生恢复窗口），绝不对 ZCode 执行 `SW_MINIMIZE`；仍必须真实前台确认后才报成功；handoff 失败只报失败反馈，不强制显示。

## 2. 范围与非目标

- 本次包含：
  - `src/main/native-window-reveal.ts`：`NATIVE_WINDOW_APPS` 加 `zcode` profile（label ZCode / processName ZCode / executableName ZCode.exe / marker `LAMPZCODEREVEAL ok=True`）。
  - `src/main/focus-worker.ts`：worker 内 `$profiles` 表同步加 zcode（SPEC-037 与脚本同体的要求）。
  - `src/main/focus.ts`：`activate` 路由对 `monitor.type === 'zcode'` 且窗口进程为 zcode 的目标一律 `revealNativeWindow(candidate, 'zcode')`。
  - `test/zcode-native-reveal.test.ts`：镜像 dsh-native-reveal 断言族。
- 本次不包含：dsh/WorkBuddy 路由与脚本变化；Win32 非白名单工具的激活算法；handoff 超时/校验逻辑；配置格式。
- 受影响模块：上列文件；真机验收含 X 关闭。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | ZCode 窗口可见、最小化或隐藏到托盘，任务声明 `windowProcess [ZCode.exe]` | 点击 Z 行 | 走 `LAMPZCODEREVEAL` 原生恢复，日志无 LAMPFOCUS/SW_MINIMIZE 路径；窗口到前台后 X 能正常关闭/回托盘（用户真机确认） |
| AC-02 | 恢复脚本 | 静态检查 | 脚本仅含唯一一次 `IsIconic → ShowWindow(9)`（SW_RESTORE）兜底，无任何 `SW_MINIMIZE(6)`；前台确认（GetForegroundWindow 轮询）先于成功 marker |
| AC-03 | handoff 失败/超时/前台未确认 | 点击 Z 行 | 返回失败反馈，不强制显示窗口、不最小化往返 |
| AC-04 | 其他工具（dsh/WorkBuddy/通用） | 点击 | 路由与行为不变（既有测试回归） |

边界：不结束 ZCode 进程；不自动点 X；真机 X 验收由用户完成。若 ZCode second-instance 未恢复窗口，兜底为 `IsIconic → SW_RESTORE` 一次 + 前台补齐轮询；2.5s 内前台无法确认则报失败（不做最小化）。

## 4. 方案与任务切片

最小方案（复制 SPEC-023 模板）：
1. 切片 A（Red）：`test/zcode-native-reveal.test.ts` 断言 zcode 路由走 `LAMPZCODEREVEAL`、脚本无最小化、前台确认先于 marker、owner/executable 校验、失败不强显。
2. 切片 B（Green）：两张 profile 表加 zcode + focus.ts 路由 `name === 'zcode' && task.monitor.type === 'zcode'` 一律 revealNativeWindow。
3. 切片 C：typecheck → 全量 test → build → smoke；重建 dist 并重启指示灯，用户真机验收（最小化 ZCode → 点 Z 行 → 恢复 → 点 X 关闭）。

备选取舍：仅去掉 activateViaWin32 里的最小化往返——被否，该往返是抢前台权限的既有手段，动它影响全部非白名单工具；白名单 + 原生接力是已验证口径。ZCode 若无单实例接力则本方案不成立（已验证 asar 含 requestSingleInstanceLock，成立）。

## 5. 测试计划与追踪

| AC | 测试文件/完整用例名或真机步骤 | Red 证据 | Green 证据 | 回归/平台验收 |
| --- | --- | --- | --- | --- |
| AC-01 | `test/zcode-native-reveal.test.ts`「uses ZCode itself to reveal the existing main window (visible=false/true)」 | 未运行 | 未运行 | 真机：最小化 ZCode → 点 Z 行 → 恢复 → 点 X（用户） |
| AC-02 | 同文件「SPEC-042: native reveal never minimizes the ZCode window」「native reveal script confirms foreground before success marker」 | 未运行 | 未运行 | — |
| AC-03 | 同文件「never force-shows ZCode after native reveal fails」「does not report success without foreground confirmation」 | 未运行 | 未运行 | — |
| AC-04 | 既有 `dsh-native-reveal.test.ts` / `focus*.test.ts` / `workbuddy-native-reveal.test.ts` 全量回归 | — | 未运行 | — |

回归门槛：typecheck、全量 test、build、smoke 全部留退出码；重建后重启实例交真机验收。

## 6. 执行记录

- 规格就绪依据：用户报告 + SPEC-023 同类根因；ZCode 单实例能力经 asar 只读验证。
- 修改前回归：SPEC-041 收尾时全量 972/972（六项门槛 exit 0）；本规格新增改动只涉及 focus 路由与白名单表。
- 取证：2026-10-25 23:34:46 / 23:34:54 用户两次点击 Z 行，旧实例日志均为 `已通过 Win32 激活窗口「ZCode」`（LAMPFOCUS 路径），与"恢复后 X 无法关闭"现象吻合。
- **R1（vitest Red）**：工作区 = SPEC-041 全部改动 + 新测试（`test/zcode-native-reveal.test.ts`，源码未改）。命令 `npx vitest run test/zcode-native-reveal.test.ts`，exit 1，**10 failed / 0 passed**。失败原因均为行为缺失：`buildNativeWindowRevealScript(…, 'zcode')` 抛 `Unsupported native window application`（profile 表无 zcode）、路由未接入导致 `LAMPZCODEREVEAL` 从未出现在 exec 调用中；非编译/导入错误。
- **G1（Green）**：`NATIVE_WINDOW_APPS` 加 zcode、focus-worker `$profiles` 加 zcode、focus.ts 路由（`name === 'zcode' && monitor.type === 'zcode'` 一律 revealNativeWindow）。`npx vitest run` 焦点族 6 文件 **121/121 exit 0**（含 dsh/WorkBuddy 既有断言零改动全过）。
- **回归门槛（2026-10-25 23:41）**：`npm run typecheck` exit 0；`npm test` **982/982 exit 0**；`npm run build` exit 0；`npm run smoke` exit 0。
- 真机/重启：23:41 首次重启因重启脚本 PIDs 经文件中转遇 CRLF 静默失败、旧实例未退（新主进程被单实例锁挡下，旧实例弹出面板）；23:44 按 PID 直杀后经 VBS 后台入口干净重启，`任务 zcode 监控已启动（zcode）`、`AI 任务指示灯启动完成`（23:44:05），新实例已运行 SPEC-042 构建。
- **2026-10-25 23:50 用户真机确认「可以了」**：最小化 ZCode → 点 Z 行 → 原生恢复到前台 → 点 X 正常关闭/回托盘，问题不再复现。规格关闭。
- TDD 例外：无。
- 需求变更记录：无。

## 7. 交付与验收

- [x] 所有 AC 有验收证据；满足流程 DoD。
- [x] 类型检查、全量测试、构建后 smoke 结果已记录。
- [x] 规格索引已更新。
- [x] 真机 X 验收 2026-10-25 用户确认通过。

最终结果/提交引用：随本仓库提交（git log 检索 SPEC-042）。真机验收通过，规格关闭。回退方式：删除 focus.ts 的 zcode 路由与两张 profile 表的 zcode 行（会重新引入 X 问题）。
