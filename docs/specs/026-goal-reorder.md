# SPEC-026：目标卡片拖拽排序

> 状态：done
> 类型：feature（交互）
> 需求来源：用户 2026-10-22 会话——「新增一个需求 todo 的任务框可以通过拖拽来调整顺序」。
> 负责人：lead + 开发者
> 基线提交：`0570d3a`（SPEC-024/025 已提交并推送）。
> 需求依据及假设：排序只发生在同一分组内（进行中 / 已完成各自排序），不通过拖拽改变目标状态；顺序持久化到 `goals.json`；不新增配置项。
> 关联/替代条款：扩展 SPEC-024 的目标列表；不改变目标数据语义、悬浮灯摘要与任务状态机。

## 1. 问题与目标

目标清单目前按「新增在顶部」的固定顺序排列，用户无法调整。希望像任务卡片一样，直接拖动卡片调整顺序；顺序在重启后保留，导出 Markdown 时也按新顺序输出。

目标行为：拖动目标卡片（通过卡片上的拖拽把手）可以上下移动；放置位置有明确指示（前/后插入）；进行中与已完成各自排序，不能跨分组拖动改变状态；新顺序写入 `goals.json` 并同步到目标窗口。

## 2. 范围与非目标

- 本次包含：
  - 目标卡片左侧新增拖拽把手；HTML5 Drag & Drop 同一分组内排序。
  - 拖动时高亮目标卡片，并在落点卡片上显示「插入到前/后」指示。
  - 落点计算：指针在卡片上半 → 插到该卡片之前；下半 → 插到之后；同组末尾 → 追加到组末。
  - `GoalsStore.moveGoal(id, beforeId)`：同组内移动并持久化；不允许跨状态组；不改变 `updatedAt`/进度/时间线。
  - 新 IPC 通道 `goals:move`（R→M）+ preload 白名单 + 参数校验。
  - 排序结果影响：目标窗口显示顺序、导出 Markdown 顺序；悬浮灯摘要不受影响。
  - 单测、`check:ui` 拖拽夹具、`check:goals` 真实集成。
- 本次不包含：
  - 跨「进行中 / 已完成」拖拉改变状态（完成只能通过「标记完成」）。
  - 键盘排序、触屏手势、列表虚拟滚动、动画过渡（仅 CSS 落点提示）。
  - 悬浮灯目标行排序、任务行排序、配置项。
  - 拖动时自动滚动长列表（目标上限 200，先不做）。
- 受影响模块/接口/用户文档：
  - `src/main/goals-store.ts`、`src/main/goals-ipc.ts`、`src/main/ipc.ts`、`src/main/index.ts`、`src/preload/preload.ts`、`src/shared/ipc-contract.ts`、`src/shared/types.ts`（如需要）。
  - `src/renderer/goals.ts`、`goals.css`、`goals.html`（把手/指示样式）。
  - `scripts/ui-render-check.cjs`、`scripts/ui-render-preload.cjs`（拖拽夹具）、`scripts/goals-window-check.cjs`（真实拖拽集成）。
  - 用户文档：`README.md`、规格索引、本规格。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | 目标列表有 ≥2 条进行中目标 | 拖动卡片把手，把 A 放到 B 的上半区并松手 | A 移动到 B 之前；列表立即按新顺序渲染 |
| AC-02 | 同上 | 放到 B 的下半区 | A 移动到 B 之后 |
| AC-03 | 有 ≥2 条进行中目标 | 拖到同组最后一张卡片的下半区 / 组末尾 | 移动到该分组末尾 |
| AC-04 | 有一条进行中目标 A、一条已完成目标 D | 把 A 拖到 D 上 | 不允许：显示禁止落点，松手后顺序与状态不变；不产生跨组移动 |
| AC-05 | 拖动过程中 | 指针在目标卡片上移动 | 被拖卡片呈半透明/高亮；落点卡片显示上/下插入指示；离开后指示消失 |
| AC-06 | 任意目标已排序 | 关闭应用后重启（或重新加载 GoalsStore） | 显示顺序与排序后一致（持久化） |
| AC-07 | 已排序 | 点击「导出」 | Markdown 中目标顺序与新顺序一致（进行中在前、已完成在后不变） |
| AC-08 | 目标已排序 | 查看悬浮灯 | 目标行数量/平均进度不变（排序不影响摘要） |
| AC-09 | 拖动 A 放到自身/空处 | 松手 | 无变化、无持久化写入、无错误提示 |
| AC-10 | IPC 收到非法请求（缺 id、beforeId 类型错误、id 不存在、跨组） | 调用 `goals:move` | 返回 `{ok:false,message}`；数据不变；不抛异常 |
| AC-11 | 现有功能 | 执行回归 | typecheck / 全量测试 / build / smoke / check:ui / check:goals 全通过 |
| AC-12 | Windows 真机 | 拖动进行中/已完成卡片、重启、导出 | 拖拽手感正常、顺序保留、导出顺序正确、无跨组误操作 |

边界、异常、恢复/停止行为：

- `beforeId === null` 表示同组末尾；`id === beforeId` 或目标不存在 → `{ok:false}` 或 no-op（不写盘）。
- 跨状态组（active ↔ done）一律拒绝，状态不变。
- 排序不修改 `updatedAt`、进度、时间线、完成时间；不触发完成/提醒。
- 拖动期间不触发目标重绘（无推送）；松手成功后才由主进程推送新顺序。
- 排序后的数组规范化为「进行中在前、已完成在后」，仅影响存储顺序，不改变任何字段。
- 拖拽使用 HTML5 Drag & Drop，输入框/滑杆上的拖动不启动卡片排序（把手是唯一 drag 起点）。

## 4. 方案与任务切片

### 4.1 数据层

- `GoalsStore.moveGoal(id: string, beforeId: string | null): GoalMutationResult`
  - 校验 `id` 存在；`beforeId` 为 null 或存在且不同于 id；两者状态必须相同。
  - 将移动目标插入同组目标在 `beforeId` 之前（null → 组末）。
  - 重建数组为 `[...active, ...done]`，保持两组内部新顺序。
  - 不修改 `updatedAt`；`dirty=true` + 防抖写盘 + emit。
  - 无变化（已在该位置）时可 no-op，不写盘。
- `summarizeGoals` 不参与排序。

### 4.2 IPC / preload

- `IPC.GOALS_MOVE = 'goals:move'`；`InvokeMap`：`{ id: string; beforeId: string | null } -> TaskActionResponse`。
- `goals-ipc.ts`：`move(request)` 校验字段类型（beforeId 允许 null），调用 store。
- `ipc.ts` 注册 safe handler；preload 暴露 `moveGoal(id, beforeId)`；`index.ts` 注入。

### 4.3 渲染层

- 卡片头新增 `.goal-drag` 把手（`draggable="true"`，`aria-label="拖拽排序"`，title）。
- `dragstart`（把手）：记录 `dragGoalId`，设置 `dataTransfer`，卡片加 `.dragging`。
- `dragover`（卡片）：仅当被拖目标与当前卡片同状态时 `preventDefault`；按 `clientY` 相对卡片中点决定 before/after，加 `.drop-before` / `.drop-after`。
- `drop`：计算 `beforeId` = after ? 同组下一张卡 id : 当前卡 id；组末 → null；调用 `moveGoal`。
- `dragend` / `dragleave`：清理状态与指示。
- 排序成功由主进程推送；失败 toast 提示，列表保持原顺序。
- CSS：把手视觉、`.dragging` 透明度、落点 2px accent 线。

### 4.4 任务切片

1. **S1 数据层**：`moveGoal` + 持久化 + 边界；测试 `test/goals-store.test.ts`。
2. **S2 IPC**：契约/校验/接线；测试 `test/goals-ipc.test.ts`。
3. **S3 渲染**：把手/拖拽/指示；`check:ui` 夹具（模拟 dragstart/dragover/drop，断言 IPC 参数与落点样式）。
4. **S4 集成**：`check:goals` 真实拖拽（两条目标，拖动后断言 store 顺序与文件顺序）。
5. **S5 回归**：typecheck / 全量 / build / smoke / check:ui / check:goals；Windows 真机待确认。

## 5. 测试计划与追踪

| AC | 测试文件/完整用例名或真机步骤 | Red 证据 | Green 证据 | 回归/平台验收 |
| --- | --- | --- | --- | --- |
| AC-01 ~ AC-03、AC-06、AC-07、AC-09 | `test/goals-store.test.ts`：move 到前/后/末尾、持久化 roundtrip、无变化 no-op、导出顺序 | 2026-10-22 13:44 首跑：6 failed / 34 passed，exit 1（moveGoal 未实现） | 2026-10-22 13:44 复跑：store 28 + ipc 12 全通过 | 全量 918 passed |
| AC-04、AC-10 | `test/goals-store.test.ts` + `test/goals-ipc.test.ts`：跨组拒绝、缺 id/beforeId 类型/不存在 | 同 Red 批次 | 同 Green 批次 | 全量 |
| AC-05 | `check:ui` goals 夹具：模拟 dragstart/dragover（上半/下半）、断言 `.dragging`、`.drop-before/.drop-after`、drop 调用参数 | — | 2026-10-22 13:50 `check:ui` PASS 31 cases | 隐藏 Electron |
| AC-01 ~ AC-04、AC-06 | `check:goals`：两条目标真实拖拽 → store 顺序反转、flush 后文件顺序一致 | 2026-10-22 13:48 首跑超时（夹具漏注册 `goalsMove` handler），修正后通过 | 2026-10-22 13:49 PASS | 真实 Electron/IPC |
| AC-08 | `test/goals-summary.test.ts`（摘要与顺序无关） + 全量回归 | — | 918 passed | 全量 |
| AC-11 | typecheck / full / build / smoke | — | 2026-10-22 13:50 全通过：62 files / 918 tests、smoke 全部通过 | — |
| AC-12 | Windows 真机：重启后拖动卡片、重启应用、导出 | — | 2026-10-22 用户重启后拖拽验证：「验证通过了」 | 用户真机确认通过 |

## 6. 执行记录

- 规格就绪依据、仍需澄清项：用户明确要求拖拽排序；「同组内排序、不改状态」为推导边界（跨组拖动改变状态会引入隐式完成/恢复语义，明确不做）。
- 修改前回归：`0570d3a` 上 typecheck / 909 tests / build / smoke / check:ui / check:goals 全通过。
- 每个切片的 Red → Green → Refactor：
  - S1/S2 Red：`npm test -- test/goals-store.test.ts test/goals-ipc.test.ts` → 6 failed / 34 passed，exit 1（moveGoal 返回未实现，顺序/持久化断言失败）。
  - Green：实现 `moveGoal`（同组内重建 active/done 两组顺序）+ IPC `goals:move` 校验 → 40 passed。
  - S3 渲染：把手/拖拽事件/落点样式 + `check:ui` 拖拽夹具；S4 集成：`check:goals` 真实拖拽（首次因夹具漏注册 `goalsMove` handler 超时，补齐后 PASS）。
  - S5：全量 918 / smoke / build / check:ui / check:goals 通过。
- TDD 例外：无。
- 需求变更记录：无。

## 7. 交付与验收

- [x] 所有 AC 有验收证据；满足[流程 DoD](../development/spec-tdd.md)。
- [x] 类型检查、全量测试、构建后 smoke 及所需真机验证结果已记录（真机 2026-10-22 用户确认通过）。
- [x] 相关文档、规格索引、配置示例已更新；没有秘密或本机配置进入提交。
- [x] 已知失败接受依据（如适用）、未完成项、回退步骤、发布状态已说明。

最终结果/提交引用：2026-10-22 用户真机确认通过；代码随本次提交合入。
