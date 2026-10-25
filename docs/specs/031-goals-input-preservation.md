# SPEC-031：目标窗口输入态在数据推送下不被破坏

> 状态：done
> 类型：bugfix（交互/渲染）
> 需求来源：用户 2026-10-24 对上一轮差异的 UX 评审——问题 1「目标窗口的全量重绘会吃掉用户的输入态」被明确列为值得修订。
> 负责人：AI 协作（dreaming）
> 基线提交与环境：`5bddcf7`（origin/main fast-forward 后），Windows 10.0.26200 x64，Git Bash，Node v24.16.0；夹具验证运行时 Electron 31.7.7（`AITI_ELECTRON`，理由见 §6 环境记录）
> 需求依据及假设：用户已明确要求修订，无需再次批准。假设：目标窗口的"备忘录"定位（goals-window.ts 头注释）意味着未提交的草稿比即时刷新更珍贵；推送频率受 goal-sync 1 秒轮询影响，正在输入时收到推送是常态而非异常。
> 关联/替代条款：关联 SPEC-024（目标清单窗口）、SPEC-026（拖拽排序的 dragstart 态不在本规格范围）；不改变 SPEC-025 悬浮灯行为。

## 1. 问题与目标

`src/renderer/goals.ts` 的 `render()` 在每次收到主进程推送（`onGoals`）时用 `listEl.replaceChildren()` 全量重建列表。目标窗口是常开的备忘录式窗口，推送来源包括：`goal-sync` 收件箱约 1 秒轮询导入、其它窗口的进度/标题/完成操作、删除操作。重建导致三类输入态丢失：

1. 时间线输入框（`.entry-input`）里已键入、未提交的文字被清空；
2. 标题编辑框（`.goal-title-input`）里未提交的修改被重置为旧标题（`createTitleEditor` 总是用 `goal.title` 初始化）；
3. 列表滚动位置跳回顶部（`#goals-list` 是滚动容器，replaceChildren 期间内容高度归零）。

另一个连带缺陷：提交记录时推送先于 invoke 结果到达（现有 `pendingEntryFocus` 注释已确认该时序），失败路径上输入文字会被推送重绘清空——用户想重试却没有原文。

目标行为：数据推送照常反映最新数据，但不破坏任何未提交的用户输入与滚动位置；提交失败时草稿保留。

## 2. 范围与非目标

- 本次包含：`src/renderer/goals.ts` 渲染循环的输入态快照/恢复；`createTitleEditor` 支持草稿初值；提交后清空输入改为作用于"当前 DOM 中该目标的输入框"而非捕获的旧节点。
- 本次不包含：keyed 增量 diff 渲染（列为备选取舍，见 §4）；悬浮灯/面板渲染；主进程数据层；拖拽排序视觉；焦点以外的选区还原精度（IME 组合态显式不支持，见边界）。
- 受影响模块：`src/renderer/goals.ts`；测试基建 `scripts/ui-render-check.cjs`、`scripts/ui-render-preload.cjs`（补充可控的 `onGoals` 推送通道）。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | 目标窗口已展开某目标，时间线输入框内有未提交文字且焦点在其中 | 主进程推送一份新的 GoalsView | 输入框文字原样保留，焦点仍在该输入框，光标位置不变；推送带来的其它数据变化正常渲染 |
| AC-02 | 标题编辑框处于编辑态且已修改未提交 | 收到推送 | 编辑框保留用户草稿（不回退为旧标题），焦点与光标保留；Esc/失焦提交流程不变 |
| AC-03 | 列表已滚动到中部（scrollTop > 0） | 收到一份内容不变的推送 | `#goals-list` 的 scrollTop 恢复到推送前的值 |
| AC-04 | 时间线输入框有草稿，提交动作返回 `ok:false` 且伴随一次推送 | 提交失败 | 输入框草稿保留（现状：被重绘清空），错误 toast 照常显示 |
| AC-05 | 时间线输入框有草稿，提交成功且推送先于 invoke 结果到达 | 提交流程完成 | 当前 DOM 中该目标的输入框被清空、焦点按 pendingEntryFocus 恢复；不会出现"已提交文字又回到输入框" |

边界、异常、恢复/停止行为：推送使某目标被删除时，该目标输入框的草稿随之丢弃（目标已不存在，无可保留载体），其余目标的输入态不受影响；窗口隐藏（`hideGoals`）期间到达的推送走同一渲染路径，恢复显示时同样满足 AC-01~03；IME 组合中的文字属于浏览器内部状态，本规格只保证 composition 结束后的 value，不承诺组合中断点复原。空草稿（value 为空）与无焦点是 AC-01 的退化情形，行为与现状一致。

## 4. 方案与任务切片

最小方案（渲染层单文件改动）：

1. `render()` 重绘前调用 `snapshotInteraction()`：收集 `scrollTop`、各 `.entry-input` 的非空 value（按 goalId 键）、标题编辑草稿（若 `editingGoalId`）、焦点元素的角色/goalId/选区。
2. 先在 detached 容器里构建新树，`replaceChildren(fragment)` 一次性换入，随后按快照恢复 value、scrollTop、焦点与选区；`createTitleEditor(goal, draft?)` 增加可选草稿初值。
3. `renderEntryAdd` 提交成功的清理改为按 `data-entry-input` 查询当前 DOM 中的输入框清空（覆盖 AC-05 的两种时序）。

备选取舍：keyed 增量更新（复用 overlay `stripRowCache` 模式）能根治但需重写卡片内 8 类交互节点的原地更新逻辑，风险与体量不成比例；本规格先以"快照/恢复"保住输入态，keyed 化留待后续重构规格评估。

数据/IPC/配置影响：无。降级策略：快照恢复全部是尽力而为的 DOM 操作，任何一步失败不阻断数据渲染本身。

## 5. 测试计划与追踪

| AC | 测试文件/完整用例名或真机步骤 | Red 证据 | Green 证据 | 回归/平台验收 |
| --- | --- | --- | --- | --- |
| AC-01 | `scripts/ui-render-check.cjs` → `checkGoalsInputPreservation` AC-01 步骤 | 已记录（见 §6） | 已记录 | 已记录 |
| AC-02 | 同上 AC-02 步骤 | 已记录（见 §6） | 已记录 | 已记录 |
| AC-03 | 同上 AC-03 步骤 | Red 不适用（回归锚：Chromium scroll anchoring 在旧实现下已保滚动，断言用于约束新实现不得倒退） | 已记录 | 已记录 |
| AC-04 | 同上 AC-04 步骤（夹具 `addGoalEntry` 失败并伴随推送） | 已记录（见 §6） | 已记录 | 已记录 |
| AC-05 | `scripts/goals-window-check.cjs`「提交后输入框清空且焦点恢复」 | Red 不适用（回归锚：保护新快照逻辑不得把已提交文字"复活"回输入框） | 已记录 | 已记录 |
| 全链路回归 | `npm run check:goals`、`npm run check:ui` 原有用例 | 未运行（Red 只跑新增切片） | 退出码 0，全过 | 已记录 |
| 真机 | Windows：打开目标窗口→时间线输入半句→`goal-sync` 写入收件箱→确认文字/滚动不动；提交失败重试不丢字 | 未运行 | 未运行 | 未运行（保持 verifying） |

## 6. 执行记录

- 规格就绪依据、仍需澄清项：用户已明确授权修订；无未知项。
- **环境记录（影响本轮全部四份规格）**：仓库 pin 的 Electron 33.4.11 在本机初始化即崩溃——`electron.exe` 退出 0xC0000005（读 0x8 空指针，崩溃点在 electron.exe 模块内，转储仅加载 50 个模块；`--version` 正常）。逐项排除：dist 与 2026-10-21 缓存 zip 哈希一致（`logs/check-electron-runtime.cjs`）、AppCompat 垫片注册表无 electron 项、交互会话（session 12）正常、无 NODE_OPTIONS/ELECTRON_* 污染、`--no-sandbox`/`--single-process`/`--disable-crashpad`/`--disable-features=RendererCodeIntegrity` 均无效；**Electron 31.7.7 同机同参正常**（2026-10-20 23:22 已有同款崩溃转储，2026-10-21 09:24 应用尚能正常运行）。夹具验证改用 `AITI_ELECTRON` 指向 31.7.7，证据已在规格中注明验证运行时；另：`check-ui.mjs`/`check-goals.mjs` 补 `--no-sandbox`（沙箱问题先于主问题暴露，对 31 无影响但保留）、`goals-window-check.cjs` 失败路径改用 `app.exit(process.exitCode)`（原 `app.quit()` 会把断言失败吞成退出码 0）。2026-10-21 之后本机应用日志为空，用户侧应用可能同样受此影响。
  **→ 2026-10-25 修正（SPEC-039）**：本段的"33 版本有问题"结论**不成立**。真实根因是仓库根目录 ACL 被沙箱工具写入毒性条目（Everyone DENY Delete-Child + 低完整性标签），任何版本的 Electron 在该目录内沙箱初始化都崩；31 当时"正常"只因在 /tmp 测试。ACL 已解毒（备份 `C:\Users\chen\PRJ\acl-aisignal-backup.txt`），夹具已回归 pin 版 34.5.8。
- 修改前回归（基线 `5bddcf7`，Electron 夹具改用 31.7.7 前 typecheck/test/smoke 已在 33 无关路径跑通）：typecheck 退出码 0；`npm test` 937/937 退出码 0；smoke 退出码 0。无既有失败。
- **切片 Red**（`AITI_ELECTRON=<electron31> node scripts/check-ui.mjs`，退出码 1）：`输入态保护失败 → AC-01 时间线草稿/焦点/光标: 草稿被推送清空 | AC-02 标题编辑草稿: 标题草稿被重置为旧标题 | AC-04 提交失败伴随推送时草稿保留: 失败后草稿被清空`（AC-03 未失败，按回归锚处理）。同日 `node scripts/check-goals.mjs`（退出码 1）：`SPEC-031/AC-01 草稿被推送清空`（真实 IPC 推送）。
- **切片 Green**（实现 goals.ts 快照/恢复后重建，两脚本均退出码 0）：check:ui 35 用例全过（含 checkGoalsInputPreservation light/dark）；check:goals 全过（含 SPEC-031 段落：草稿/焦点/光标/滚动保留 + AC-05 提交后清空且焦点恢复）。
- 测试自身修订记录：AC-01 的"推送数据渲染"断言最初落在**未展开**的 g2 上（未展开卡片的时间线本就不在 DOM），修正为已展开的 g1——属测试错误修正，实现未迁就。
- Refactor：无必要（快照/恢复内聚于 `captureInteraction`/`restoreInteraction` 两函数）。
- TDD 例外：AC-03、AC-05 Red 不适用（回归锚，理由见测试计划）；其余 AC 均有真实 Red。
- 真机验收（2026-10-25 用户操作确认）：目标「ces」输入草稿期间经 goal-inbox 注入推送（日志 17:54:59 导入 1 条），草稿/焦点保留、新记录正常渲染；Esc 隐藏后重开内容仍在。
- 需求变更记录：无。

## 7. 交付与验收

- [x] 所有 AC 有验收证据（真机除外）；满足[流程 DoD](../development/spec-tdd.md) 的自动化部分。
- [x] 类型检查（0）、全量测试（939/939，退出码 0）、构建（0）、smoke（0）已记录；check:ui（35 用例，0）、check:goals（0）已记录——**验证运行时为 Electron 31.7.7，非仓库 pin 的 33.4.11**。
- [x] 相关文档（README 目标清单节、testing.md 夹具说明）、规格索引已更新；无秘密入库。
- [ ] 真机验收（见测试计划末行）与 Electron 33 运行时复核未完成 → 保持 `verifying`。

最终结果/提交引用：未提交（等待与 SPEC-032~034 一并由维护者检视）；工作区状态见 `git status`。
