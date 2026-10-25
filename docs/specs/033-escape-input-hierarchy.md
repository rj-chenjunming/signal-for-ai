# SPEC-033：目标窗口输入框内的 Escape 不再隐藏窗口

> 状态：done
> 类型：bugfix（交互/键盘层级）
> 需求来源：用户 2026-10-24 对上一轮差异的 UX 评审——问题 5「Escape 在输入框打字时也会隐藏整个窗口」被明确列为值得修订。
> 负责人：AI 协作（dreaming）
> 基线提交与环境：`5bddcf7`，Windows 10.0.26200 x64，Git Bash，Node v24.16.0；夹具验证运行时 Electron 31.7.7（`AITI_ELECTRON`，理由见 SPEC-031 §6 环境记录）
> 需求依据及假设：goals.ts 的 document 级 keydown 处理对所有 Escape 一律 `hideGoals()`；输入框（时间线草稿、新增目标草稿）不消费 Escape，用户想"取消当前输入"却把整个窗口藏了。假设：非破坏性语义（失焦保留文字）优于清空——草稿是用户劳动，窗口隐藏本身无破坏，Esc 的收益是"退出输入焦点"而非"丢弃内容"。
> 关联/替代条款：关联 SPEC-024（Esc 隐藏窗口的原验收 AC-19 语义保持：焦点不在输入框时 Esc 仍隐藏）；标题编辑的 Esc 取消（还原旧标题）为既有行为，本规格保留。

## 1. 问题与目标

现状：焦点在 `#goal-input`（新增目标）或 `.entry-input`（时间线草稿）内按 Escape，事件冒泡到 document 处理器直接 `hideGoals()`，窗口隐藏；用户草稿虽在（重开后仍在），但被打断。标题编辑框已有独立 Escape 分支（先于隐藏判断），不受影响。

目标行为（键盘层级，由内向外）：

1. 标题编辑框内 Esc → 退出编辑（现状保留）；
2. 其它文本输入框内 Esc → 输入框失焦、**窗口不隐藏、文字不清空**；
3. 焦点不在输入框时 Esc → 隐藏窗口（现状保留）。

## 2. 范围与非目标

- 本次包含：`src/renderer/goals.ts` document keydown 处理的目标元素判定。
- 本次不包含：清空输入的"取消草稿"语义（显式否决，见假设）；`#btn-close`、托盘、`✕` 关闭路径；进度滑杆的 Esc（同属输入控件，一并纳入失焦分支，属同一层级的自然覆盖）。
- 受影响模块：渲染层单文件；`scripts/goals-window-check.cjs` 补充集成断言。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | 时间线输入框有草稿且焦点在内 | 按 Escape | 窗口保持可见，输入框失焦，草稿文字保留 |
| AC-02 | 新增目标输入框有草稿且焦点在内 | 按 Escape | 同 AC-01 |
| AC-03 | 焦点在任何文本输入框内 | 按 Escape | 事件不触发 `hideGoals` |
| AC-04 | 焦点不在任何输入框（body） | 按 Escape | 窗口隐藏（SPEC-024/AC-19 语义不变） |
| AC-05 | 标题编辑框处于编辑态 | 按 Escape | 退出编辑、不隐藏窗口（现状保留，防回归） |

边界、异常、恢复/停止行为：输入框已失焦但仍是 `document.activeElement` 为 body 的常规路径之外，若焦点落在非输入控件（按钮等）上按 Esc，视为"不在输入框"→ 隐藏窗口（与现状一致）；隐藏后重开，草稿仍在（窗口只隐藏不销毁，现状保留）。

## 4. 方案与任务切片

keydown 处理器在 `editingGoalId` 分支后增加：`event.target instanceof HTMLInputElement || HTMLTextAreaElement` → `target.blur()` + `preventDefault()` + return（不隐藏）。单切片实现，无数据/IPC 影响。

## 5. 测试计划与追踪

| AC | 测试文件/完整用例名或真机步骤 | Red 证据 | Green 证据 | 回归/平台验收 |
| --- | --- | --- | --- | --- |
| AC-01 | `scripts/goals-window-check.cjs` SPEC-033 段落（真实窗口，keydown target=entry 输入框） | 已记录（见 §6） | 已记录 | 已记录 |
| AC-02 | 同段落（target=#goal-input） | 已记录（见 §6） | 已记录 | 已记录 |
| AC-03 | 同段落（断言不触发 hideGoals，由 AC-01/02 的 isVisible 承载） | 已记录（见 §6） | 已记录 | 已记录 |
| AC-04 | 同段落末尾（target=body，Esc 隐藏窗口）+ 既有 "Esc 隐藏窗口" 段落 | Red 不适用（行为锚：既有语义防回退） | 已记录 | 已记录 |
| AC-05 | 同段落（标题编辑器内 Esc） | 已记录（见 §6；Red 同时暴露既有缺陷：旧实现标题编辑 Esc 也会隐藏窗口） | 已记录 | 已记录 |
| 真机 | Windows：时间线打字→Esc→窗口不藏、焦点退出；再 Esc→窗口藏 | 未运行 | 未运行 | 未运行（保持 verifying） |

## 6. 执行记录

- 规格就绪依据、仍需澄清项：用户已授权；"失焦保留 vs 清空"已按非破坏性语义定案并记录于假设。
- 修改前回归：typecheck 0、`npm test` 937/937、smoke 0（基线 `5bddcf7`）；无既有失败。
- **切片 Red**（`AITI_ELECTRON=<electron31> node scripts/check-goals.mjs`，退出码 1）：`SPEC-033/AC-01 输入框内 Esc 隐藏了窗口`；同一步骤还暴露既有缺陷 AC-05——标题编辑框的 Esc 由编辑器监听器处理后冒泡到 document 的 hideGoals 分支，**旧实现同样会隐藏窗口**（模板阶段未识别，Red 阶段抓到）。
- **切片 Green**（goals.ts document keydown 增加"文本输入框 → blur"分支后重建，退出码 0）：check:goals 全过（AC-01/02/04/05；AC-03 由 AC-01/02 的 isVisible 断言承载）。
- Refactor：无必要（单分支改动）。
- TDD 例外：AC-04 Red 不适用（既有行为锚）。
- 真机验收（2026-10-25 用户确认）：输入框内 Esc 只失焦保草稿、焦点在外 Esc 隐藏窗口，两段式通过。
- 需求变更记录：无。

## 7. 交付与验收

- [x] 所有 AC 有验收证据（真机除外）；满足[流程 DoD](../development/spec-tdd.md) 的自动化部分。
- [x] 类型检查（0）、全量测试（939/939，退出码 0）、构建（0）、smoke（0）、check:goals（0）已记录——**验证运行时为 Electron 31.7.7**。
- [x] 相关文档（README 窗口语义）、规格索引已更新；无秘密入库。
- [ ] 真机验收未完成 → 保持 `verifying`。

最终结果/提交引用：未提交（等待与 SPEC-031/032/034 一并检视）。
