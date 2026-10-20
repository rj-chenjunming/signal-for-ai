# 测试与验收

所有命令默认在仓库根执行，云端路径为 `/workspace/signal-for-ai`。产品目标平台是 Windows 10/11；Linux 云端用于代码、类型检查、构建及适用的测试，不能替代桌面验收。

## 安装

`package.json` 要求 Node ≥20；SQLite 监控会另起系统 Node 使用 `node:sqlite`，需要 Node ≥22.5（早期版本需相关实验开关，建议使用 Node 24）。Electron 33 内置 Node 与系统 Node 是两个运行时，不能混为一谈。

仓库当前**没有提交 lockfile**。安装使用清单的 semver 范围，不能声称依赖版本完全可复现，也不能直接要求 `npm ci`。为保持本轮文档变更范围，未生成锁文件；固定依赖及建立 CI 留待单独规格。

Windows 桌面开发：

```bash
npm install --package-lock=false
npm run build
npm run start:demo
```

Linux 无 GUI 的云端检查（Bash）：

```bash
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install --package-lock=false --no-audit --no-fund --cache /tmp/signal-for-ai-npm-cache
```

此变量只跳过 Electron 桌面二进制下载；保留 npm 正常完整性校验和其他安装逻辑。该安装方式适合测试/编译，**不能启动 Electron GUI**。切回桌面验证时必须安装对应平台的完整 Electron，不能复用 Linux 的 `node_modules` 到 Windows。

## 每轮行为变更的回归命令

```bash
npm run typecheck
npm test -- --maxWorkers=2 --minWorkers=1
npm run build
npm run smoke
```

按顺序执行并分别保存退出码；某步失败要分析，再决定是否可继续独立检查。`smoke` 读取 `dist/`，必须先成功构建，避免验证旧代码。两个 worker 是云端资源设置，不排除任何测试；桌面可用 `npm test` 默认并发。

切片测试示例（先按规格新增用例，再选择真实用例名）：

```bash
npm test -- test/store-ack-completion.test.ts -t '用例名称'
```

必须确认至少执行一个目标用例且命中预期断言。不能把未命中筛选、零测试、超时、缺环境或旧失败当成有效 Red/Green。捕获日志时保留底层退出码；同一条失败命令不因改写统计口径变成通过。

## 分层与证据边界

| 层次 | 现有入口 | 验证范围/限制 |
| --- | --- | --- |
| 纯逻辑/组件 | `test/store*.test.ts`、`pattern*.test.ts`、`visibility.test.ts` | 状态机、超时、确认水位、判定规则，不证明桌面窗口行为 |
| 配置/IO | `test/config*.test.ts`、`log-tail.test.ts`、`store-waiting.test.ts` | YAML、文件写回、真实日志追加；必须隔离本机环境 |
| HTTP/适配器 | `webhook.test.ts`、`dsh*.test.ts`、`extension-bridge.test.ts` | 本地 HTTP/协议及错误隔离；部分是注入源，不代表真实 dsh 已通 |
| 布局/系统脚本 | `overlay-layout.test.ts`、`focus.test.ts`、`process-enum-script.test.ts` | 几何/脚本/策略；其中 PowerShell 解析用例真实调用 `powershell.exe` |
| 无窗口集成冒烟 | `npm run build` 后 `npm run smoke` | 配置、状态机、glob、日志、真实 HTTP 闭环，不是 Electron GUI E2E |
| Windows 桌面 | `npm run start:demo`；按 AC 操作 | 置顶、拖拽/左右及顶部停靠、DPI/多屏、通知/声音/焦点、托盘和扩展 |
| 用户环境集成 | `scripts/sqlite-monitor-check.mjs`、`scripts/live-dsh-check.mjs` 等 | 需要授权范围内真实服务/数据库/本地配置，先阅读脚本前置；不自动连接未知主机 |
| Windows 打包 | `npm run dist` | 仅影响打包/分发时必须做；NSIS 成功不代表安装与桌面行为已验证 |
| Electron 渲染夹具 | 构建后 `npm run check:ui` | 隐藏窗口验证四种布局/长列表/深浅色，截图在 `logs/spec012-ui`；无真实工具 IO，不替代 OS 鼠标、托盘、DPI/多屏验收 |

## Windows 与外部服务验收记录

对每个相关 AC 记录：Windows/Node/Electron 版本、构建提交、配置模板及脱敏覆盖项、前置条件、操作步骤、预期、实际、日志/截图位置。扩展用仓库 `extension/` 按[安装说明](../../extension/README.md)加载；不能以 mock 命中代替真实标签页切换。

真实凭据只放忽略的 `config.local.yaml` 或安全环境设置，不写进规格、输出或提示词。不向用户索取聊天中的完整带 token URL。测试应自建临时文件/数据库/密钥样本，而不是要求贡献者安装个人 dsh 凭据；接管时的夹具缺陷见[基线记录](baseline-validation.md)，SPEC-002 已做隔离修复。

## 文档变更

检查相对链接、路径与脚本是否存在、命令是否与 `package.json` 一致、规格索引/状态是否一致，并运行 `git diff --check`。不为文档改动编写镜像内容的测试。若同时改变可执行行为，则恢复正常 TDD 与回归要求。

三工具桌面组合的具体配置、信号边界与尚待执行的真机验收见[桌面指南](desktop-validation.md)。
