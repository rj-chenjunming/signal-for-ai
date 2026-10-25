# SPEC-034：时间线跨年时间格式统一与 GoalsStore 定向查询

> 状态：done
> 类型：bugfix（显示一致性）+ refactor（数据访问）
> 需求来源：用户 2026-10-24 对上一轮差异的 UX 评审——问题 6「小的一致性漂移」被明确列为值得修订：a) 渲染层 `formatTime` 与主进程 `formatGoalTime` 两套实现、跨年显示不一致；b) `goals-inbox.ts` 的 `applyLine` 每行调用 `store.getView()` 做全量 `structuredClone`。
> 负责人：AI 协作（dreaming）
> 基线提交与环境：`5bddcf7`，Windows 10.0.26200 x64，Git Bash，Node v24.16.0；夹具验证运行时 Electron 31.7.7（`AITI_ELECTRON`，理由见 SPEC-031 §6 环境记录；store/收件箱切片为纯 vitest，与 Electron 无关）
> 需求依据及假设：`goals.ts:formatTime` 跨年只显示 `YYYY-MM-DD`（丢时间），主进程 `formatGoalTime`（goals-store.ts，导出链路在用）恒为 `YYYY-MM-DD HH:mm`；同一时刻在 UI 与导出的 Markdown 里呈现不同。假设：紧凑的同年格式 `MM/DD HH:mm` 保留，跨年补全时间即可——目标是消除"同一数据两种呈现"，不是统一成单一长格式。classic script 约束（禁 import）使两份实现必须并存，但算法必须一致并有测试钉住。
> 关联/替代条款：关联 SPEC-024（时间线/导出）；`formatGoalTime` 现有 vitest（goals-store.test.ts `describe('formatGoalTime')`）保持通过。

## 1. 问题与目标

1. 跨年时间线记录在窗口里显示 `2025-12-30`（无时间），导出 Markdown 显示 `2025-12-30 14:03`——信息量不一致；两份格式化实现无联动约束，已经漂移。
2. `drainGoalInbox` 的 `applyLine` 用 `store.getView().goals.find(...)` 匹配目标：每行一次全量深拷贝（结构化克隆整个目标数组）。1000 行收件箱 = 1000 次深拷贝；且用"取全量视图再过滤"表达"按 id/title 查一条"的意图，语义绕远。

目标行为：a) 渲染层跨年显示 `YYYY-MM-DD HH:mm`，与主进程格式化同构，两处算法都有测试钉住；b) `GoalsStore` 提供 `findGoal(id)` / `findGoalsByTitle(title)`（返回深拷贝，不暴露内部引用），`applyLine` 改用定向查询，行为与现状完全一致。

## 2. 范围与非目标

- 本次包含：`src/renderer/goals.ts` 的 `formatTime` 算法修正；`src/main/goals-store.ts` 新增两个查询方法；`src/main/goals-inbox.ts` 的 `applyLine` 改造；相应测试与 check:ui 夹具补跨年条目。
- 本次不包含：引入共享格式化模块（classic script 约束不支持跨层 import，见假设——两实现并存但测试钉住）；导出格式变化（`formatGoalTime` 已是目标形态）；时间线 UI 的相对时间（"3 分钟前"）等新展示特性。
- 受影响模块：上述三源文件 + `test/goals-store.test.ts`、`test/goals-inbox.test.ts`、`scripts/ui-render-check.cjs`（夹具与断言）。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | 时间线记录的 `at` 在跨年（与当前年份不同） | 渲染时间线 | 时间显示为 `YYYY-MM-DD HH:mm`（本地时区），与 `formatGoalTime` 输出一致 |
| AC-02 | 记录 `at` 与当前同年 | 渲染时间线 | 显示保持 `MM/DD HH:mm`（现状不变） |
| AC-03 | 任意时刻 t | `formatGoalTime(t)` | 输出 `YYYY-MM-DD HH:mm`（既有测试钉住，保持通过） |
| AC-04 | 存在 id 为 X 的目标 | `store.findGoal(X)` | 返回该目标的深拷贝；修改返回值不影响 store；id 不存在返回 `undefined` |
| AC-05 | 存在标题为 T 的 1..n 个目标 | `store.findGoalsByTitle(T)` | 返回全部匹配的深拷贝数组；无匹配返回空数组 |
| AC-06 | 收件箱含按 goalId 与按 title 的合法/非法行 | `drainGoalInbox` | 导入/丢弃结果与改造前完全一致（现有 goals-inbox 测试 + check:goals 收件箱段落保持通过） |

边界、异常、恢复/停止行为：`findGoalsByTitle` 不做去重/排序承诺（返回存储顺序）；深拷贝与 `getView()` 同级别（`structuredClone`），调用方修改副本不污染仓库——与"主进程是唯一数据源"约定一致。渲染层跨年判定与 `formatGoalTime` 一样使用本地时区。

## 4. 方案与任务切片

切片 1（AC-01/02，渲染层）：`formatTime` 跨年分支补 ` hh:mm`；check:ui 的 `goalsFixture` 追加一条跨年条目并断言渲染文本匹配 `^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$`。两处实现各加注释指向对方（"算法必须一致，测试在 …"）。

切片 2（AC-04~06，数据层）：`GoalsStore.findGoal(id)` / `findGoalsByTitle(title)`（内部复用 `structuredClone`）；`applyLine` 替换 `getView()` 过滤；现有 goals-inbox 全部测试为行为锚。

数据/IPC/配置影响：无。降级：查询方法返回副本失败不可能静默（structuredClone 异常会抛出并沿 applyLine 的 fail 路径落 `.failed.jsonl`，属可观测降级）。

## 5. 测试计划与追踪

| AC | 测试文件/完整用例名或真机步骤 | Red 证据 | Green 证据 | 回归/平台验收 |
| --- | --- | --- | --- | --- |
| AC-01 | `scripts/ui-render-check.cjs` checkGoals 跨年条目断言（固定 2025-10-19 14:03） | 已记录（见 §6） | 已记录 | 已记录 |
| AC-02 | 同上（同年条目保持 `MM/DD HH:mm`，由夹具既有 entry-time 断言与截图承载） | Red 不适用（行为锚：同年分支未改） | 已记录 | 已记录 |
| AC-03 | `test/goals-store.test.ts` `describe('formatGoalTime')`（既有） | 不适用（既有行为锚） | 全过 | 已记录 |
| AC-04 | `test/goals-store.test.ts` `GoalsStore.findGoal / findGoalsByTitle（SPEC-034）` 两个用例 | 已记录（见 §6） | 已记录 | 已记录 |
| AC-05 | 同上第二个用例 | 已记录（见 §6） | 已记录 | 已记录 |
| AC-06 | `test/goals-inbox.test.ts` 全量 + `scripts/goals-window-check.cjs` 收件箱段落 | 不适用（行为不变锚） | 全过（11 用例 + check:goals PASS） | 已记录 |
| 真机 | Windows：目标窗口含跨年记录，目视时间为 `YYYY-MM-DD HH:mm`；导出 Markdown 对比一致 | 未运行 | 未运行 | 未运行（保持 verifying） |

## 6. 执行记录

- 规格就绪依据、仍需澄清项：用户已授权；格式目标已定案（跨年补时间）。
- 修改前回归：typecheck 0、`npm test` 937/937、smoke 0（基线 `5bddcf7`）；无既有失败。
- **切片 2（store/收件箱）Red**（`npx vitest run test/goals-store.test.ts`，2 failed | 28 passed）：两个新用例分别以 `store.findGoal is not a function` / `store.findGoalsByTitle is not a function` 运行时失败（vitest 不做类型擦除后编译，属有效 Red，非编译错误）。
- **切片 2 Green**（新增公开查询 + applyLine 改造后）：`goals-store`/`goals-inbox`/`goals-export` 39/39 全过。**过程记录（TDD 抓住的设计错误）**：深拷贝版 `findGoal` 曾覆盖类内既有的同名 `private findGoal`（返回活引用，增删改方法靠它原地写），JS 后声明覆盖前声明 → "修改副本不影响仓库"用例当场失败。处置：内部方法改名 `findLiveGoal` 并加注释说明与对外深拷贝版本的语义边界，7 处内部调用点全部切换；该失败恰好验证了深拷贝测试的保护力。
- **切片 1（渲染层）Red**（`AITI_ELECTRON=<electron31> node scripts/check-ui.mjs`，退出码 1）：`SPEC-034 跨年时间格式与 formatGoalTime 不一致`。
- **切片 1 Green**（goals.ts formatTime 跨年分支补时间 + 两处实现互指注释后）：check:ui 35 用例全过（含跨年断言）、check:goals 全过。
- Refactor：无进一步必要（applyLine 查询语义已随切片 2 理顺）。
- TDD 例外：AC-02/AC-03/AC-06 Red 不适用（行为锚，理由见测试计划）。
- 真机验收（2026-10-25 用户确认）：同年记录显示 MM/DD HH:mm 正常；跨年无真实样本，以 check:ui 夹具（2025-10-19 14:03 断言）为准，不阻塞。goal-inbox 导入 1 条成功（日志 17:54:59）。
- 需求变更记录：无。

## 7. 交付与验收

- [x] 所有 AC 有验收证据（真机除外）；满足[流程 DoD](../development/spec-tdd.md) 的自动化部分。
- [x] 类型检查（0）、全量测试（939/939，退出码 0）、构建（0）、smoke（0）、check:ui（35 用例，0）、check:goals（0）已记录——**Electron 夹具部分验证运行时为 Electron 31.7.7**（store/收件箱切片为纯 vitest，不受影响）。
- [x] 相关文档、规格索引已更新；无秘密入库。
- [ ] 真机验收未完成 → 保持 `verifying`。

最终结果/提交引用：未提交（等待与 SPEC-031/032/033 一并检视）。
