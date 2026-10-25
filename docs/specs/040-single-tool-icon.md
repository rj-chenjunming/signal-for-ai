# SPEC-040：只监控一个工具时也显示该工具的图标

> 状态：done
> 类型：bugfix（显示形态/一致性）
> 需求来源：用户 2026-10-25 反馈原话：「当我只是启动了一个 ai 工具，那么我的信号指示灯只是监控一个的话，它呈现的就只有一个灰色圆圈。我的预期是只有一个（工具），相应的图标也应该展示出来。」
> 负责人：AI 协作（dreaming 审阅）
> 基线提交与环境：`e973637`（main），Windows 真机，Electron 34.5.8
> 需求依据及假设：用户明确要求的行为，无需再批准。假设"监控一个"指**可显示行数为 1**——既包括只配置/启用了一个工具，也包括配置了多个但只有 1 个活着（其余失联/失败/未启动被隐藏）的情形；两种是同一条判定链。
> 关联/替代条款：修改 [SPEC-025](025-overlay-goals-row.md) 固化的"可显示任务 ≥ 2 才用灯带"阈值；不改变 SPEC-025 的目标行规则与"隐藏失联/失败行"产品原则（shared/visibility.ts 的其余口径）。

## 1. 问题与目标

**现有行为**：`shouldShowStrip(visibleTaskCount, goalRowCount)`（src/shared/visibility.ts:119）要求可显示任务 ≥ 2 才进入灯带形态。可显示行数只有 1 时（只监控一个工具，或多个工具里只剩 1 个活着），`snapshot.stripMode=false`，悬浮灯退回"单灯形态"——渲染层只画 `#lamp-core` 一颗圆圈，颜色随聚合状态（空闲即灰色）。该圆圈不带任何工具图标与标签，用户无法分辨这颗灯代表哪个工具。

**目标行为**：可显示行数 = 1 时同样进入灯带形态：总灯 + 一行「工具图标 + 状态圆点 + 端口标签」，与多任务形态同一套视觉语言。"单灯形态"保留给"没有任何活着的东西"（可显示行数 = 0 且无目标行）——此时没有图标可显示，维持现状。

渲染层、图标库（`window.aiIndicatorUi.icon`）、停靠点阵、目标行均无需新能力：灯带行的图标渲染、单行灯带画布（count=0+目标行场景）已在现有实现与 check:ui 夹具中存在。本规格只改"几行算灯带"的判定阈值，并同步三处口径（store、画布函数、check:ui 夹具副本）。

## 2. 范围与非目标

- 本次包含：
  - `shouldShowStrip` 阈值 ≥ 2 → ≥ 1（src/shared/visibility.ts）。
  - `resolveCanvasSize` 同步：行数 < 1 才退回单灯正方形；删除随之冗余的 `forceStrip` 参数（旧行为里它只为"0/1 个任务 + 目标行"兜底，新阈值下 `stripTaskCount ≥ 1 ⟺ stripMode`，等价性见 §4）。
  - `src/main/overlay.ts` 创建日志的模式措辞与 `resolveCanvasSize` 调用点同步。
  - `scripts/ui-render-check.cjs` 的夹具 stripMode 副本与画布调用同步（夹具与真实 store 同口径）。
  - 更新锁旧阈值的 4 个 vitest 文件断言。
- 本次不包含：
  - 单灯形态（0 行）的样式、颜色、交互不变。
  - 不改"失联/失败行隐藏"原则：工具失联（unknown）时行仍隐藏、仍可能缩成单灯——那是既有且用户确认过的口径。
  - 不引入新的"单图标无总灯"形态；不新增配置项。
- 受影响模块：`src/shared/visibility.ts`、`src/main/overlay-layout.ts`、`src/main/overlay.ts`（调用点与日志）、`scripts/ui-render-check.cjs`、相关测试。配置格式、IPC 契约、面板/目标窗口不受影响。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | 只有一个可显示任务（仅 1 个启用任务；或 2 个任务里 1 个活着 + 1 个失联/失败） | 生成 store 快照 | `snapshot.stripMode === true`；`displayTasks` 恰含那 1 个任务；`hiddenCount` 正确计数；0 个可显示任务且无目标行时仍 `stripMode === false`（不变量保持） |
| AC-02 | 可显示行数 n | 计算画布 `resolveCanvasSize` | n ≥ 1 返回灯带画布（`stripCanvasWidth()/stripCanvasHeight(n)`；停靠时 `compactCanvasSize(n, dock)`）；n = 0 返回单灯正方形 `lamp.size + 24`（不变量保持）；函数不再接受 forceStrip 参数 |
| AC-03 | Electron 夹具 check:ui，overlay 页 count=1（四个停靠方向） | 渲染并量取 DOM | `#lamp-strip` 显示、`#lamp-core` 隐藏；有 1 条 `.strip-row` 且行内含 SVG 工具图标；body 不超出画布；首行 aria 文案含状态词 |
| AC-04 | count=0 且有进行中目标（既有场景） | check:ui 渲染 | 仍渲染仅含目标行的灯带（回归不破坏）；count=0 无目标仍单灯 |

边界与异常：
- 0 可显示任务 + 无目标行：单灯形态，聚合色仍反映失联/失败（隐藏不掩盖，既有不变量）。
- 1 可显示任务 + 有目标行：灯带 2 行（任务行 + 目标行），与 `stripTaskCount = visible + goalRow` 一致。
- 画布切换时序：`setState` → `fitToTaskCount` 每次快照校正尺寸，1 ↔ 0 行互转时窗口随之缩放（既有机制，不改）。
- 兼容性影响：`lamp.size` 设置从此只在 0 行（单灯）时生效；1 个工具时窗口比原单灯大（约 164×130）。位置记忆仍按窗口左上角，不迁移。

## 4. 方案与任务切片

最小方案（纯判定阈值变更，无新 UI）：

1. `shouldShowStrip`：`goalRowCount > 0 || visibleTaskCount >= 1`。
2. `resolveCanvasSize`：`taskCount < 1` 才返回单灯正方形；删去 `forceStrip` 形参。等价性论证：`stripTaskCount() = countVisibleTasks(tasks) + goalRow`，新 `stripMode = goalRow>0 || visible>=1`，两者在 `≥ 1` 上完全等价，故旧 `forceStrip = lastSnapshot.stripMode === true` 不再携带额外信息；`taskCount = 0` 时 `stripMode` 必为 false，不存在"store 说灯带但行数为 0"的输入。
3. `src/main/overlay.ts`：`resolveCanvasSize(...)` 调用去掉第 6 参；创建日志 `>= 2 ? '灯带' : '单灯'` → `>= 1`。
4. `scripts/ui-render-check.cjs`：夹具副本 `s.stripMode = count >= 1 || goals…`；`forceStrip` 同式；`resolveCanvasSize(28, rows, 300, dock, 400)`（去第 6 参）；首行文案断言条件 `count >= 2` → `count >= 1`。
5. 测试切片：先改 4 个 vitest 文件到新期望（Red）→ 最小实现（Green）→ 清理冗余与注释（Refactor）。

备选取舍：保留 `forceStrip` 参数做成"无用但兼容"——被否，留下语义为空的形参是口径漂移温床（visibility.ts 头注记录过此类事故）。

## 5. 测试计划与追踪

| AC | 测试文件/完整用例名或真机步骤 | Red 证据 | Green 证据 | 回归/平台验收 |
| --- | --- | --- | --- | --- |
| AC-01 | `test/visibility.test.ts`「★ 一个活一个失联 -> 灯带」；`test/store-strip.test.ts`「单个启用任务」「只有 1 个启用、其余禁用」；`test/goals-summary.test.ts` shouldShowStrip 与两条 TaskStore 用例 | §6 R1 | §6 G1 | `npm test` 全量（§6 既有失败披露） |
| AC-02 | `test/overlay-layout.test.ts`「任务数为 0 才退回单灯」「resolveCanvasSize 传 dock 时走点阵；行数 0 仍是单灯」等 | §6 R1 | §6 G1 | 同上 |
| AC-03 | `npm run check:ui` overlay count=1 × dock none/left/right/top（`scripts/ui-render-check.cjs` checkOverlay） | §6 R2 | §6 G2 | 证据图 `logs/spec012-ui/overlay-single-*.png`（4 停靠）；**2026-10-25 用户真机确认「没问题」** |
| AC-04 | 同上：`checkOverlay(0,'none',{active:1,…})` 与 count=0 无目标 | 未运行（既有场景改造） | §6 G2 | 同上 |

回归门槛：`npm run typecheck`、`npm test`、`npm run build`、`npm run smoke`、`npm run check:ui`、`npm run check:goals` 全部退出码 0；基线 952/952（Electron 34.5.8，无需 AITI_ELECTRON）。

## 6. 执行记录

- 规格就绪依据：用户原话即需求；阈值与图标形态为唯一待定设计点，按"复用灯带形态"定案（§4），无阻塞未知项。
- 修改前回归（HEAD `e973637`，`git stash` 后实跑）：`npm test` exit 1——**1 failed / 951 passed（共 952）**，失败为 `test/process-presence-io.test.ts > Windows real hidden process + real session IO`（`processPresent` 得 `undefined`，真实子进程在并发 worker 下时序抖动；该文件单跑 1 passed）。既有失败，与 SPEC-040 改动模块（visibility/overlay-layout/overlay）无代码路径交集，按 baseline-validation 惯例单独披露，不计入本规格门槛。
- R1（vitest Red）：工作区 = HEAD + 新测试断言（**源码未改**）。命令 `npx vitest run test/visibility.test.ts test/store-strip.test.ts test/goals-summary.test.ts test/overlay-layout.test.ts`，exit 1，**8 failed / 84 passed**。失败用例：①任务 ≥1 就用灯带 ②没有目标摘要时按任务数定形态 ③进行中目标清零后回到无目标规则 ④任务数为 0 才退回单灯；1 行也是灯带 ⑤resolveCanvasSize 传 dock 时走点阵；行数 0 仍是单灯 ⑥单个启用任务 -> 灯带 ⑦只有 1 个启用、其余禁用 -> 灯带 ⑧★ 一个活一个失联 -> 灯带。全部因 `shouldShowStrip`/`resolveCanvasSize` 阈值行为缺失而失败，非编译错误。
- R2（check:ui Red）：`npm run build` exit 0（dist=HEAD 源）+ `npm run check:ui`，exit 1，`AssertionError: body exceeds canvas`（checkOverlay，count=1 场景：夹具已按新口径要求灯带，主进程画布仍是 52×52 单灯 → 灯带内容溢出画布）。
- G1：`npm run typecheck` exit 0；四测试文件 **92/92**（exit 0）。实现：`shouldShowStrip` 阈值 ≥1、`resolveCanvasSize` 去 forceStrip 参数（等价性见 §4）、overlay.ts 调用点与创建日志同步。
- G2：`npm run build` exit 0；`npm run check:ui` exit 0（**35 场景**：count=1 × 4 停靠新形态、count=0+目标行、count=0 无目标单灯、count=3/20 既有场景全过）；`npm run check:goals` exit 0；`npm run smoke` exit 0。
- Refactor：随 Green 完成——forceStrip 参数删除、visibility.ts / overlay-layout.ts / overlay.ts 头注与注释的"≥2"口径全部改为新口径；`scripts/ui-render-check.cjs` 夹具副本与真实 store 同口径（保留副本是为了让夹具可独立构造 count，语义与 `shouldShowStrip` 一一对应，注释已标注）。
- 过程发现（夹具假象，非产品缺陷）：count=1 贴边证据图初版"图标缺失"，经一次性探针（已删 `scripts/tmp-spec040-probe.cjs`）定位为夹具常驻 toast 盖住 94px 单行画布的图标行（图标 DOM/几何/颜色均正确：24px 容器、20px 绘制区、`rgb(32,44,64)`）。已把 count=1 场景改为不注入 overlayMessage（toast 共存覆盖仍由 count=3/20 场景承担）；干净证据图 `logs/spec012-ui/overlay-single-{none,left,right,top}.png` 确认「总灯 + 图标 + 状态点(+标签)」完整无裁切。
- 全量测试总数 952 → 951：forceStrip 专用用例合并进"1 行也是灯带"用例，断言不减。
- 真机验收（2026-10-25）：重启实例（旧实例为上一会话命令行拉起，已停；经 VBS 后台入口独立重启）。运行日志确认新代码生效（创建日志为新格式「灯带模式，行数=3」，旧实例为「任务数=3」）；配置 3 个任务仅 1 个可见时，贴边点阵呈「总灯 + 1 行图标」（旧代码此时缩成无图标单灯）。用户目视确认「没问题」。
- TDD 例外：无。
- 需求变更记录：无。

## 7. 交付与验收

- [x] AC-01/02/04 有自动化验收证据；AC-03 有夹具证据 + 目视截图。
- [x] 类型检查、全量测试、构建后 smoke、check:ui、check:goals 结果已记录（含 1 项既有失败披露与 HEAD 对照）。
- [x] 规格索引、相关注释（visibility.ts / overlay-layout.ts / overlay.ts 的"≥2"表述）已更新。
- [x] 已知限制：`lamp.size` 从此只在 0 行单灯形态生效；工具失联（unknown）时行仍隐藏、仍缩成单灯——这是既有"隐藏失联行"口径，不是本规格缺陷。回退步骤：还原 `shouldShowStrip` 阈值与 `resolveCanvasSize` 即可（单点改动）。

最终结果/提交引用：已随本仓库提交（git log 检索 SPEC-040）。真机验收 2026-10-25 用户确认通过，规格关闭。
