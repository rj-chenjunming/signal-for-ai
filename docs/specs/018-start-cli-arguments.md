# SPEC-018：启动器保留 npm 传入的配置参数

> 编号说明：本规格最初为 SPEC-009；2026-10-21 合并远端时发现与 `009-dsh-poll-watchdog.md` 编号冲突，按“已公开编号不动、未推送规格改号”改为 SPEC-018。正文中的历史记录保持当时事实，仅编号与链接同步。
> 状态：done
> 类型：bugfix
> 需求来源：2026-10-19 用户要求在 Windows 用 `npm start -- --config ./config.local.yaml` 启动真实三工具监控。
> 负责人：Codex
> 基线提交与环境：`dbca9cf`；Windows、系统 Node 24.16.0、npm 11.13.0。
> 需求依据及假设：npm 消耗自身的 `--`；启动器收到的是直接参数。用户已授权诊断和按 specTDD 修复启动失败。
> 关联/替代条款：修复 README 与桌面验证指南已经约定的命令，不改变配置优先级。

## 1. 问题与目标

`scripts/start.mjs` 仅转发分隔符之后的参数，没有分隔符则转发空数组。npm 已消耗分隔符，因此文档命令的 `--config` 被静默丢弃，可能加载默认配置而非本地三工具配置。

## 2. 范围与非目标

- 包含启动器的参数转发及回归测试；保留 Electron 环境清理、GPU 默认值、退出码/错误处理。
- 不改变监控器、配置解析、依赖清单、窗口交互和工具数据库。
- 影响 `scripts/start.mjs`；已有启动命令无需改写。

## 3. 验收条件

| ID | Given | When | Then |
| --- | --- | --- | --- |
| AC-01 | npm 将 `--config` 和路径直接传给启动器 | 启动 | Electron 收到相同参数，带空格路径保持一个参数 |
| AC-02 | 旧调用在参数前显式加 `--`，或无参数 | 启动 | 旧调用继续剥去分隔符；无参数使用默认 GPU 参数 |
| AC-03 | 直接传 `--enable-gpu`，环境有 `ELECTRON_RUN_AS_NODE=1` | 启动 | GPU 覆盖生效，子进程环境剔除该变量 |
| AC-04 | 子进程非零退出或触发启动 error | 启动失败 | 启动器保留非零退出码或以 1 报错，不声称成功 |

边界：不拆分参数文本，不执行 shell；不改变原有含显式分隔符的处理策略。缺 Electron 继续使用既有错误分支。

## 4. 方案与任务切片

先在隔离临时目录执行原始启动脚本，以 stub Electron 包和子进程捕获实际 argv/env；不启动真实 GUI、不接触个人配置。运行并记录有效 Red 后，只修改无分隔符时的参数回退值。无需重构。

## 5. 测试计划与追踪

| AC | 测试/验收 | Red | Green | 回归/平台验收 |
| --- | --- | --- | --- | --- |
| 01/03 | `test/start-launcher.test.ts` 中 npm 参数与 GPU 覆盖用例 | 2 个目标断言失败，退出 1 | 6 个启动器用例通过，退出 0 | Windows 真进程加载 CLI 配置，见下方记录 |
| 02/04 | 同文件显式分隔符、无参数、子进程退出/error 用例 | 4 个保护性用例原实现已通过，不伪造 Red | 继续通过 | 全量测试 709/709；类型检查/构建/smoke 退出 0 |

## 6. 执行记录

- 工作目录：仓库根；源码尚未修改。依赖安装中，不能把缺依赖视为 Red。
- 规格就绪：需求与调用契约明确，无依赖未知项。
- TDD 例外：无；本机配置与验证报告不改变产品行为，不另造 Red。
- 2026-10-19 23:13（北京时间），`dbca9cf` + 新规格/测试，启动器尚未修改：`npm run typecheck` 退出 0；`npm test -- test/config.test.ts test/config-codex.test.ts test/focus-reliability.test.ts --maxWorkers=2 --minWorkers=1` 退出 0，3 文件 28 测试通过。
- Red：`npm test -- test/start-launcher.test.ts --maxWorkers=2 --minWorkers=1` 退出 1，6 用例中 4 通过、2 失败。`forwards npm-style config arguments without an extra separator, preserving spaces` 实际得到 GPU flags 而非配置参数；`honors direct enable-gpu and cleans the child environment` 实际仍添加禁用 GPU flags。失败是目标参数行为缺失，无缺依赖/编译错误。日志：`logs/spec009-red.log`（忽略的本地证据）。
- Green：只把无分隔符时的转发值从 `[]` 改为 `argv`。`npm test -- test/start-launcher.test.ts test/config.test.ts test/config-codex.test.ts test/focus-reliability.test.ts --maxWorkers=2 --minWorkers=1` 退出 0，4 文件 34 用例通过，日志 `logs/spec009-green.log`。无必要重构。
- 回归依次执行：`npm run typecheck` 退出 0；`npm test -- --maxWorkers=2 --minWorkers=1` 在沙箱外退出 0，38 文件 709 用例通过、0 跳过（包含真实 Windows PowerShell 解析）；`npm run build` 退出 0；构建后的 `npm run smoke` 在沙箱外退出 0，22 项通过。日志为 `logs/typecheck.log`、`logs/test-windows.log`、`logs/build.log`、`logs/smoke-windows.log`。
- 保留环境失败证据：同一全量测试在沙箱内退出 1（657 通过、52 失败，涉及回环网络 EACCES/PowerShell 限制）；smoke 沙箱内退出 1（本机 HTTP EACCES）。没有为此删断言或修改产品行为；获得沙箱外运行权限后原命令通过。
- 2026-10-19 23:19 Windows 启动：`npm start -- --config ./config.local.yaml --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1`。`logs/startup.stdout.log` 显示完整参数已传至 Electron；应用日志显示 `配置已加载：--config 指定（3 个任务）`、托盘和悬浮窗创建、启动完成。运行实例 PID 5216，悬浮窗有真实主窗口句柄；诊断口实际仅绑定 `127.0.0.1`。本项验收启动参数，不据此宣称点击/托盘外观真机验收完成。

## 7. 交付与验收

- [x] AC 与自动检查有证据。
- [x] Windows 启动加载指定配置。
- [x] 文档、规格索引同步，无凭据提交。
- 发布状态：本地修复，不提交、不推送；桌面点击验收与本启动器修复分别记录。
- 相关平台限制与恢复步骤见[Windows 本机验证记录](../development/windows-local-validation-2026-10-19.md)。SPEC-002 保持 verifying；本规格 done 仅覆盖启动器契约。回退可仅恢复启动器这一行并使用旧显式分隔符调用，不覆盖个人配置。
- 后续授权更新：用户在 SPEC-010 完成灯真机验证后确认“看着没问题了”，要求提交 Git，故将本启动参数修复、测试与文档一并创建本地提交；没有自动推送授权。上方“未提交”保留为实施时状态，提交引用见 Git 历史。
