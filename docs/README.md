# 文档入口

后续开发从本页进入。**specTDD = 先定义可验收规格，再逐项测试先行，最后凭证据交付。**

| 文档 | 用途 |
| --- | --- |
| [开发流程](development/spec-tdd.md) | 阶段、进入/退出条件、完成门槛 |
| [测试与验收](development/testing.md) | 本项目命令、测试分层、Windows 与云端边界 |
| [三工具桌面验收](development/desktop-validation.md) | dsh / WorkBuddy / Codex 配置、边界与真机清单 |
| [Codex 授权 Hook](development/codex-approval-hooks.md) | 可选审批黄灯、安装信任与验证边界 |
| [规格索引](specs/README.md) | 本轮规格、迭代状态、下一步 |
| [当前基线](specs/000-baseline.md) | 已有能力、不变量、代码/测试入口 |
| [变更模板](specs/_template.md) | 新需求、缺陷、重构的统一工作记录 |
| [基线验证记录](development/baseline-validation.md) | 本次真实运行结果和已知失败 |
| [AI 任务提示词](05-NEXT-PROMPT.md) | 后续开发可直接复用的任务入口 |
| [仓库执行约束](../AGENTS.md) | 人与 AI 都须遵循的规则 |

## 文档职责与冲突处理

- 产品目标和使用方法：根 [README](../README.md)。
- 后续期望行为：`specs/` 中处于 `ready` 或后续状态、且有需求依据的变更规格。新规格明确列出替代的旧条款，不默默覆盖历史。
- 当前实际行为：`000-baseline.md` 中的代码/测试映射，以及当前代码和实测。它是接管基线，不代表全部行为已通过验收，也不把已有缺陷升级成需求。
- 工作方式：`development/spec-tdd.md` 与根 `AGENTS.md`。
- 规格、实现或历史结论冲突时，登记差异并核实需求来源；不得为了让测试通过而擅自改需求，也不得照搬有缺陷的实现当作目标规格。

## 历史资料

| 文档 | 当前定位 |
| --- | --- |
| [01-PRD](01-PRD.md) | 初版产品目标、竞品与早期方案；技术栈建议已有后续取舍 |
| [02-ARCHITECTURE](02-ARCHITECTURE.md) | 初版架构与设计理由；阅读时结合当前代码 |
| [03-POC-REPORT](03-POC-REPORT.md) | 原 Windows 环境的 POC 证据，不能视作本云环境重验 |
| [04-SPEC](04-SPEC.md) | 早期三类监控规格；其中“尚缺 dsh”等状态已经过时 |
| [决策台账](design-decisions.md) | 设计演进、失败教训和后续决策 |
| `round*.md` | 逐轮历史实测与修复记录，数字只属于各自当次运行 |

`scripts/sync-docs.mjs` 只同步 `design-decisions.md` 与 `round*.md`，默认源为仓库外 `../docs`。这两类文件保留原编辑/脱敏流程；新 `development/`、`specs/`、本页和交接提示词直接在本仓库维护。普通 clone 缺少外部源时不需要运行同步脚本，退出码 2 表示前置条件缺失。
