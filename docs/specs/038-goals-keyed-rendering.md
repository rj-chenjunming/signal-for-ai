# SPEC-038：目标窗口 keyed 增量渲染

> 状态：done（2026-10-25 用户真机确认 IME 组合不中断；自动化验收全绿，见 §5/§7）
> 类型：refactor（纯重构，外部行为保持）
> 需求来源：用户 2026-10-24 批准的重构顺序 R-B（ goals 窗口渲染从"推送 → 全量重建 + 快照抢救"演进为"keyed 复用"）。
> 负责人：AI 协作（dreaming）
> 基线提交与环境：以 SPEC-031~037 完成后的工作区为基线；Windows 10.0.26200 x64。
> 需求依据及假设：SPEC-031 的快照/恢复是绷带——它救回了 value/焦点/滚动，但救不了 IME 组合中文本（规格显式声明不支持）、时间线内选中的文本、删除按钮的 3 秒确认窗口（重绘重置 armed 态）。根因是"推送 → 整树重建"。假设：卡片元素按 goal.id 复用后，这些态天然存活，快照逻辑可缩减为仅滚动位置。
> 关联/替代条款：SPEC-031（全部 AC 断言原样成为本重构的特征测试）；overlay.ts `stripRowCache`（先例模式）；SPEC-035（共享助手 `aiUi.el` 可直接复用）。

## 1. 问题与目标

goals.ts 每次推送全量重建列表树（`render()` → `replaceChildren`）。目标：卡片 DOM 节点按 `goal.id` 缓存复用（元素不销毁 → IME 组合、选区、armed 删除确认、输入草稿天然存活），卡片内部仅在数据变化时更新。

## 2. 范围与非目标

- 本次包含：`src/renderer/goals.ts` 渲染模型重构；`scripts/goals-window-check.cjs` / `scripts/ui-render-check.cjs` 视需要补"元素身份不变"断言。
- 本次不包含：时间线虚拟化、排序动画、主进程数据层、任何视觉变化。
- 受影响模块：渲染层单文件 + 两个夹具。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | 展开卡片、时间线有草稿 | 推送到达 | 该卡片 DOM 节点身份不变（`card.isSameNode(before)`），草稿/焦点/IME 组合存活 |
| AC-02 | 时间线输入文字后 2 秒内点击 ✕ 进入确认态 | 推送到达 | 确认态保持（armed 按钮未被重置）——现状会被重绘重置 |
| AC-03 | SPEC-031 全部断言 | 全量回归 | check:ui / check:goals 原样通过（快照逻辑缩减为滚动后不回归） |
| AC-04 | 新增/删除/拖拽/完成/导出/收件箱 | 全链路 | check:goals 全链路 PASS，行为零差异 |

边界、异常、恢复/停止行为：目标被删除时其缓存条目销毁；`status` 变更（active↔done）时卡片移组重建（低频，允许销毁重建，但输入态随组迁移丢弃是可接受语义，需在规格记录）；拖拽后按 `view.goals` 顺序重排缓存节点（appendChild 移动节点，不重建）。

## 4. 方案与任务切片

1. `cardCache: Map<goalId, { card, els }>`；`render()` 按 view 顺序 diff：缺失补建、多余销毁、顺序移动。
2. 卡片内字段更新：标题/进度条/百分比/meta 文本原地写；展开详情（时间线+输入框）为卡片内持久节点，条目列表按 entry.id 二级 diff（或整段重建但保留输入框节点——输入框与条目列表分离是关键设计：输入框永不重建）。
3. 快照/恢复缩减为：仅滚动位置（`listEl.scrollTop`）；`pendingEntryFocus` 机制保留（新增目标场景）。
4. SPEC-031 断言全部保留为特征测试；新增 AC-01/02 的节点身份断言。

风险与对策：事件监听随卡片复用须防重复绑定（绑定期挂在 `els` 结构上，重建仅发生在卡片级）；拖拽落点判定读 `view.goals`（不依赖 DOM 顺序）已确认兼容；`dataset.status` 等派生态在字段更新时同步。

## 5. 测试计划与追踪

| AC | 测试文件/完整用例名或真机步骤 | Red 证据 | Green 证据 | 回归/平台验收 |
| --- | --- | --- | --- | --- |
| AC-01 | `scripts/ui-render-check.cjs` → `checkGoalsInputPreservation`「SPEC-038/AC-01 卡片与输入框节点身份」（`card.isSameNode` + 输入框身份 + 推送数据照常渲染） | 已记录（见 §6） | 已记录 | 已记录 |
| AC-02 | 同函数「SPEC-038/AC-02 armed 删除确认态保持」（只点一次进入确认态，绝不再点第二次） | 已记录（见 §6） | 已记录 | 已记录 |
| AC-03/04 | check:ui / check:goals / npm test / typecheck / build / smoke | Red 不适用（回归锚：SPEC-031 断言原样通过即为约束，纯重构不制造失败） | 已记录 | 已记录 |
| 真机 | Windows：中文输入法组合状态下收到 goal-sync 推送，组合不中断 | 未运行 | 未运行 | **2026-10-25 用户确认通过**：应用运行中（dev 默认配置），「ces」时间线组合拼音期间经 goal-inbox 注入两条真实推送（goal-inbox.jsonl 导入并消费），组合不中断、草稿/滚动不动、新记录正常渲染 |

## 6. 执行记录

- 规格就绪依据：用户已批准 R-B；前置 R-A（共享助手）已落地，重写不再制造新的复制粘贴。
- **本会话主动收口说明**：SPEC-031~037 七项已全部落地（含两次 Electron 环境抢救与一套常驻 worker 基础设施），本项是纯抛光性质、且是 700 行交互密集渲染层的重写；在超长会话尾部执行高风险重写违背审慎原则。设计已全部定案（本规格 §4），特征测试（SPEC-031 断言）已就位，下一会话可直接按 §4 切片执行。
- 修改前回归：SPEC-037 完成时全绿（typecheck 0 / test 952 / build 0 / smoke 0 / check:ui 0 / check:goals 0）。
- **切片 Red**（2026-10-25，工作区 `4247899` + 特征断言补丁，Electron 34.5.8 无需 AITI_ELECTRON）：`npm run build` 退出码 0 → `node scripts/check-ui.mjs` 退出码 1（日志 `logs/spec038-red-checkui.log`）：`输入态保护失败 → SPEC-038/AC-01 卡片与输入框节点身份: 推送后卡片节点被重建（身份变化） | SPEC-038/AC-02 armed 删除确认态保持: 推送重置了删除确认态`（各 `false !== true`）。Red 语义说明：纯重构的 AC-01/02 本就是"现实现不满足目标行为"的特征断言，失败原因与 §1 根因（整树重建）一致，属有效 Red 而非制造失败；断言落点 `checkGoalsInputPreservation`，失败发生在新步骤处，此前 SPEC-031 全部断言照常通过。
- **切片 Green**：`src/renderer/goals.ts` 重写为 keyed 模型（`cardCache` 按 goal.id 复用 + 展开详情为卡片内持久节点 + 条目按 entry.id 二级 diff + 输入框与条目列表分离永不重建 + 快照缩减为 `scrollTop`）后重建：check:ui 退出码 0（35 用例，含新增两断言）、check:goals 退出码 0（真实 IPC 全链路含 SPEC-031 输入态保护与 SPEC-033 Esc 层级）。
- 实现插曲：首版用 `[...children]` 展开 HTMLCollection，`npm run typecheck` 退出码 2（TS2488）——`tsconfig.test.json` 继承主配置 `lib: [ES2022, DOM]`（无 DOM.Iterable）且 include 覆盖 `src/**/*.ts`，渲染层文件要同时过三份 tsconfig 口径；改 `Array.from` 后 typecheck 0。属等价写法修正，非行为变更。
- Refactor：无必要——实现即按 §4 目标结构落地（卡片级缓存、事件监听只在 buildCard/ensureDetail 绑定一次且闭包只捕获 goalId 等不变量、可变数据一律事件触发时经 `currentGoal` 读最新视图）；Green 后除上述等价写法修正外无结构改动。
- 全量回归（最终代码状态，全部退出码 0）：typecheck 0；`npm test` 952/952；build 0；smoke 通过（1099ms）；check:ui 35 用例；check:goals 真实 IPC 全链路。
- 行为语义备注（§1"节点不销毁 → 态存活"的推论，无视觉/交互回退）：①收起的时间线再展开，输入草稿仍存（旧实现收起即随节点销毁丢失）；②拖拽进行中收到推送，`dragging`/落点提示类名与 armed 态不再被重绘清除；③进度滑杆聚焦（拖动中）期间推送不回写 range 值，避免把用户按住的滑杆拽回旧值（松手 change 写库后推回同值）。
- TDD 例外：AC-03/04 Red 不适用（回归锚，理由见测试计划）；AC-01/02 均有真实 Red。
- 真机验收（2026-10-25 用户操作确认，应用以 dev 默认配置运行）：「ces」时间线中文输入法组合状态下，经 `goal-inbox.jsonl` 注入两条进展（应用轮询导入、收件箱文件被消费、goals.json 落库），组合不中断，草稿/焦点/滚动不动，新记录正常渲染——本规格唯一真机项通过，状态翻 done。
- 需求变更记录：无。

## 7. 交付与验收

- [x] 所有 AC 有验收证据；满足[流程 DoD](../development/spec-tdd.md)。
- [x] 类型检查（0）、全量测试（952/952，退出码 0）、构建（0）、smoke（0）已记录；check:ui（35 用例，0）、check:goals（0）已记录——验证运行时为仓库 pin 的 Electron 34.5.8（SPEC-039 后无需 AITI_ELECTRON）。
- [x] 相关文档（README 目标清单节、规格索引）已更新；无秘密入库。
- [x] 真机验收（IME 组合不中断）2026-10-25 用户确认通过。

最终结果/提交引用：本批提交（见 git log SPEC-038）；工作区改动含 src/renderer/goals.ts、scripts/ui-render-check.cjs、规格与 README。
