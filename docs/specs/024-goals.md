# SPEC-024：目标清单（独立窗口 + 进度 + 时间线 + 导出）

> 状态：done
> 类型：feature
> 需求来源：用户 2026-10-22 会话确认——「应用自己的简易待办清单」；后续澄清为「独立清单，类似备忘录；长期目标（例如开发本项目），含问题记录与完成情况；可以新增、删除；一键导出全部记录」；窗口形态经并排 mockup 确认为 A（独立窗口）。
> 负责人：lead + 开发者
> 基线提交：`4d56980`（SPEC-023），工作区另含未跟踪的 `docs/research/` 调研笔记与 mockup，本规格不改动它们。
> 需求依据及假设：用户已明确「目标形式」「时间线追加」「导出」，不需要再次确认。导出格式假设为 **Markdown**（可读、可直接贴周报/归档）；JSON 备份/导入不在本规格。窗口位置不持久化（见非目标）。周视图/周 KR 已明确不做。
> 关联/替代条款：替换[规格索引](../README.md)「下一轮候选」中的「简单 todo 功能」描述；不改变 BASELINE-000 的状态机与可见性约束。

## 1. 问题与目标

当前应用只有 AI 任务状态（七态灯带 + 任务面板），没有记录用户自己目标的地方。用户需要一张长期可用的「目标备忘录」：每条目标有标题、手动进度、状态（进行中/已完成），下面是一条只追加的时间线，用来记录进展与问题；全部内容可一键导出。

目标行为：新增/删除目标、编辑标题、拉进度、追加进展/问题记录、标记完成、重启后恢复、损坏时可见告警、一键导出 Markdown。它与 AI 任务状态机互不影响。

## 2. 范围与非目标

- 本次包含：
  - 独立的「目标」窗口（560×640、无边框、置顶、失焦不隐藏；可从托盘菜单与任务面板打开）。
  - 目标 CRUD：新增、删除（二次确认）、标题就地编辑。
  - 手动进度 0–100%（步进 5），完成状态（进度置 100、`completedAt`、自动完成记录）。
  - 时间线：追加「进展 / 问题」记录（带时间戳），条目可删除（二次确认）。
  - 持久化：`userData/goals.json`（`version: 1`），tmp+rename 原子写、300ms 防抖、退出 flush、损坏隔离与 `.bak` 恢复。
  - 导出：一键把全部目标与记录导出为 Markdown 文件（系统保存对话框）。
  - IPC 白名单通道与参数校验；`preload` 暴露最小 API。
  - 单元测试、类型检查、全量回归、构建 + smoke、面板/窗口相关 Windows 真机验收。
- 本次不包含：
  - 周 KR / 周视图 / 按周归档；目标分类、标签、优先级、截止日期。
  - 子任务、自动进度计算、提醒/通知、云同步、多设备、跨进程并发编辑。
  - 拖拽排序、富文本/图片/附件、全文搜索。
  - JSON 导入/导出（后续可另建规格）。
  - 窗口位置/大小持久化（每次打开使用默认位置；用户移动后不记忆）。
  - 任何 `TaskStore` 状态机、`visibility.ts`、监控器、通知、跳转、配置 schema 的改动。
- 受影响模块/接口/用户文档：
  - 新增 `src/main/goals-store.ts`、`src/main/goals-window.ts`、`src/main/goals-export.ts`（可合并到 store，见 §4）。
  - `src/shared/types.ts`、`src/shared/ipc-contract.ts`、`src/preload/preload.ts`、`src/main/ipc.ts`、`src/main/index.ts`、`src/main/tray.ts`、`src/main/panel.ts`、`src/renderer/panel.html|ts`、`src/renderer/goals.html|ts|css`、`src/renderer/globals.d.ts`、`src/shared/constants.ts`（如需要）。
  - 用户文档：`README.md`（新增功能入口与数据位置）、`docs/specs/README.md` 索引、本规格。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | 应用已启动，托盘存在 | 点击托盘菜单「目标…」 | 打开独立「目标」窗口（560×640，无边框、置顶）；连续点击不产生第二个窗口，已打开时聚焦/前置 |
| AC-02 | 目标窗口已打开并聚焦 | 按 `Esc` 或点击窗口右上角 ✕ | 窗口隐藏；再次从入口打开，内容与隐藏前一致，不重新加载数据、不丢未保存输入之外的状态（进行中的输入框内容可丢弃） |
| AC-03 | 目标列表为空 | 在顶部输入框输入标题后按 Enter，或点击「＋」 | 新目标出现在列表中，进度 0、状态进行中、创建时间写入；标题首尾空白被去除；空标题或全空白被拒绝并保持输入框焦点 |
| AC-04 | 目标任务存在 | 点击标题进入编辑，修改后 Enter 或失焦 | 标题保存并即时反映；`Esc` 取消编辑恢复原标题；保存失败时显示错误提示且恢复原标题 |
| AC-05 | 目标处于进行中 | 拖动进度条（步进 5%）或点击进度数字输入 | 进度在 0–100 之间保存并显示；非法值（负数、>100、非整数）被拒绝且不改动；重启后进度保持 |
| AC-06 | 目标窗口打开，某目标已展开 | 在时间线输入框输入内容，选择「进展」或「问题」后 Enter | 追加一条带时间戳的记录，最新在上；输入框清空并保持焦点；空内容被拒绝；切换类型只影响本条记录 |
| AC-07 | 某目标存在时间线记录 | 点击记录右侧删除并确认 | 该条记录删除并持久化；取消确认不删除 |
| AC-08 | 目标处于进行中 | 点击「标记完成」 | 状态变已完成、进度置 100、`completedAt` 写入、自动追加一条「完成」记录；目标移入「已完成」折叠区；重启后保持 |
| AC-09 | 目标存在（进行中或已完成） | 点击删除并确认 | 目标连同其时间线删除并持久化；取消不删除；删除不改变其他目标 |
| AC-10 | 应用运行中，新增/修改过数据 | 关闭应用后重新启动 | 目标、进度、状态、时间线与完成时间全部恢复；最近 300ms 内的改动在 `before-quit` flush 后不丢 |
| AC-11 | `goals.json` 不存在 | 首次新增目标 | 自动创建 `userData/goals.json`，内容为 `{"version":1,"goals":[...]}` |
| AC-12 | `goals.json` 主文件损坏（如截断/非法 JSON），且存在有效 `.bak` | 启动应用 | 从 `.bak` 恢复数据；损坏主文件被改名为 `goals.json.corrupt-<timestamp>` 保留；目标窗口显示可关闭的告警「已从备份恢复」 |
| AC-13 | 主文件与 `.bak` 都损坏 | 启动应用 | 以空列表启动；原文件保留为 `goals.json.corrupt-<timestamp>`；目标窗口显示告警；在用户新增前不覆盖损坏文件 |
| AC-14 | `goals.json` 中个别目标字段非法（缺 id、进度越界、未知状态等） | 启动应用 | 丢弃该目标并继续加载其余目标；告警中说明丢弃数量；不整体判损 |
| AC-15 | 目标列表非空 | 点击「导出」，在保存对话框选择路径并确认 | 生成 Markdown 文件：包含所有目标（进行中在前、已完成在后），每条含标题、状态、进度、创建/完成时间及全部时间线记录（时间、类型、内容）；导出按钮状态在写入完成前禁用，成功后提示路径 |
| AC-16 | 目标列表为空 | 点击「导出」并确认保存路径 | 生成含标题与「暂无目标」说明的合法 Markdown 文件，不抛错 |
| AC-17 | 保存对话框被取消或写入失败 | 取消 / 模拟写入失败 | 取消时无文件、无错误提示；失败时窗口内提示错误，数据与界面不受影响，可重试 |
| AC-18 | 任务监控正在运行 | 目标窗口的增删改与导出操作 | 灯带、托盘、任务面板行为与数据不受影响；`TaskStore` 状态机与 `visibility.ts` 判据不参与目标功能 |
| AC-19 | 目标窗口已打开 | 在任务面板点击「目标」按钮 | 目标窗口前置/聚焦（不重复创建），面板可正常收起 |
| AC-20 | 列表中有 200 条目标；某目标已有 500 条记录 | 尝试继续新增 | 拒绝并提示上限；已有数据不受影响（上限见 §3 边界） |

边界、异常、恢复/停止行为：

- 标题 1–120 字符（trim 后）；时间线内容 1–500 字符；目标上限 200；单目标记录上限 500。
- 进度只接受 0–100 的整数；渲染层步进 5，但主进程不假设步进，只校验范围与整数。
- 目标 id / 记录 id 由 `crypto.randomUUID()` 生成；删除不存在的 id 返回 `{ok:false,message}`，不抛异常。
- 写盘失败：保持应用运行，记录日志，向目标窗口推送告警；下一次变更或退出时重试。
- 未知 `version`（非 1）：按损坏处理（隔离 + 空列表 + 告警），不尝试解析。
- 导出只写用户选择的路径；覆盖确认交给系统保存对话框；导出内容使用 `\n` 换行，UTF-8 无 BOM。
- `goals.json` 与配置分离，配置文件热重载不影响目标数据。
- 并发：依赖应用单实例锁；不做文件级跨进程锁（非目标）。

## 4. 方案与任务切片

### 4.1 数据模型（`Go​alsFile` v1）

```ts
type GoalStatus = 'active' | 'done';
type GoalEntryKind = 'progress' | 'issue' | 'done';

interface GoalEntry {
  id: string;            // uuid
  at: number;            // epoch ms
  kind: GoalEntryKind;   // 手动：progress/issue；done 由系统完成动作追加
  text: string;          // 1..500
}

interface Goal {
  id: string;
  title: string;         // 1..120
  progress: number;      // 0..100 整数
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;  // status==='done' 时存在
  entries: GoalEntry[];  // 时间线，追加为主
}

interface GoalsFile { version: 1; goals: Goal[] }
```

### 4.2 模块与职责

- `src/main/goals-store.ts`：纯 Node（不 import electron），持有内存数据；负责加载/校验/迁移、增删改、完成、记录追加/删除、标记脏并防抖写盘、`flush()`、损坏隔离与 `.bak` 恢复、生成 `GoalsView`。所有公开写方法返回 `{ok:true}|{ok:false,message}`，不抛异常。
- `src/main/goals-export.ts`：纯函数 `buildGoalsMarkdown(view, generatedAt)`，按 AC-15/16 输出；便于单测。
- `src/main/goals-window.ts`：`BrowserWindow` 生命周期（懒创建/隐藏/聚焦/销毁），参数参照 `panel.ts`：560×640、`frame:false`、`alwaysOnTop`、`skipTaskbar`、`contextIsolation`、preload 白名单。失焦**不隐藏**（与任务面板相反）。`before-quit` 由 `index.ts` 调 `flush()`。
- `src/main/index.ts`：创建 `GoalsStore`（userData/goals.json）与 `GoalsWindow`；注册 IPC handlers；`before-quit` flush；托盘菜单入口。
- `src/shared/types.ts`：新增上述类型 + `GoalsView`（`{ goals: Goal[]; warning?: string }`）。
- `src/shared/ipc-contract.ts`：
  - invoke：`goals:get`、`goals:add`、`goals:delete`、`goals:updateTitle`、`goals:setProgress`、`goals:complete`、`goals:addEntry`、`goals:deleteEntry`、`goals:export`、`window:openGoals`。
  - push：`goals:changed`（`GoalsView`）。
  - `RendererApi` 增补对应方法与 `onGoals`；`role` 扩展为 `'overlay' | 'panel' | 'goals'`。
- `src/preload/preload.ts`：白名单绑定；`detectRole()` 识别 `data-indicator-role="goals"`。
- `src/renderer/goals.html|goals.ts|goals.css`：classic script，只渲染主进程推送的 `GoalsView`，交互只发 IPC；用 `textContent` 渲染用户输入，禁止 `innerHTML` 拼接；沿用 `shared.css` 变量与 `ui.ts` 图标风格。`goals.css` 通过 `build:assets` 复制。
- `src/main/tray.ts`：菜单新增「目标…」项（与「打开配置文件」同区）。
- `src/main/panel.ts` / `src/renderer/panel.html|ts`：标题栏新增「目标」按钮，点击调用 `window:openGoals`。
- `scripts/copy-renderer.mjs`：如按扩展名白名单复制资源，需确认 `goals.html/goals.css` 被覆盖（实现时核实，必要时补规则）。

### 4.3 IPC 校验

所有写通道在主进程校验：类型、长度、上限、id 存在性；非法返回 `{ok:false,message}` 并记录 warn；`before` 不修改内存。`goals:export` 由主进程弹 `dialog.showSaveDialog`（`goals-YYYY-MM-DD.md`，过滤器 Markdown），写文件失败返回错误信息；取消返回 `{ok:true,canceled:true}`。

### 4.4 持久化细节

- 路径：`path.join(app.getPath('userData'), 'goals.json')`。
- 写盘：序列化 → 写 `goals.json.tmp` → `fsync` → 若主文件存在复制为 `goals.json.bak` → `rename(tmp, goals.json)`。写失败保留 tmp 供下次覆盖，记录日志并推送告警。
- 防抖 300ms（可注入 `debounceMs` 便于测试）；`flush()` 同步执行，供 `before-quit`/测试调用。
- 加载：不存在 → 空；解析失败或 `version !== 1` → 尝试 `.bak`（解析+版本校验）→ 成功则恢复并重写主文件 + `warning`；失败则把主文件改名为 `.corrupt-<ts>`（`--n` 后缀避免重名），空列表 + `warning`。
- 单个目标校验失败：丢弃该目标，`warning` 记录数量；其余加载。

### 4.5 任务切片（每片 Red → Green → Refactor）

1. **S1 模型与持久化**：`goals-store` 的类型/校验/CRUD/完成/时间线/防抖/flush/损坏恢复/`.bak` 恢复/单目标非法过滤；`goals-export` 纯函数。测试：`test/goals-store.test.ts`、`test/goals-export.test.ts`。
2. **S2 IPC 与 preload**：契约、通道、校验失败路径。测试：可用注入式 handler 或集成测试 `test/goals-ipc.test.ts`（若现有 IPC 层不可单测，则抽出 `registerGoalsHandlers(store, deps)` 以便测试）。
3. **S3 渲染层与窗口**：goals.html/ts/css、窗口类、入口（托盘/面板）、关闭/聚焦、Esc。验证：`npm run check:ui` 若现有夹具可扩展；否则至少类型检查 + 构建 + Windows 真机。
4. **S4 导出**：保存对话框、Markdown 生成、取消/失败路径。测试：纯函数单测 + 真机保存对话框验收。
5. **S5 回归与验收**：类型检查、全量测试、构建、smoke、Windows 真机清单。

### 4.6 备选取舍

- 独立窗口（已确认 A）vs 面板内 tab：选 A，避免 420×520 挤占与失焦收起。
- Markdown vs JSON 导出：选 Markdown（用户目标是「记录内容」可读）；JSON 备份后续规格。
- 手写 JSON 持久化 vs electron-store/SQLite：手写，符合零依赖约束；SQLite 无收益。
- 不引入 UI 框架、状态库、虚拟滚动（目标数量上限 200，全量重绘可接受；列表 ≤ 200 行）。

## 5. 测试计划与追踪

| AC | 测试文件/完整用例名或真机步骤 | Red 证据 | Green 证据 | 回归/平台验收 |
| --- | --- | --- | --- | --- |
| AC-03 ~ AC-09、AC-20 | `test/goals-store.test.ts`（21 项：CRUD、标题、进度、记录、完成、删除、上限、校验） | 2026-10-22 11:25 `npm test -- test/goals-store.test.ts test/goals-export.test.ts --reporter=verbose`：23 failed / 1 passed，exit 1（断言失败：`expected false to be true`、目标不存在等） | 2026-10-22 11:26 同命令：24 passed，exit 0 | 全量 897 passed（见下） |
| AC-03 ~ AC-09、AC-15 ~ AC-17 | `test/goals-ipc.test.ts`（10 项：参数校验、导出内容/文件名/取消/失败、窗口入口） | 2026-10-22 11:27 `npm test -- test/goals-ipc.test.ts --reporter=verbose`：9 failed / 1 passed, exit 1 | 2026-10-22 11:27 同命令：10 passed，exit 0 | 全量回归 |
| AC-10、AC-11、AC-12、AC-13、AC-14、AC-17 | `test/goals-store.test.ts`（持久化 roundtrip、debounce+flush、首次创建、`.bak` 恢复、双损坏隔离、未知版本、单目标非法过滤、保存失败告警） | 同上 Red 批次（AC-10/11/12/13/14 对应断言均失败） | 同上 Green 批次 | 全量回归 |
| AC-15、AC-16 | `test/goals-export.test.ts`（排序、字段、空列表、换行压平） | 2026-10-22 11:25 批次：3 failed，exit 1 | 2026-10-22 11:26：3 passed | 全量回归 |
| UI 渲染（AC-01/02/03…基础布局与安全） | `npm run check:ui`：新增 goals 夹具（dark/light × 有数据/空态），断言窗口尺寸、标题文本化、条目/进度/告警、列表滚动、删除按钮初始未武装；截图 `logs/spec012-ui/goals-*.png` | 首轮截图发现「删除按钮渲染即进入确认态」缺陷，已修复并加入断言 | 2026-10-22 11:33 `npm run check:ui`：PASS 28 cases，exit 0 | 真实 Electron 隐藏窗口，不替代 OS 点击 |
| AC-01、AC-02、AC-03 ~ AC-10、AC-15 ~ AC-17、AC-19（集成路径） | `npm run check:goals`：真实 GoalsWindow + 真 preload + 真 IPC + 真 GoalsStore，隐藏窗口驱动 新增 → 进度 → 问题记录 → 完成 → 导出 → Esc 隐藏 → 经 `OPEN_GOALS` 重开 → 重新加载文件 | 首轮集成断言把「完成自动追加 done 记录」漏算，已修正为 issue + done 两条 | 2026-10-22 11:37 `npm run check:goals`：PASS，exit 0 | 导出走注入写入（不弹系统对话框）；托盘菜单与 OS 焦点仍需真机 |
| AC-01、AC-02、AC-19、AC-15、AC-17（OS 路径） | Windows 真机：重启应用 → 托盘「目标清单…」/面板「◎」→ 点击、拖动进度、输入中文、系统保存对话框导出、Esc/✕、重启恢复 | — | 2026-10-22 12:21 用户自行重启后验证：「没问题」（窗口、增改、完成、导出、隐藏/重开） | 用户真机确认通过 |
| AC-18 | 全量测试 + smoke + 面板/灯带回归 | — | `npm test` 897 passed；`npm run smoke` 全部通过（1025ms） | 待真机确认灯带/面板无回归 |
| AC-20 | `test/goals-store.test.ts`（目标 200 / 记录 500 上限） | Red 批次失败 | Green 批次通过 | 全量回归 |

证据命令统一在仓库根执行（Windows 10/11、Node 24.14、Electron 33）。2026-10-22 11:34 复跑：`npm run typecheck` exit 0；`npm test -- --maxWorkers=2 --minWorkers=1` 61 files / 897 tests passed；`npm run build` exit 0；`npm run smoke` exit 0；`npm run check:ui` 28 cases PASS；`npm run check:goals` PASS。


## 6. 执行记录

- 规格就绪依据、仍需澄清项：用户已确认 A + 导出；导出格式按 Markdown 假设，若用户要求 JSON 再改；窗口位置记忆明确不做。
- 修改前回归：基线提交 `4d56980` 工作区无已跟踪改动；新增测试前未复跑全量（本规格只新增文件，未改既有行为）。
- 每个切片的 Red → Green → Refactor：
  - S1（数据仓库 + 导出）：Red 23 failed / Green 24 passed；Refactor：抽出 `parseGoalsFile` / `sanitizeGoal`，测试保持通过。
  - S2（IPC 校验）：Red 9 failed / Green 10 passed；Refactor：无必要（校验集中在 `goals-ipc.ts` 单层）。
  - S3/S4（窗口、托盘/面板入口、渲染层、导出对话框）：以 `check:ui` 夹具 + `check:goals` 真实 Electron/IPC 集成 + 类型检查 + 构建验证；真实 Electron 截图发现并修复「删除按钮渲染即武装」缺陷（`wireDelete` 改为点击后才进入确认态），新增断言防回归。
  - S5（回归）：typecheck / 897 tests / build / smoke / check:ui / check:goals 全通过。
- TDD 例外：窗口生命周期与系统保存对话框依赖 Electron/OS，无法在 vitest 中完整覆盖；以 `check:ui` 真实 Electron 渲染夹具 + 类型检查 + 构建 + 待 Windows 真机点击作为替代验证。
- 需求变更记录：2026-10-22 用户否决周 KR、确认独立窗口与一键导出。

## 7. 交付与验收

- [x] 所有 AC 有验收证据；满足[流程 DoD](../development/spec-tdd.md)。
- [x] 类型检查、全量测试、构建后 smoke 及所需真机验证结果已记录（真机 2026-10-22 用户确认通过）。
- [x] 相关文档、规格索引、配置示例已更新；没有秘密或本机配置进入提交。
- [x] 已知失败接受依据（如适用）、未完成项、回退步骤、发布状态已说明。

最终结果/提交引用：2026-10-22 用户真机确认通过；代码在工作区（尚未提交，用户未要求提交）。后续悬浮灯展示由 [SPEC-025](025-overlay-goals-row.md) 承接；拖拽排序由 [SPEC-026](026-goal-reorder.md) 承接。
