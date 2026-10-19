# BASELINE-000：现有工程接管基线

> 状态：observed（现状记录，不是一次新的功能交付）
> 来源提交：`6dbe5a6`，已通过 fetch 核对与远端 `main` 一致
> 核对日期：2026-10-18

## 产品与架构

Windows 桌面 AI 任务状态指示灯（包名 `ai-task-indicator`）。Electron 33、strict TypeScript、原生 DOM/CSS，使用 `tsc` 编译，没有 React/Vue/Vite。主进程负责配置、监控、状态、窗口及跳转；preload/IPC 白名单连接渲染层。当前云机器是 Linux，只验证适用的开发能力。

## 当前能力与代码/测试入口

| 能力 | 代码入口（相对仓库根） | 现有验证入口（相对 `test/`） |
| --- | --- | --- |
| 七态、聚合、超时、暂停、完成确认水位 | `src/main/store.ts`、`src/shared/constants.ts` | `store*.test.ts` |
| process、log、webhook、dsh、sqlite 五类监控 | `src/main/monitors/`、`src/main/config.ts` | `process-enum-script.test.ts`、`log-tail.test.ts`、`webhook.test.ts`、`dsh*.test.ts`、`sqlite-monitor.test.ts` |
| dsh 多端口发现、轮询/推送仲裁、远端鉴权 | `dsh-discovery.ts`、`dsh-arbiter.ts`、`dsh-remote-auth.ts`（均在 monitors 下） | 对应同名测试及 `dsh-monitor.test.ts` |
| YAML 配置、热重载、位置写回去重 | `src/main/config.ts` | `config*.test.ts`，含 `config-writeback.test.ts` |
| 单灯/灯带、左右/顶部点阵停靠、共享可见性 | `src/main/overlay.ts`、`overlay-layout.ts`、`src/renderer/overlay.ts`、`src/shared/visibility.ts` | `overlay-layout.test.ts`、`visibility.test.ts`，桌面效果另需 Windows |
| 通知、点击确认、跳转与浏览器扩展 | `src/main/notify*.ts`、`focus.ts`、`extension-bridge.ts`、`extension/` | `notify-content.test.ts`、`focus.test.ts`、`extension-bridge.test.ts`、`store-ack-completion.test.ts` |

七态为 `idle / starting / running / waiting / success / failed / unknown`。上表表示实现和测试入口存在，运行是否通过以[本次验证](../development/baseline-validation.md)为准。

## 后续变更须保护的约束

| 约束 | 实现/验证依据 |
| --- | --- |
| 状态写入经 `TaskStore.apply()`；非法转移拒绝并留痕，不得凭空洗绿 | `src/main/store.ts`、`test/store.test.ts`、`test/store-extra.test.ts` |
| `failed -> success`、`unknown -> success/waiting` 禁止；`idle -> waiting/success` 和 `waiting -> success` 已有业务依据 | 同上；旧 SPEC 的 idle 转移表已落后，不能照搬 |
| 失败任务可由真实重试信号恢复；不能把禁止洗绿误解为永远不许重试 | `src/main/store.ts`、`test/store-extra.test.ts` |
| 完成确认水位防止用户点掉后同一完成事件再次点亮 | `test/store-ack-completion.test.ts` |
| 浮窗不显示 disabled、paused、failed、unknown 行；窗口尺寸与渲染共用规则 | `src/shared/visibility.ts`、`test/visibility.test.ts` |
| SQLite 判活同时看状态与新鲜度，不能将陈旧 working 永久显示运行中 | `src/main/monitors/sqlite.ts`、`test/sqlite-monitor.test.ts` |
| 应用自身配置写回不触发重复的“配置已重载”提示，用户真实编辑仍须识别 | `src/main/config.ts`、`test/config-writeback.test.ts` |
| 监控异常隔离，停止/重试/恢复可控；Webhook 保持 loopback 与输入校验 | `src/main/monitors/base.ts`、相关适配器及测试 |

若本轮需求确需改变这些约束，必须在新规格中明确变化与理由，先更新验收及测试，不因实现方便静默放宽。

## 历史资料的已知偏差

- `04-SPEC` 仍写三类监控、224 个测试和 dsh 未对接；实际已存在 dsh/sqlite。测试数不能沿用历史值。
- 初版 PRD 的 React/Vite 建议已被架构取舍替代；以当前清单、构建脚本和后续明确规格为依据。
- 原“下一步提示词”是新增 HTTP 轮询建议；现已替换为流程交接入口，不自动创建第六类监控。
- 历史报告的 Windows、SSH、浏览器与真实 dsh 成功记录属于原运行环境，本次没有重新验证。

当前不存在提交的 lockfile 或 CI 工作流；全量测试与 smoke 在 Linux 有已复现失败。本基线不保证跨平台运行、依赖完全复现或桌面验收完成。
