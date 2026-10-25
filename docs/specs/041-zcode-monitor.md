# SPEC-041：ZCode 状态接入指示灯（SQLite 只读轮询 + 裸 Z 图标）

> 状态：done
> 类型：feature（新监控源 + 显示元数据）
> 需求来源：用户 2026-10-25 原话：「帮我把zcode的状态也放到这个指示灯下 图标就按一个Z字图标吧 需要你同时设计一下」
> 负责人：AI 协作（dreaming 审阅）
> 基线提交与环境：`e3212cd`（main），Windows 真机，Electron 34.5.8，Node v24.16.0
> 需求依据及假设：用户明确要求接入 ZCode 并指定 Z 字图标；图标造型经 AskUserQuestion 三选一，用户选定「裸 Z」（无外框单笔画）。假设「ZCode 的状态」指本机 ZCode 桌面端/CLI 会话的工作状态（干活/等授权/完成/失败），单行聚合显示，不做 per-project 多行。
> 关联/替代条款：沿用 [SPEC-017](017-desktop-process-presence.md) 存在闸门机制（类型清单加 zcode）；toolKind 显示元数据走 [SPEC-019](019-dsh-web-icon.md) 同套路；activeWithinMs 默认取分钟级吸取 [SPEC-030](030-workbuddy-long-turn-liveness.md) 教训；灯带形态遵循 [SPEC-040](040-single-tool-icon.md) 现状。无替代条款。

## 1. 问题与目标

**现有行为**：指示灯只支持 process/log/webhook/dsh/sqlite/codex 六种监控源，ZCode（本仓库的开发工具本身，桌面端 `ZCode.exe` + CLI 内核）的状态无处接入；用户在 ZCode 里干活、等授权、回合完成时，指示灯没有对应灯。

**目标行为**：新增 `monitor.type: 'zcode'` 监控器，只读轮询 ZCode 会话数据库 `~/.zcode/cli/db/db.sqlite`，把会话活动聚合为七态之一经 TaskStore 上灯；悬浮灯/面板显示新的 `toolKind: 'zcode'`（裸 Z 图标）。状态语义：

- **waiting（黄）**：有被监控项目的工具调用处于待授权（`tool_usage.approval_status` pending，取值以 §6 探针为准）。
- **running（蓝）**：有活跃会话（`session.time_updated` 在 activeWithinMs 内）且存在未收尾的回合/工具调用。
- **failed（红）**：最近完成的回合失败且在展示窗内。
- **success（绿）**：最近回合成功且在窗内，带 completionAt 水位（复用 TaskStore 防复亮机制）。
- **unknown（行隐藏）**：数据库缺失/损坏/连续读取失败，或 ZCode.exe 进程不在（SPEC-017 闸门）。
- 无活动超出窗口 → idle（灰）。

## 2. 范围与非目标

- 本次包含：
  - `src/shared/types.ts`：`ZCodeMonitorConfig`、`MonitorConfig` 联合、类型守卫、`toolKind` 加 `'zcode'`。
  - `src/main/config.ts`：`type: 'zcode'` 校验分支。
  - `src/main/monitors/zcode.ts`：新监控器（子进程 node:sqlite 只读查询 + 纯判定函数）。
  - `src/main/monitors/host.ts`：`createSourceAdapter` 加 `case 'zcode'`。
  - `src/main/monitors/process-presence.ts`：桌面闸门类型清单加 `'zcode'`。
  - `src/main/store.ts`：`presentationFor()` 加 zcode 映射。
  - `src/renderer/ui.ts` + `assets/tool-icons/zcode.svg` + 图标 README：裸 Z 图标。
  - `scripts/ui-render-check.cjs`：夹具 toolKind 轮换加 zcode。
  - `config.desktop.example.yaml`：zcode 任务示例段。
- 本次不包含：
  - Hook 旁路（PermissionRequest 事件账本）：若 DB 的 approval_status 探针结论可靠则不需要；不可靠时另立规格，不在本规格内加 hook。
  - 按项目拆多行灯（per-project rows）；单行聚合。
  - 读取会话正文：只 SELECT 元数据列；不读 `cli/rollout/model-io-*.jsonl`（明文转储）、不碰 `~/.zcode/v2/certs`、`v2/credentials.json`。
  - 不改既有六种监控器、状态机转移表、IPC 契约、灯带渲染与画布逻辑。
- 受影响模块：上列文件 + 新测试文件；配置格式向后兼容（不写 zcode 任务的配置行为不变）。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | 加载含 `monitor.type: zcode` 合法任务段的配置 | `validateConfig` | 任务通过校验并生成监控器；`dbPath` 缺省取 `%USERPROFILE%/.zcode/cli/db/db.sqlite`；未知字段/非法类型（projects 非数组、intervalMs 非正数等）被拒或按既有字段级降级口径记日志丢弃 |
| AC-02 | 临时构造的 SQLite 夹具（session/tool_usage/turn_usage 与真实 schema 同构） | 驱动监控器轮询 | pending 授权→waiting；活跃会话+未收尾回合/工具→running；最近回合 failed→failed；最近回合成功→success（带 completionAt）；无活动→idle；waiting > running > failed > success 聚合优先级成立 |
| AC-03 | DB 文件不存在 / 损坏 / 连续读取失败 ≥ maxFailures | 驱动监控器 | 状态转 unknown（不伪造绿/蓝）；恢复可读后按转移表回到合法态 |
| AC-04 | 任务配 `jump.terminal: windowProcess [ZCode.exe]` 且进程不在 | 生成快照 | 行隐藏（SPEC-017 闸门对 zcode 生效）；进程在时恢复 |
| AC-05 | toolKind 为 zcode 的任务渲染 | check:ui 夹具 + 真机 | 悬浮灯行与面板行显示裸 Z 图标（单笔画圆头线稿），非 generic 四格回退 |
| AC-06 | 回合成功→绿灯→用户确认/自动熄灭 | 同一完成事件再次出现在 DB | 不复亮（completionAt ≤ ackedCompletionAt 丢弃，既有水位机制） |

边界、异常、恢复/停止行为：
- 项目过滤：`projects` 非空时按 `session.directory`/`path` 归一化匹配（大小写/分隔符不敏感），不匹配的会话不参与判定；空/缺省 = 全部项目聚合。
- 子代理会话（`task_type='subagent_child'`）计入所属项目的活动（经 parent 会话归并或直接按 directory 归属，探针定案）。
- 时间戳格式（epoch/ISO）以探针结论为准；未来时间戳/乱序按既有监控器口径丢弃。
- 轮询期间 ZCode 正在写库：WAL 模式只读连接（`mode=ro`）不阻塞写入；单轮失败计数、连续 maxFailures 判 unknown。
- `stop()` 后监控器不复活、定时器清空、子进程不悬挂（既有 base 契约）。
- 兼容性：不写 zcode 任务的既有配置零影响；新增类型不影响配置热重载与写回。

## 4. 方案与任务切片

最小方案（IO 方式抄 sqlite.ts，判定结构抄 codex.ts）：

1. **切片 0 · 数据源取证**（无产品代码）：只读探针查真实 db.sqlite，钉死：三张表的列 schema；`tool_usage.status`/`approval_status`、`turn_usage.status`、`session.last_outcome`/`task_type` 的实际枚举值分布；时间戳格式；`session.directory` 归一化样式；子代理归属。结论记 §6，作为 AC-02 判定语义依据。
2. **切片 1 · 监控器核心**：测试先行（Red）→ 实现（Green）：types + config 校验 + `monitors/zcode.ts`（`ZCodeMonitor extends MonitorAdapter`；查询经子进程 `node:sqlite` 只读打开，参照 sqlite.ts 的子进程脚本模式；纯函数 `reduceZcodeSnapshot()` 承载全部判定）+ host 接线 + process-presence 清单。
3. **切片 2 · 图标与显示**：ui-metadata 断言先行（Red）→ ui.ts `paths.zcode = '<path d="M6 5.75h12L6 18.25h12"/>'` + assets SVG/README + `presentationFor()` 映射 + check:ui 夹具轮换。
4. **切片 3 · 示例与回归**：config.desktop.example.yaml 示例段；全量回归按序留退出码；规格收尾。

备选取舍：日志 tail（`~/.zcode/cli/log/zcode-<date>.jsonl`）作数据源——被否：日志无授权等待信号、按日轮换增加游标复杂度、且属调试日志稳定性弱于 SQLite；hook 旁路——本轮非目标（见 §2）。`generic` 图标零代码方案——被否：用户明确要求 Z 字图标。

## 5. 测试计划与追踪

| AC | 测试文件/完整用例名或真机步骤 | Red 证据 | Green 证据 | 回归/平台验收 |
| --- | --- | --- | --- | --- |
| AC-01 | `test/config-zcode.test.ts` 三个用例 + `test/config-codex.test.ts`「四工具桌面模板完整解析」 | §6 R1/R3 | §6 G1/G3 | `npm run typecheck` exit 0、全量 `npm test` 972/972 |
| AC-02 | `test/zcode-monitor.test.ts`「开放模型请求…判 running」「开放工具调用…」「等待授权的工具判 waiting…优先」「回合错误判 failed」「多会话聚合取优先级最高态…」等 | §6 R1 | §6 G1 | 同上 |
| AC-03 | `test/zcode-monitor.test.ts`「数据库缺失时连续失败转 unknown，恢复可读后回到真实状态」 | §6 R1 | §6 G1 | 同上 |
| AC-04 | `test/process-presence-reader.test.ts`「gates all four explicit desktop tools…」 | §6 R1 | §6 G1 | 真机：退出 ZCode.exe 行隐藏（待用户） |
| AC-05 | `test/ui-metadata.test.ts`「zcode 型任务使用 zcode toolKind…」+ `npm run check:ui` 35 场景（夹具 toolKind 轮换含 zcode，截图 `logs/spec012-ui`） | §6 R2 | §6 G2 | 真机目视 Z 图标（待用户） |
| AC-06 | `test/zcode-monitor.test.ts`「回合完成判 success 并带完成水位；确认后同一完成不复亮」「启动前陈旧完成不补亮…」+ 既有 `store-ack-completion` 回归 | §6 R1 | §6 G1 | 真机：完成→熄灭→不复亮（待用户） |

回归门槛实测（2026-10-25，工作区 = HEAD + 本规格全部改动）：`npm run typecheck` exit 0；`npm test` **972/972 exit 0**（基线 952 + 新增 20：zcode-monitor 17 + config-zcode 3；既有 process-presence-io 抖动项本轮通过，无新增失败）；`npm run build` exit 0；`npm run smoke` exit 0；`npm run check:ui` exit 0（35 场景）；`npm run check:goals` exit 0。

## 6. 执行记录

- 规格就绪依据：用户原话 + 已批准的实施计划（图标三选一已答复）；数据源结构经只读调研初步确认，枚举值等关键未知项以切片 0 探针收口后进入依赖实现。
- 修改前回归：待填写。
- 切片 0 探针结论（2026-10-25，本机 `C:\Users\chen\.zcode\cli\db\db.sqlite`，WAL 只读 URI `?mode=ro` 可开，ZCode 正在运行写入时读取无阻塞）：
  - **时间戳一律 epoch 毫秒**（`time_created/time_updated/started_at/completed_at` 均 INTEGER，与 `Date.now()` 同量级核对通过）。
  - `session`：`directory` 存项目绝对路径（Windows 反斜杠，主会话与 `subagent_child` 均有值，子代理继承项目目录，无需 parent 归并）；`task_type ∈ {interactive, subagent_child}`；`last_outcome ∈ {completed, error}`；`time_deleted/time_archived` 为可空删除/归档标记。
  - `turn_usage`：**回合行只在回合结束后写入**（开放回合 completed_at IS NULL 计数为 0）；`status ∈ {completed, error, cancelled}`；error 行带 `error_type`。
  - `tool_usage`：`status ∈ {completed, error, running}`（pending 为排队瞬态，探针中出现过随后消失）；**`completed_at IS NULL` ⇔ 工具调用进行中**（探针当场抓到一条 running，即探针自身调用）；`approval_status` 本机 1333 行全为 `none`，专用 `permission` 表 0 行——本机为 yolo 自动授权模式，**等待授权信号结构上存在（schema 有列）但无可观察样本**。
  - `model_usage`：每次模型请求一行，`completed_at IS NULL` ⇔ 正在流式生成——补上「两次工具调用之间的思考期」running 信号。`runtime/execution_state` 只是权限模式（yolo/plan），不承载运行态。
  - **判定定案**：waiting = 开放工具行 `approval_status ∉ {NULL,'none'}`（不受新鲜窗约束，等待可以持续很久；孤儿行由 TaskStore waiting_timeout 兜底）；running = 开放 model_usage/tool_usage 行且 `started_at` 在 activeWithinMs 内；failed/success = 最近已收尾回合 status，带 completionAt 水位；cancelled 回合视为 idle（用户主动中止，同 Codex turn_aborted 口径）。**不使用** `session.time_updated > lastTurn.completed_at` 之类推断 running——标题生成等收尾写库会把刚完成的会话误翻蓝（绿灯闪蓝），流式间隙由 model_usage 开放行覆盖，无需推断。
  - waiting 真实触发待真机验证（本机 yolo 模式可能永远不触发黄灯，属预期而非缺陷）；AC-02 的 waiting 分支以夹具测试为准，真机项在 §5 保持 verifying。
- 每个切片的 Red → Green → Refactor：
  - **R1（切片 1 vitest Red）**：工作区 = HEAD + 新测试 + 类型声明与惰性骨架（`src/main/monitors/zcode.ts` 为 stub：`start/pollOnce` 不产生任何上报、`deriveZcodeVerdict` 恒返回 idle；类型/守卫/toolKind 为纯声明，无行为）。骨架是为了让 Red 因"行为缺失"而非"导入失败"成立。命令 `npx vitest run test/zcode-monitor.test.ts test/config-zcode.test.ts test/process-presence-reader.test.ts`，exit 1，**16 failed / 7 passed（共 23）**。失败均为断言级：12 个监控行为用例 `expected 'idle' to be 'running'/'waiting'/'success'/'failed'/'unknown'`（stub 恒 idle）、宿主接线 `expected +0 to be 1`、config 3 个 `expected [] to have a length of 1`（任务被丢弃）、presence `expected [] to deeply equal ['app']`。4 个"期望 idle"用例（无活动/超窗/未来时间戳/软删除）平凡通过——已披露，Green 后由真实逻辑覆盖。
  - **G1（切片 1 Green）**：实现 config 校验分支、`monitors/zcode.ts`（子进程查询 + `deriveZcodeVerdict` + 适配器）、host `case 'zcode'`、presence 清单加 zcode；随后 `typecheck` exit 0，三测试文件 **23/23 exit 0**，全量 `npm test` **971/971 exit 0**。
  - **R2（切片 2 Red）**：`test/ui-metadata.test.ts` 加 zcode toolKind 断言（工作区 = G1 + 该断言），`npx vitest run test/ui-metadata.test.ts` exit 1，**1 failed / 4 passed**（`toolKind` 为 generic ≠ zcode）。
  - **G2（切片 2 Green）**：`presentationFor()` 加 zcode 映射、`ui.ts` 加 `paths.zcode`、`assets/tool-icons/zcode.svg` + README 造型表、`scripts/ui-render-check.cjs` 夹具轮换 `[i % 4]→[i % 5]` 加 zcode；ui-metadata **5/5**，`npm run build` exit 0，`npm run check:ui` exit 0（**35 场景**，截图 `logs/spec012-ui`）。
  - **R3（切片 3 Red）**：`test/config-codex.test.ts` 模板断言改四工具（改名"三工具→四工具"），exit 1，**1 failed / 2 passed**（模板还是三工具）。
  - **G3（切片 3 Green）**：`config.desktop.example.yaml` 加 zcode 任务段；config 两夹具 **6/6**；最终全量回归见 §5 回归门槛实测（972/972）。
  - Refactor：随 Green 完成——zcode.ts 头注记录"刻意不用 time_updated 推断 running"的决策及原因；测试 helper 收敛（seedDb 支持指定路径）。无进一步重构必要。
- 过程记录（非产品缺陷）：
  - vitest/vite 解析器不把 `node:sqlite` 当内置模块（`Failed to load url sqlite`）→ 测试改为 `import type { DatabaseSync } from 'node:sqlite'`（类型）+ `createRequire`（运行时值）；顺带规避了测试 tsconfig module 模式对 `import.meta` 的限制。
  - 切片 1 过程中修正一处**测试自身错误**：projects 过滤用例误给匹配项目播了开放模型行，与其"过滤后应 idle"的意图相悖；修正测试种子后通过（实现行为正确）。
  - typecheck 抓到测试 helper 缺 `lastOutcome` 形参（测试代码质量），补齐。
- 真机/重启与验收：
  - 2026-10-25 23:33 经 VBS 后台入口重启生效：日志 `灯带模式，行数=4`、`[zcode] 程序已运行，恢复数据监控`、`任务 zcode 监控已启动（zcode）`，启动后 zcode 零读取失败。
  - 验收期间用户发现点击恢复后 X 无法关闭（Win32 激活路径缺陷），已转入 [SPEC-042](042-zcode-close-after-focus.md) 修复并于 23:44 重启生效。
  - **2026-10-25 23:50 用户真机确认「可以了」**：Z 行出现在灯带（含 Z 图标）、状态跟踪与点击恢复、X 关闭均正常。规格关闭。
- TDD 例外：切片 0 为只读取证（不改行为，探针命令与结论见上）；切片 3 的模板段为配置示例文档，行为变更本身由 R3/G3 的模板断言承载。
- 已知限制：
  - **waiting（黄灯）真实触发待真机验证**：探针确认 `approval_status` 列存在但本机 1333 行全为 `none`、`permission` 表 0 行（本机 yolo 自动授权模式）——黄灯可能在本机永远不触发，属预期而非缺陷；逻辑已由夹具测试覆盖（AC-02），真机若出现授权等待请目视确认黄灯。
  - 长工具执行 > activeWithinMs（默认 10 分钟）且期间完全无写库时，灯会提前回灰（可在任务配置调大 `activeWithinMs`）；回合收尾后按真实状态恢复。
  - `assets/tool-icons/preview.png` 预览图未含 zcode 造型（无渲染脚本，不引入新依赖）；真机目视 + check:ui 截图承担视觉验收。
  - 点击跳转定位 `ZCode.exe` 窗口沿用 SPEC-020/022 既有窗口恢复口径。
- 需求变更记录：无。

## 7. 交付与验收

- [x] AC-01/02/03/06 自动化证据齐全；AC-04/05 真机确认通过（2026-10-25 用户「可以了」）。
- [x] 类型检查、全量测试、构建后 smoke、check:ui、check:goals 结果已记录（§5 回归门槛实测，全部 exit 0）。
- [x] 规格索引、配置示例（config.desktop.example.yaml）、图标 README 已更新；无秘密或本机配置进入提交（探针输出只含结构与计数）。
- [x] 已知限制已披露（见 §6）；回退步骤：删除配置里的 zcode 任务段即可（新增类型不影响既有配置）。

最终结果/提交引用：随本仓库提交（git log 检索 SPEC-041）。真机验收 2026-10-25 用户确认通过，规格关闭。
