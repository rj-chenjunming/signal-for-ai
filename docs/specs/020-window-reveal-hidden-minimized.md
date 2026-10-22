# SPEC-020：点击恢复被隐藏或最小化的 dsh / WorkBuddy 窗口

> 状态：done
> 类型：bugfix / 行为补齐
> 需求来源：2026-10-21 14:49 用户反馈“dsh 窗口最小化后，点侧边图标或面板「切回工具」不恢复”；同日 14:47–14:48 应用日志与 15:05 真实复现。
> 负责人：Codex
> 基线：6369bb4＋工作区保留的 SPEC-014/015/017/019 文档改动；Windows 10.0.26200，Node 24.14.0，Electron 33.4.11，dsh 0.2.1-rc.2，WorkBuddy 5.8.3。
> 需求依据及假设：用户要求“点了要能回到工具”。dsh 的“最小化”按其自身实现会留下 `IsWindowVisible=false`、`Process.MainWindowHandle=0` 的隐藏窗口（SPEC-013 已记录同一事实）；WorkBuddy 的普通最小化留下 `Visible=true`、`IsIconic=true`。二者是不同掩码，恢复策略必须分开。
> 关联/替代条款：扩展 SPEC-013/AC-06 的隐藏查找触发条件（`windowTitle`＋`processNames` 也查），扩展 SPEC-014/AC-01、SPEC-015/AC-01 的原生恢复适用范围（不再要求 `terminal.type: windowProcess`），并在 SPEC-014/015 的“不执行 ShowWindow”克制原则中显式区分“隐藏”（仍禁止）与“最小化”（允许一次 `SW_RESTORE`）。

## 1. 问题与目标

三个真实事实（均在本机取得证据，见 §6）：

1. `config.local.yaml` 的 `dsh-local` 使用 `jump.terminal.type: windowTitle`＋`processNames`。dsh 的后台状态是**隐藏**（`Visible=false`、`IsIconic=false`、`Process.MainWindowHandle=0`）。现有 `FocusService` 只在 `windowProcess` 分支查询隐藏窗口，因此 `windowTitle` 目标必然报“未找到 dsh 主窗口”，与 14:48 日志（候选窗口 3→2、`桌面目标未找到或激活未确认`）一致。
2. `WorkBuddy` 与（配置为 `windowProcess` 时的）dsh 走 `revealNativeWindow()` 的单实例 handoff。`native-window-reveal.ts` 没有任何 `IsIconic` 判断或 `SW_RESTORE`，普通最小化窗口保持 `IsIconic=true`，随后前台确认失败，与 14:54 日志（`WorkBuddy 自身恢复后未确认前台 HWND`）一致。
3. 隐藏窗口不能用 `ShowWindow` 强行恢复：那会绕开 dsh/WorkBuddy 自身窗口状态，SPEC-014 已实测会让 X 失效。最小化窗口则不同，`SW_RESTORE` 只是取消最小化，不改应用自身的显示归属。

目标：点击指示灯侧边图标或面板「切回工具」后，dsh 与 WorkBuddy 无论处于隐藏还是最小化都能回到前台；隐藏窗口仍由工具自身单实例入口恢复，不破坏 X；其他工具行为不变。

## 2. 范围与非目标

- 本次包含：
  - `windowTitle` 目标**声明了 `processNames`** 时，普通主窗口缺失也执行隐藏窗口只读查找；没有 `processNames` 的纯标题目标保持不查隐藏窗口（SPEC-013 的边界）。
  - 当候选窗口**来自隐藏查找**（`windowTitle` 或 `windowProcess`）且进程名命中配置的 `processNames`、应用为 dsh（`monitor.type: dsh`）或 WorkBuddy 时，按**进程身份**走各自单实例恢复；`windowProcess` 目标保持原有的全状态原生恢复；`windowTitle` 的可见/最小化窗口继续既有 Win32 恢复（真机发现：把可见窗口交给 handoff 会因前台锁无法确认前台，属回归，见 §6）。
  - `buildNativeWindowRevealScript`：单实例 handoff 完成后，若目标仍 `IsIconic`，执行一次 `ShowWindow(SW_RESTORE)`，再做前台确认；隐藏窗口（非 IsIconic）不执行任何 ShowWindow。
- 本次不包含：不改监控、状态机、通知、IPC、配置格式；不新增启动工具或常驻进程；不改 dsh/WorkBuddy 安装、认证、数据库；不改 UI 图标与面板布局；不对隐藏窗口调用 `ShowWindow`/`AppActivate`。
- 受影响模块：`src/main/focus.ts`（隐藏查找触发、按身份选择恢复）、`src/main/native-window-reveal.ts`（最小化兜底）、对应测试与三份规格文档。配置向后兼容：现有 `config.local.yaml` 无需改动。

## 3. 验收条件

| ID | Given | When | Then |
| --- | --- | --- | --- |
| AC-01 | dsh 任务为 `windowTitle`＋`processNames: [DeepSeek Harness]`，dsh 窗口隐藏（`Visible=false`、`Iconic=false`、`MainWindowHandle=0`） | 点击侧边图标/面板切回 | 只读查到唯一隐藏主窗口；核对 HWND/PID/可执行文件后走 dsh 单实例入口；前台 HWND 确认后成功；不执行 ShowWindow/AppActivate；dsh 的 X 仍能隐藏到后台 |
| AC-02 | dsh 窗口可见但不在前台，或最小化（`Iconic=true`，`windowTitle` 配置） | 同上 | 保持既有 Win32 恢复（`SW_MINIMIZE`→`SW_RESTORE`+前台确认），成功且主 PID/HWND 不变；可见窗口不得交给单实例 handoff 导致前台确认失败 |
| AC-03 | WorkBuddy 窗口隐藏或最小化（`windowProcess` 配置）；或 `windowTitle` 配置下隐藏 | 同上 | 隐藏窗口走 WorkBuddy 单实例入口；最小化窗口在 handoff 后 restore 并确认前台；`windowTitle` 的可见窗口仍 Win32；X 仍能隐藏到后台 |
| AC-04 | 纯 `windowTitle`（无 `processNames`）、其他进程或普通工具目标 | 切回 | 保持既有 Win32/标题行为；不查隐藏窗口、不启动原生单实例客户端；无法确认时按原失败/降级路径报告 |
| AC-05 | 隐藏查询失败/多候选/坏 JSON/超时；归属或路径校验失败；客户端失败/超时；前台未确认 | 切回 | 失败关闭，不强行显示、不报告假成功、无重复常驻实例；保留原配置降级提示 |

边界与假设：

- “隐藏”与“最小化”以 `IsWindowVisible=false` / `IsIconic=true` 区分；隐藏状态允许 X 语义，最小化状态允许一次 restore。
- 单实例客户端仍有 3 秒退出超时、身份/路径/归属校验和前台 HWND 确认；核对后原应用恰好退出的极短竞争窗口沿用 SPEC-014 的限制。
- 隐藏窗口查找仍是只读 `EnumWindows`，唯一候选才恢复；无进程约束的标题目标不启用（避免误激活浏览器/辅助窗口）。

## 4. 方案与任务切片

1. **隐藏查找切片**：把隐藏查找条件从“仅 windowProcess”改为“terminal 声明了 processNames”；`windowTitle` 用 `match` 作为标题过滤。先补 Red（windowTitle＋processNames 隐藏命中并走原生恢复；无 processNames 不查）。
2. **身份路由切片**：`activate()` 仅对“隐藏查找得到的候选”或 `windowProcess` 目标按进程身份选择原生恢复；`windowTitle` 的可见/最小化窗口仍 `focusExistingWindow()`。先补 Red（隐藏命中走 `LAMPDSHREVEAL`；可见 `windowTitle` 仍 `LAMPFOCUS`；可见窗口交给 handoff 的回归必须有测试）。
3. **最小化兜底切片**：生成脚本加入 `IsIconic` 守卫下的 `SW_RESTORE`，位置在 handoff 之后、marker 之前；更新 SPEC-014/015 原有“无 ShowWindow”断言为“ShowWindow 仅出现在 IsIconic 守卫内”。先补 Red（脚本缺少守卫/restore）。
4. **真实机验证切片**：用真实 `FocusService`＋真实 dsh/WorkBuddy 窗口验证隐藏、最小化两种状态与失败路径；dsh 恢复使用其自身单实例入口，不用外部 ShowWindow 伪造成功。
5. **文档切片**：新增本规格，修订 SPEC-013/014/015 的相关条款与索引状态（纯文档，TDD 不适用）。

## 5. 测试计划与追踪

| AC | 测试文件/完整用例名或真机步骤 | Red | Green | 回归/平台 |
| --- | --- | --- | --- | --- |
| AC-01 | `test/focus-hidden-window.test.ts` → `discovers a hidden window for a windowTitle target with processNames and uses the dsh entry`；真实机：dsh 自身隐藏后调用 FocusService | 失败：`expect(result.ok).toBe(true)` 实际 false（未触发隐藏查找/原生恢复） | 通过 | 逻辑层通过；2026-10-21 16:06 用户真机确认：dsh 自身隐藏后，侧边图标与面板均恢复前台，X 仍可后台 |
| AC-02 | `test/focus-hidden-window.test.ts` → `keeps Win32 foreground recovery for a visible windowTitle dsh target`；`test/dsh-native-reveal.test.ts` → `restores a still-minimized dsh window after the native handoff`（windowProcess 配置的脚本契约）；真实机：dsh 可见/系统最小化后调用 FocusService | 回归 Red：可见 `windowTitle` 被错误路由到原生，`1 failed / 29 skipped`，`logs/spec020-visible-red.log`；原生脚本 Red 为无 `IsIconic` 守卫 | 通过（Win32 真机＋脚本守卫） | 逻辑层＋Windows 真机通过 |
| AC-03 | `test/workbuddy-native-reveal.test.ts` → `restores a still-minimized WorkBuddy window after the native handoff`；`test/focus-hidden-window.test.ts` → `keeps the native WorkBuddy route for a hidden windowTitle target` | 失败：无守卫 restore、无 hidden windowTitle 身份路由 | 通过（脚本守卫＋真实窗口） | 逻辑层＋Windows 真机通过；2026-10-21 16:06 用户确认最小化恢复后 X 回后台 |
| AC-04 | `test/focus-hidden-window.test.ts` → `does not enumerate hidden windows for an unrestricted title-only target`（既有）、`keeps Win32 activation for a non-native process discovered through a windowTitle target` | 新增用例失败：非原生进程经 windowTitle 隐藏查找后未走通 | 通过 | 逻辑层 |
| AC-05 | 既有隐藏/原生失败矩阵：多候选、坏 JSON、超时、归属变化、前台未确认 | 既有用例保持通过（不新增失败） | 通过 | 逻辑层 |

## 6. 执行记录

### 2026-10-21 真实复现（修复前）

- 环境：Windows 10.0.26200，Node 24.14.0；应用主进程 PID 29016（`dist` 构建于 10:44，相对 6369bb4 无 focus 变更）；dsh 0.2.1-rc.2 PID 28532。
- 隐藏场景：`logs/spec020-repro-hidden.cjs`。dsh 主窗口 `hwnd=460928` 隐藏后 `Visible=false`、`Iconic=false`、`Process.MainWindowHandle=0`，`FocusService.focusTerminal(dsh-local)` 只枚举到 2 个候选窗口，返回 `ok:false`、`未找到 dsh（本地客户端） 主窗口`，与 14:48 应用日志一致。
- 最小化场景：`logs/spec014-minimized-repro.cjs`。WorkBuddy（windowProcess）`Iconic=true` 时返回 `ok:false`、日志 `WorkBuddy 自身恢复后未确认前台 HWND`，窗口仍最小化；与 14:54 应用日志一致。
- 对照：dsh-local（windowTitle）**窗口最小化到任务栏**（`Iconic=true`）时，修复前的 Win32 路径也可恢复并确认前台；因此用户所述“最小化”对应 dsh 自身的隐藏状态（`IsWindowVisible=false`），不是 `IsIconic`。
- 副作用说明：为验证恢复路径，曾用外部 `ShowWindow(SW_SHOW)` 把 dsh 从隐藏恢复为可见；正常修复路径不采用该手段。该操作可能让 dsh 自身可见性状态不同步，若用户发现 X 异常，重启 dsh 即可恢复（未改 dsh 文件/数据）。

### 2026-10-21 TDD 记录

- Red（15:09）：`node node_modules/vitest/vitest.mjs run test/dsh-native-reveal.test.ts test/workbuddy-native-reveal.test.ts test/focus-hidden-window.test.ts --maxWorkers=2 --minWorkers=1`，3 文件失败、`15 failed | 41 passed`、exit 1，`logs/spec020-red.log`。失败原因为目标行为缺失：生成脚本无 `IsIconic`/守卫 `ShowWindow`（匹配 0 处）、`windowTitle`＋`processNames` 不触发隐藏查找（`result.ok` false）、WorkBuddy 的 `windowTitle` 目标不走原生恢复；非编译/依赖错误。
- Green（15:09）：同命令 3 文件、`56 passed`、exit 0，`logs/spec020-green.log`。
- Refactor：把“隐藏查找进程名”收敛为一次 `hiddenLookupProcessNames` 计算，消除两处重复条件；重跑相邻 focus 六文件 `108 passed`、exit 0；`npm run typecheck` exit 0。
- 真实机（15:11，`logs/spec020-real-verify.cjs`、`logs/spec020-real-verify.log`）：dsh/WorkBuddy 最小化后 `ok:true`、日志 `自身恢复成功，前台 HWND 已确认`、窗口回到 `Visible=true`/`Iconic=false`。该轮 dsh 走的是中间构建的原生路由。
- **15:28 发现回归并收窄路由**：中间构建把 `windowTitle` 的**可见** dsh 也交给单实例 handoff；真机 `logs/spec020-visible-path-verify.log` 显示 `dsh 自身恢复后未确认前台 HWND`，而旧 Win32 路径本来能成功。修复为“仅隐藏查找候选或 `windowProcess` 目标走原生；`windowTitle` 可见/最小化继续 Win32”。
- 回归 Red（15:29）：`node node_modules/vitest/vitest.mjs run test/focus-hidden-window.test.ts -t 'visible windowTitle dsh'`，`1 failed / 29 skipped`、exit 1，`logs/spec020-visible-red.log`；原因是目标行为缺失（可见窗口误走原生），非环境错误。收窄后目标与相邻三文件 `57 passed`、exit 0，`logs/spec020-green-2.log`。
- 15:31 真机复验（同一构建）：
  - `logs/spec020-visible-path-verify.log`：dsh 可见、前台先切到其他窗口，`FocusService` 返回 `ok:true`，日志 `已通过 Win32 激活窗口`；
  - `logs/spec020-real-verify.log`：dsh 系统最小化 → `已通过 Win32 激活窗口`，窗口恢复；WorkBuddy 最小化 → `WorkBuddy 自身恢复成功，前台 HWND 已确认`，窗口恢复；两者 `SUMMARY failures=0`；
  - `logs/spec020-real-hidden-verify.log`：真实 `WM_SYSCOMMAND/SC_MINIMIZE` → dsh `Iconic=true`，`FocusService` 返回 `ok:true` 并恢复为可见，`SUMMARY failures=0`。
  - 说明：产品自身 `LAMPVERIFY` 日志是前台判据；外部探针在请求返回后可能被远端桌面/微信等窗口抢走焦点，只作参考。
- 15:38 面板真机路径：真实点击悬浮灯打开面板（日志 `任务列表面板已创建`），点击 dsh「切回工具」→ `聚焦请求：任务 dsh-local` → `已通过 Win32 激活窗口`，前台 `Foreground=460928`。覆盖 AC-02 的面板触发一档（可见 dsh）；隐藏 dsh 的面板/侧边图标点击仍待用户确认。
- 15:45 侧边图标路径：向悬浮灯 dsh 行投递真实按键消息 → `聚焦请求：任务 dsh-local` → `已通过 Win32 激活窗口`，前台 `Foreground=460928`。侧边图标与面板两条入口行为一致。

### 2026-10-21 15:58 隔离 Electron 夹具端到端验证（不触碰真实工具）

真实 dsh 的隐藏状态无法在程序内安全触发（可能中断当前会话），因此用一个**真实 Electron/Windows 进程**验证同一代码路径：

- 夹具：`node_modules/electron/dist` 下临时硬链接 `WorkBuddy.exe` 指向 electron.exe；`resources/app/main.js` 提供无参数入口（唯一标题 `LampSpec020Fixture`、close→hide、second-instance→show/focus、独立 userData）。夹具进程名/可执行文件名与生产白名单一致，但窗口标题唯一，避免命中用户真实 WorkBuddy。
- 步骤与结果（`logs/spec020-fixture-hidden-verify.log`，`SUMMARY failures=0`）：
  1. `WM_CLOSE` 触发布局自身 close 处理器 → `Visible=false`、`Iconic=false`，与 dsh 的 X 后状态一致；
  2. 真实 `FocusService.focusTerminal(windowTitle＋processNames)`：普通枚举 0 个候选 → `已找到配置进程的隐藏主窗口（pid=27240 hwnd=333932）` → 单实例 handoff → 日志 `WorkBuddy 自身恢复成功，前台 HWND 已确认`，结果 `ok:true`、窗口恢复可见；
  3. 再最小化 → 普通枚举 1 个候选 → `已通过 Win32 激活窗口`，结果 `ok:true`，证明可见/最小化 windowTitle 仍走 Win32。
- 该夹具验证了“隐藏查找 + 身份路由 + 单实例恢复 + 前台确认”与“可见/最小化 Win32”两条真实路径，不触碰用户 dsh/WorkBuddy 的数据或进程；仍不替代 AC-01 对真实 dsh 的 X/隐藏点击验收。
- 清理：夹具进程已停止、`resources/app` 已删除、独立 userData 已删除；临时 `WorkBuddy.exe` 硬链接改名 `WorkBuddy.exe.locked` 后仍被系统占用无法删除（位于 gitignored 的 `node_modules`，不影响构建/测试，后续可重启后清理）。

### 2026-10-21 16:06 用户真机确认（AC-01/AC-03 收口）

- dsh：用户用 dsh 自身的最小化/X 把窗口藏到后台后，点侧边鲸鱼图标与面板「切回工具」均恢复前台；随后点 X 仍能隐藏到后台。
- WorkBuddy：最小化后点小猫图标恢复前台；点 X 仍能隐藏到后台。
- 用户明确回复两项均“两项都正常（恢复 + X 后台）”。至此 AC-01～AC-05 全部有逻辑层、真实进程或用户真机证据，本规格可收为 `done`。
- 15:35 用最终构建重启指示灯（主进程 7956），悬浮灯恢复并随任务数调整尺寸；dsh-web 的远端鉴权失败会自动重试，与本规格无关。

### 2026-10-22 09:50 修订：dsh 可见目标改走自身恢复（SPEC-023）

- 实际回归：可见 dsh 仍走 Win32 的 `SW_MINIMIZE→SW_RESTORE`，X 再次失效（2026-10-22 09:39 日志 `已通过 Win32 激活窗口`）。
- [SPEC-023](023-dsh-close-after-focus.md) 将 dsh 的 visible/minimized/hidden 目标全部改走单实例恢复，不再最小化；09:50 真机点击 1.786s 成功，用户 10:02 确认 X 正常。
- 本规格的“可见 `windowTitle` 走 Win32”只保留给非 dsh 进程；dsh 分支由 SPEC-023 替代。

## 7. 交付与验收

- [x] 需求有依据，范围与 AC 明确；关键未知项（隐藏 vs 最小化状态）已用真机复现澄清。
- [x] 逻辑层 AC 有测试且先失败后通过；TDD 记录见 §6。
- [x] 类型检查、全量测试、构建后 smoke 已执行并记录。
- [x] 涉及 Windows 窗口真实路径的 AC-01/AC-02/AC-03 已用真实窗口与用户真机确认。
- [x] 规格索引、SPEC-013/014/015 的相关条款已同步；无秘密或本机配置进入提交。
- [x] 已知限制与发布状态已说明。

验证证据：

- `npm run typecheck`：exit 0（收窄路由后再次执行）。
- `npm test -- --maxWorkers=2 --minWorkers=1`：2026-10-21 15:33，58 文件 **852 项全部通过**（新增可见窗口回归用例，无跳过）、exit 0，`logs/spec020-full-test-final.log`。此前基线中的 35 项环境失败（powershell/Add-Type、真实进程 IO、sqlite 子进程等）在本次完全权限执行下全部消失，不能把本结果倒推为历史通过，但本轮回归确为全绿。
- `npm run build`：exit 0，`logs/spec020-build-final.log`；随后 `npm run smoke`：exit 0（全部通过，1040ms），`logs/spec020-smoke-final.log`。
- 真实机：见 §6（可见/最小化 dsh、WorkBuddy、系统最小化命令、面板/侧边图标、隔离 Electron 夹具隐藏→单实例恢复；16:06 用户确认 dsh/WorkBuddy 隐藏/最小化恢复与 X 后台均正常）。
- 已知限制：程序化隐藏真实 dsh 会绕过其 Electron 自身状态，因此验收使用用户自身的最小化/X 触发；隔离夹具验证同一代码路径。可见窗口的焦点确认以产品自身 `LAMPVERIFY` 日志为准，外部探针可能被其他前台窗口抢走。
- 兼容性：配置未变，`windowTitle`（无 processNames）与其他工具的可见/最小化路径保持原 Win32 行为；`windowProcess` 目标保持原生恢复；无新增依赖/常驻进程。
- 发布状态：本地工作区修复，未提交/未推送；需要用户确认后按授权处理。
