# SPEC-019：dsh Web 任务使用「浏览器＋鲸鱼」图标

> 状态：implementing
> 类型：feature（显示元数据）
> 需求来源：2026-10-21 用户反馈「我记得我设计的监控 dsh web 端的用的是另外一个图标（小鲸鱼在浏览器中）这个地方好像没有体现」。
> 负责人：Codex
> 基线：b1bc9d8，工作区干净；Windows 10.0.18363、系统 Node 24.14.0、Electron 33.4.11（本机按 SPEC-016 运行时校验修复）。
> 需求依据及假设：用户 2026-10-20 已确认四款工具图标（dsh 鲸鱼、dsh Web 浏览器里的鲸鱼、WorkBuddy 小猫、GPT/Codex 小机器人），dsh Web 图形已存在于 `src/renderer/ui.ts` 与 `assets/tool-icons/dsh-web.svg`；当前 `toolKind` 只按 monitor 类型区分，dsh 型任务全部得到 `dsh`，因此 Web 图形不可达。本规格按**配置**判定 Web/桌面（不按运行消息猜测），不新增用户必填字段。
> 关联/替代：SPEC-012「用户确认图标」一节明确本轮只保留 dsh Web 素材、不做自动分类；本规格补齐该缺口，不改变 SPEC-012 已验收的其他 UI 行为。

## 1. 问题与目标

- 现象：本机 `config.local.yaml` 中 `dsh-web` 任务（`monitor.type: dsh`，`jump.openUrl: http://127.0.0.1:13080`、`jump.openUrlViaExtension: true`）在悬浮灯/面板上显示的是桌面鲸鱼，与“浏览器里的鲸鱼”设计不符。
- 根因：`src/main/store.ts` 的 `presentationFor()` 仅按 `monitor.type` 映射（codex→codex、dsh→dsh、名称含 workbuddy→workbuddy、其余 generic），没有 dsh 桌面/Web 分类；`TaskState.toolKind` 联合类型也没有 `dsh-web`。图形本身已实现，属于“不可达分支”。
- 目标：dsh 型任务若配置了浏览器 URL 跳转能力，则 `toolKind` 为 `dsh-web`，悬浮灯/面板渲染「浏览器＋鲸鱼」；其余 dsh 任务保持桌面鲸鱼；其他工具映射不变。

## 2. 范围与非目标

- 本次包含：
  - `TaskState.toolKind` 增加 `dsh-web` 取值；
  - `presentationFor()` 从任务配置推导 dsh 桌面/Web（纯配置推导，热重载同步）；
  - 新增/更新元数据测试；`check:ui` 渲染夹具加入 `dsh-web`，产出真实渲染截图；
  - 更新 `assets/tool-icons/README.md` 中“未做 Web/桌面分类”的过时说明。
- 本次不包含：不新增配置字段、不新增 monitor 类型、不修改监控/IPC/跳转/状态机与优先级；不按运行消息或进程名猜测 Web/桌面；不重画 `ui.ts` 图形。
- 受影响模块：`src/main/store.ts`（显示元数据）、`src/shared/types.ts`（类型）、测试与 UI 渲染检查夹具、文档。配置向后兼容：无 URL 跳转字段的旧 dsh 配置行为不变。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | 两组 dsh 任务：一组配置 `jump.openUrl`（可含 `openUrlViaExtension` 等 URL 跳转字段），一组只有 `jump.cwd`/`windowTitle` | 构造 `TaskStore` | 前者 `toolKind: 'dsh-web'`；后者 `toolKind: 'dsh'`；界面图标分别为「浏览器+鲸鱼」「鲸鱼」（`ui.ts` 既有图形） |
| AC-02 | 任务初始为 dsh 桌面（或 Web） | `syncTasks()` 热重载为另一种配置 | `toolKind` 同步切换；`status`/`unread`/完成水位/`availableActions` 保持不变 |
| AC-03 | 既有 codex、WorkBuddy、未知类型任务 | 构造/热重载 | 映射仍为 codex/workbuddy/generic；dsh-web 的点击跳转与监控行为不变（不改这些路径） |
| AC-04 | 已构建应用 | 运行 `npm run check:ui` 与真机重启 | 渲染夹具与真实悬浮灯出现「浏览器+鲸鱼」图标，其余元素无回归 |

边界与兼容：`jump` 缺省、`jump.openUrl` 为空、无 URL 字段的 dsh 一律按桌面 `dsh` 处理；仅 `openUrlTitleMatch`/`openUrlDebugPort`/`openUrlViaExtension` 也视为 Web 跳转能力（它们只在浏览器 URL 场景有意义）。不修改配置校验规则，因此旧配置不需要迁移。

## 4. 方案与任务切片

1. 展示层判定切片（唯一行为改动）：新增内部纯函数判断 dsh 是否具备浏览器 URL 跳转字段；`presentationFor()` 据此给出 `dsh-web`。类型联合补 `dsh-web`。
2. 验证切片：先补 `test/ui-metadata.test.ts` 断言（dsh-web 识别、桌面 dsh 不变、热重载切换），运行得到有效 Red；实现后 Green。
3. 渲染证据切片：`scripts/ui-render-check.cjs` 夹具的 `toolKind` 循环加入 `dsh-web`，`npm run check:ui` 产出截图与 `results.json`；真机重启后截图确认悬浮灯 Web 行图形。
4. 文档切片：更新 `assets/tool-icons/README.md` 与规格索引/记录（纯文档，TDD 不适用）。

## 5. 测试计划与追踪

| AC | 测试文件/完整用例名或真机步骤 | Red 证据 | Green 证据 | 回归/平台验收 |
| --- | --- | --- | --- | --- |
| AC-01 | `test/ui-metadata.test.ts` 新增「dsh Web 任务按配置使用浏览器图标」用例 | 待填 | 待填 | 本机 |
| AC-02 | 同文件热重载用例补充 dsh↔dsh-web 切换断言 | 待填 | 待填 | 本机 |
| AC-03 | 同文件既有四类映射用例（保持通过） | 不涉及 | 待填 | 本机 |
| AC-04 | `npm run check:ui`（24 用例 + 截图）与真机重启截图 | 夹具未含 dsh-web 时截图无该图形（改造前状态） | 待填 | 本机 Windows |

证据包含命令、退出码、工作区状态、日志引用；Red 必须因目标行为缺失而失败，不使用编译错误或缺依赖冒充。

## 6. 执行记录

- 规格就绪依据：用户 2026-10-21 反馈 + 2026-10-20 图标确认记录；仍待澄清项：无（分类规则取配置 URL 跳转字段，为本规格显式假设）。
- 修改前回退：`npm test` 与 `npm run check:ui` 基线（本机 b1bc9d8）待记录；无既有失败预期。
- Red → Green → Refactor：待填。
- TDD 例外：文档更新与渲染夹具调整不以文本镜像测试冒充 TDD，以实际渲染截图与 `results.json` 验证。

## 7. 交付与验收

- [ ] 所有 AC 有验收证据，满足[流程 DoD](../development/spec-tdd.md)。
- [ ] 类型检查、全量测试、构建后 smoke / check:ui 结果已记录。
- [ ] 相关文档、规格索引已更新；无秘密或本机配置进入提交。
- [ ] 已知失败/未完成项、回退步骤、发布状态已说明。

最终结果/提交引用：待填写。
