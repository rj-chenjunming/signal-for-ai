# SPEC-043：ZCode 流式思考期不亮蓝灯（输入/part 落库时机修正）

> 状态：verifying
> 类型：bugfix（状态判定）
> 需求来源：2026-10-25 23:55 用户反馈原话：「zcode运行的时候并没有亮蓝灯」（SPEC-041 真机使用中发现）
> 负责人：AI 协作（dreaming 审阅）
> 基线提交与环境：`e624d0e`（main）；Windows 真机；ZCode 会话库 live 探针（本规格 §6）
> 需求依据及假设：用户明确要求 ZCode 干活时亮蓝灯。假设"运行"指回合进行中（含模型流式输出阶段），与既有 running 语义一致。
> 关联/替代条款：修订 [SPEC-041](041-zcode-monitor.md) 的 running 判定（开放行之外补"未收尾输入"信号）；其余状态（waiting/failed/success/idle）与水位机制不变。

## 1. 问题与目标

**现有行为**：running 只由开放行（`tool_usage`/`model_usage` 的 `completed_at IS NULL`）判定。live 探针证实：`model_usage` 1225 行**全部在请求完成后才落库**（status 分布无 running），流式输出期间（两次工具调用之间的思考期，占活跃时间的大头）库里没有任何开放行——灯只在工具执行那几秒闪蓝，其余时间灰。用户观感："运行的时候没亮蓝灯"。

**目标行为**：回合进行中持续亮蓝。新增判定信号：会话存在**未收尾的输入**（`session_input.time_created` 晚于该会话最近收尾回合 `turn_usage.completed_at`）即视为回合进行中；其新鲜度由**活动时间**（输入/part 落库/开放行 started_at 的最大值）在 `activeWithinMs` 内兜底（防应用崩溃后永久亮蓝）。落库时机探针（§6）：`sendText` 输入行在提示词提交时即写、`part` 行在流式输出期间持续写、`turn_usage` 收尾行在回合结束时写（interactive 会话同样写，79 行实证）——"输入 > 收尾行"精确等价于"回合未结束"。

## 2. 范围与非目标

- 本次包含：`buildZcodeQueryScript` 加 `session_input`/`part` 两个有界元数据查询（不读 payload/data 正文）；`ZcodeProbe`/解析加 inputs/parts；`deriveZcodeVerdict` 的 running 分支加未收尾输入信号（含活动新鲜度护栏）；测试。
- 本次不包含：waiting/failed/success/idle 判定、水位与启动基线、配置格式、其他监控器。
- 受影响模块：`src/main/monitors/zcode.ts`、`test/zcode-monitor.test.ts`（夹具加两张表）。隐私红线不变：`session_input.payload` 与 `part.data` 正文列**不查询**。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | 会话最近收尾回合早于最新 `session_input`（提示词已提交、回合未结束），part 活动新鲜 | 驱动监控器 | 判 running（流式思考期亮蓝） |
| AC-02 | 回合收尾行晚于最后输入 | 驱动监控器 | 不判 running，按收尾状态走 success/failed/idle（绿灯不被顶成蓝） |
| AC-03 | 输入未收尾但输入/part/开放行活动全部超出 `activeWithinMs`（崩溃残留） | 驱动监控器 | 判 idle，不永久亮蓝 |
| AC-04 | 开放行存在（工具执行中） | 驱动监控器 | 既有行为不变：running/waiting 判定与优先级不回退（既有 17 用例回归） |

边界：无 turn 行的新会话首个输入视为未收尾（收尾时刻取 0）；子代理会话无 session_input，由父会话输入信号与开放行覆盖；查询 LIMIT 有界（inputs 100 / parts 100），只取 sessionId 与时间戳列。

## 4. 方案与任务切片

1. 切片 A（Red）：`test/zcode-monitor.test.ts` 夹具加 `session_input`/`part` 两张表 + 三个新用例（AC-01 为真实 Red；AC-02/AC-03 在现实现下平凡通过，作为 Green 护栏并如实披露）。
2. 切片 B（Green）：zcode.ts 查询/解析/判定三处最小实现。
3. 切片 C：typecheck → 全量 test → build → smoke；重建重启，用户真机验收（ZCode 干活期间持续蓝灯、完成后转绿）。

备选取舍：用 `session.time_updated` 推断 running——被否（SPEC-041 §6 已论证标题等收尾写库会把刚完成的会话误翻蓝）；tail 日志 jsonl 的 turn 事件——被否（引入第二数据源与游标复杂度，调试日志稳定性弱于库）。

## 5. 测试计划与追踪

| AC | 测试文件/完整用例名 | Red 证据 | Green 证据 | 回归/平台验收 |
| --- | --- | --- | --- | --- |
| AC-01 | `test/zcode-monitor.test.ts`「提示词已提交且回合未收尾判 running（流式思考期）」 | §6 R1 | §6 G1 | 真机：干活期间持续蓝灯（用户） |
| AC-02 | 同文件「回合收尾行晚于最后输入不再判 running」 | §6 R1（护栏平凡通过） | §6 G1 | 真机：完成后转绿 |
| AC-03 | 同文件「输入未收尾但活动超出新鲜窗判 idle」 | §6 R1（护栏平凡通过） | §6 G1 | — |
| AC-04 | 既有 zcode 监控 17 用例 + 全量回归 | — | §6 G1 | — |

回归门槛：typecheck、全量 test、build、smoke 留退出码。

## 6. 执行记录

- 规格就绪依据：live 探针（2026-10-25 23:5x，真实库只读）钉死落库时机：`model_usage` 无 running 行（1225 completed 全部落库于完成后）；当前会话 `sendText` 输入行 = 提示词时刻、最新 `turn_usage` 收尾行 = 上一回合结束、`part.time_created` 最新 = 本回合流式输出中（毫秒级新鲜）；`turn_usage` 中 interactive 会话 79 行（收尾行可信）。
- 修改前回归：SPEC-042 收尾时全量 982/982（六项门槛 exit 0）；本规格改动只涉及 zcode.ts 查询/判定与对应测试。
- **R1（vitest Red）**：工作区 = `e624d0e` + 新测试（夹具加 `session_input`/`part` 两张表与三个用例，源码未改）。命令 `npx vitest run test/zcode-monitor.test.ts`，exit 1，**1 failed / 19 passed**。失败为 AC-01「提示词已提交且回合未收尾判 running（流式思考期）」`expected 'idle' to be 'running'`（现实现不读输入信号）；AC-02/AC-03 护栏用例在现实现下平凡通过（如实披露，现实现根本看不到输入）。
- **G1（Green）**：zcode.ts 三处实现（查询加 inputs/parts 两个有界元数据查询、解析、running 分支加未收尾输入信号与活动新鲜度护栏）；该文件 **20/20 exit 0**；`npm run typecheck` exit 0；全量 `npm test` **985/985 exit 0**；`npm run build` exit 0；`npm run smoke` exit 0。
- 真机/重启：2026-10-25 23:56:39 经 VBS 后台入口干净重启（PID 直杀后计数 0），`任务 zcode 监控已启动（zcode）`、`AI 任务指示灯启动完成`，SPEC-043 构建生效。**真机验收待用户**（ZCode 干活期间 Z 行持续蓝灯、回合完成后转绿）。
- TDD 例外：AC-02/AC-03 护栏用例平凡通过的理由见 R1。
- 需求变更记录：无。

## 7. 交付与验收

- [ ] 所有 AC 有验收证据；满足流程 DoD。
- [ ] 类型检查、全量测试、构建后 smoke 结果已记录。
- [ ] 规格索引已更新；隐私红线（不读 payload/data 正文）保持。
- [ ] 真机验收由用户完成；达标前保持 verifying。

最终结果/提交引用：待填写。
