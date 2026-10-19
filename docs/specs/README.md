# 规格与迭代索引

新变更先复制 [_template.md](_template.md)，使用下一个三位编号，填清来源与验收后再进入实现。编号不重复使用，状态与规格正文同步；文件名示例 `002-log-path-portability.md` 仅示意，不代表该需求已获授权。

| Spec ID | 文档 | 类型 | 状态 | 备注 |
| --- | --- | --- | --- | --- |
| BASELINE-000 | [当前基线](000-baseline.md) | 接管现状 | observed | 从当前提交核对，不补造历史 TDD |
| SPEC-002 | [三工具状态与切换](002-three-tool-reliability.md) | 修复 / 新能力 / 特征重构 | verifying | 代码与云端回归已实现，Windows 真机验收待执行 |
| SPEC-001 | [引入 specTDD](001-spec-tdd-adoption.md) | 纯文档/流程 | done | 不改变应用行为，基线失败单独披露 |

`observed` 仅用于接管基线；变更状态使用 `draft → ready → implementing → verifying → done`，阻塞时使用 `blocked`。

## 下一轮候选（尚未安排实现）

用户已提出简单 todo 功能，优先级低于 AI 指示灯；本轮只登记，待 SPEC-002 真机验收后另建规格，确认新增、完成、删除和本地持久化的最小范围。基线收敛已纳入 SPEC-002；lockfile 与 CI 仍为后续候选。

后续功能需求沿用现有监控和窗口能力，不自动执行旧 `05-NEXT-PROMPT` 中曾提议的 `type: http`。
