# SPEC-015：WorkBuddy 恢复后可以正常关闭到后台

> 状态：done（2026-10-21 16:06 经 SPEC-020 补验最小化场景并获用户确认，恢复 done；原 done 证据保留）
> 类型：bugfix
> 需求来源：2026-10-21 用户反馈 WorkBuddy 也与此前 dsh 相同，恢复后不能关闭到后台。
> 负责人：Codex
> 基线：662f41b，工作区干净；Windows 10.0.26200 / Node24.16.0 / WorkBuddy5.8.3 / Electron33.4.11。
> 需求依据及假设：已安装 WorkBuddy 代码只读核对：requestSingleInstanceLock，second-instance 无文件/URL参数时 showOrCreateMainWindow。采用其自身入口修复窗口生命周期，不修改工具安装与个人数据。
> 关联/替代条款：沿用 SPEC-014 的身份受限原生恢复；替代其“WorkBuddy 继续 Win32”的分支。其他应用原行为不变。

## 1. 问题与目标

指示灯对 WorkBuddy 仍调用 ShowWindow，而 dsh 已证实这会使外部可见性与应用窗口状态不一致。用户明确给出 WorkBuddy 相同缺陷；只读进程检查显示 WorkBuddy 仍在运行、普通 MainWindowHandle 均为0。目标为通过指示灯恢复后 X 可正常隐藏到后台，保留任务与现有进程。

## 2. 范围与非目标

- 显式 windowProcess 且实际进程为 WorkBuddy 的窗口，走已安装 WorkBuddy 的单实例入口；隐藏查找仍受配置进程/标题与唯一主窗口条件限制。
- 可见窗口也走自身入口，修复先前系统强制显示留下的不一致状态。共享 dsh 已有身份受限脚本构建，应用身份只从内部固定白名单选择，不新增配置、参数或依赖。
- 恢复前校验 HWND/PID及已运行进程名称，读取同一进程可执行路径，文件名必须为 WorkBuddy.exe；客户端有退出超时，前台 HWND 确认后才成功。
- 失败/超时/归属变化/路径不可用/前台未确认时不回退 ShowWindow/AppActivate；保留明确失败及用户配置目录/日志降级。目标未运行不启动工具。
- 不改数据库/认证/安装文件，不结束工具进程或任务，不顺带修改 Codex；短暂“身份核对后原工具恰好退出”的第三方单实例竞争边界沿用 SPEC-014。无常驻查询进程/订阅。

## 3. 验收条件

| ID | Given | When | Then |
| --- | --- | --- | --- |
| AC-01 | WorkBuddy可见/隐藏且与配置匹配 | 图标/面板切回 | 同一真实可执行文件单实例恢复，不执行ShowWindow/AppActivate；原 HWND 前台确认后才成功。**SPEC-020 修订**：目标最小化（`IsIconic=true`）时，handoff 后允许一次 `SW_RESTORE` 兜底；隐藏窗口仍禁止 ShowWindow；命中配置 `processNames` 的 WorkBuddy 目标不要求 `terminal.type: windowProcess` |
| AC-02 | 缺窗口、查询异常、归属/路径验证失败、客户端超时/失败、前台未确认 | 请求恢复 | 明确失败或原配置降级，不假成功/误激活/强行显示/拉起未运行工具 |
| AC-03 | dsh或其他明确桌面目标 | 请求切回 | dsh保持自身恢复；非白名单仍保留Win32/PID保护 |
| AC-04 | 本机WorkBuddy已有主进程 | 新版图标恢复后点X，再查窗口/进程 | X隐藏到后台、原进程仍在、无客户端常驻；以原生操作或用户明确确认记录，不以mock替代。2026-10-21 16:06 用户确认最小化恢复后 X 回后台 |

## 4. 方案与任务切片

先在 FocusService 当前代码上加入 WorkBuddy 回归并实际得到目标断言 Red，再最小加入白名单原生恢复分支。抽取共享脚本构建保持 dsh 的脚本语义与 marker；拒绝未知应用身份和非法数字，防止扩大成任意启动器。新脚本 Windows 保护分支实际执行，正常客户端路径以真机指示灯验证。

## 5. 测试计划与追踪

| AC | 测试/验证 | Red | Green | 平台 |
| --- | --- | --- | --- | --- |
| AC-01/02 | test/workbuddy-native-reveal.test.ts，可见/隐藏/失败/超时/前台/缺窗口 | 6项断言失败见记录 | 11项通过；真实stale-owner保护执行 | 08:52:58自身恢复前台确认 |
| AC-03 | 原dsh/hidden/focus测试；非白名单PID保护 | 已有保护 | 相邻99项及最终824项通过 | 不扩大三工具矩阵 |
| AC-04 | 原配置启动，真实WorkBuddy恢复后关闭；只读进程元数据 | 用户缺陷依据 | 用户明确确认X可后台 | 原主PID15820仍在，HWND=0，无终止任务操作 |

## 6. 执行记录

规格依据为用户直接反馈及本机安装代码，无需重复审批；保留现有配置，未修改工具数据。类型检查→全量测试→构建→smoke 均需重新运行，不继承旧803项结论。暂不自动提交/推送，本次新的缺陷修复保留工作区。TDD例外：共享构建的纯重构由dsh既有保护验证，不编造Red。

## 7. 交付与验收

- 实现前 Red：`npm test -- test/workbuddy-native-reveal.test.ts --maxWorkers=2 --minWorkers=1`，01:24:49，6项失败/1项通过、exit1，`logs/spec015-red.log`。可见/隐藏目标仍执行系统显示、原生恢复失败与前台未确认时报告成功；为行为断言，非导入失败。
- Green：01:25:29，含dsh/hidden/focus六文件99项通过、exit0，`logs/spec015-green.log`。共享脚本抽取为静态应用白名单，保留dsh入口契约；SPEC-014的泛用Win32测试改用ExampleEditor，保留所有PID/ShowWindow断言，因为WorkBuddy已由本规格接管。后补未知身份拒绝及Windows真实stale-owner脚本保护。
- 最终typecheck、52文件814项测试（无跳过）、build、随后smoke全部exit0；日志`logs/spec015-{typecheck,full-test,build,smoke}.log`。差异空白检查exit0。
- 只读确认隐藏WorkBuddy主PID29664/HWND198210，版本5.8.3；已正常退出旧指示灯并用原配置启动新版，`logs/spec015-runtime.log`，未改工具数据库/认证或结束其任务。
- 原生桌面验收未执行：computer-use观察悬浮灯时自动审批服务返回使用额度限制、审核未完成，动作没有执行。不是判定操作不安全，也未通过替代通道绕过该动作。用户随后追加启动脚本需求；WorkBuddy恢复前台及X隐藏闭环仍待用户或恢复后的桌面能力验证。保持verifying，不将814项mock/回归冒充真机通过。
- 本次未自动提交/推送，指示灯保持运行；相关真机条件未通过前不标done。
- 08:48桌面读取恢复；随后打开已安装WorkBuddy准备补验收。一次自动点击未触发WorkBuddy请求，改用坐标后实际日志落在相邻Codex请求，未把这次误切算成WorkBuddy恢复成功；立即停止自动点击，并明确告知用户坐标偏差，改由用户确认。已发出“点击小猫切回后点X能否后台”的问题，仍待答复。当前WorkBuddy主PID15820/HWND67422，未关闭其任务或改数据；共享代码随SPEC-016最终824项回归通过。
- 验收补齐：用户明确回复“可以正常关闭到后台”，替代前条待答复状态。08:52:55.875真实WorkBuddy聚焦请求、08:52:58.334应用日志确认“WorkBuddy 自身恢复成功，前台 HWND 已确认”；随后只读核对原主PID15820仍为WorkBuddy、MainWindowHandle=0，X确实隐藏窗口而非退出主进程。没有把自动误切记作成功。AC-04得到真实应用日志＋用户关闭确认＋元数据佐证，本规格标done，其他Spec的平台矩阵不扩大。

> **2026-10-21 追加（原 done 结论；现因最小化盲区退回 verifying）**：在 SPEC-014 的真机验收中发现，dsh 窗口**最小化**后点图标/面板无法恢复。`workbuddy` 与 `dsh` 共用 `focus.ts` 的 `revealNativeWindow()` 分支、共用 `native-window-reveal.ts` 的单实例 handoff 脚本，该脚本**没有任何 `IsIconic`/`ShowWindow(SW_RESTORE)` 兜底**。因此本规格的 done 只覆盖「X 隐藏 → 恢复」，**最小化场景属于当时未纳入验收的盲区**，同一缺陷在 WorkBuddy 上应视为存在，需随修复规格一并复验。根因与修复方向见 [SPEC-014 的 2026-10-21 记录](014-dsh-native-window-reveal.md)。

### 2026-10-21 15:21 盲区修复与复验（SPEC-020）

- 修复：[SPEC-020](020-window-reveal-hidden-minimized.md) 给共享的 `buildNativeWindowRevealScript` 增加 handoff 后 `IsIconic` 守卫下的 `SW_RESTORE`；`windowProcess` 的 WorkBuddy 保持该原生恢复，`windowTitle`＋`processNames` 只有**隐藏候选**才走原生（可见/最小化继续 Win32，避免可见窗口前台回归）。
- 真机（`logs/spec020-real-verify.log`）：WorkBuddy 最小化（`IsIconic=true`）→ `focusTerminal(workbuddy)` 返回 `ok:true`，日志 `WorkBuddy 自身恢复成功，前台 HWND 已确认`，窗口 `Visible=true`、`Iconic=false`；结束后恢复为最小化。独立探针可能被远端桌面/微信抢焦点，不作为产品失败。
- 逻辑层：`test/workbuddy-native-reveal.test.ts` 12/12（含最小化 restore 用例）、`test/focus-hidden-window.test.ts` 覆盖 hidden windowTitle 身份路由与可见窗口回归；全量 852 项、typecheck/build/smoke 全绿。
- 状态仍为 `verifying`：最小化恢复已真机通过，但“恢复后再点 X 能隐藏到后台”需要用户在修复后的指示灯上确认一次；确认后按 DoD 收状。

### 2026-10-21 16:06 用户真机确认（收口）

- 用户确认 WorkBuddy 最小化后点悬浮灯小猫图标可恢复前台，随后点 X 仍能隐藏到后台，回复“两项都正常（恢复 + X 后台）”。
- 结合此前 X 隐藏恢复、最小化真机、隔离夹具与全量 852 项证据，AC-01～AC-04 均满足；本规格恢复为 `done`。

### 2026-10-21 15:58 隔离 Electron 夹具端到端补验（不触碰真实 WorkBuddy）

- 用真实 Electron 进程（临时硬链接 `WorkBuddy.exe`、独立 userData、唯一标题 `LampSpec020Fixture`、close→hide、second-instance→show/focus）模拟 WorkBuddy 生命周期，进程名/可执行文件名与生产白名单一致。
- 自隐藏后 `FocusService`（windowTitle＋processNames）→ 隐藏窗口查到 → 单实例 handoff → 日志 `WorkBuddy 自身恢复成功，前台 HWND 已确认`，结果 `ok:true`、窗口恢复；再最小化 → Win32 恢复。`logs/spec020-fixture-hidden-verify.log`，`SUMMARY failures=0`。
- 真实 WorkBuddy 进程/数据未被触碰。状态保持 `verifying`：最终仍以用户在真实 WorkBuddy 上的 X/最小化点击确认为准。
