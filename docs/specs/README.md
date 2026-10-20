# 规格与迭代索引

新变更先复制 [_template.md](_template.md)，使用下一个三位编号，填清来源与验收后再进入实现。编号不重复使用，状态与规格正文同步；文件名示例 `002-log-path-portability.md` 仅示意，不代表该需求已获授权。

| Spec ID | 文档 | 类型 | 状态 | 备注 |
| --- | --- | --- | --- | --- |
| BASELINE-000 | [当前基线](000-baseline.md) | 接管现状 | observed | 从当前提交核对，不补造历史 TDD |
| SPEC-014 | [dsh 恢复后保留正常关闭](014-dsh-native-window-reveal.md) | 修复 | verifying | 803项/类型/构建/smoke通过；真实自身恢复前台确认，用户确认 X 可隐藏；多轮及面板触发矩阵待补 |
| SPEC-013 | [桌面跳转失败与窄灯条反馈](013-focus-failure-feedback.md) | 修复 | verifying | 789项与一次隐藏恢复通过；用户确认恢复但 X 无效，dsh 生命周期问题交 SPEC-014，完整矩阵仍待补 |
| SPEC-012 | [轻量桌面 UI 与面板操作](012-lightweight-desktop-ui.md) | UI / 交互 | verifying | 用户确认鲸鱼/小猫/机器人已接入；任务卡片/真实暂停；完整 DPI/多屏矩阵待补 |
| SPEC-011 | [Codex 授权等待 Hook](011-codex-approval-hooks.md) | 新能力 / 修复 | done | 746 测试/构建/smoke 通过；用户信任后真实审批黄灯→匹配工具返回蓝灯 PASS |
| SPEC-010 | [Codex 完成灯与长回合连续性](010-codex-completion-continuity.md) | 修复 | done | 722 项回归全过；真机蓝→绿连续保留 PASS，用户确认效果；点击矩阵仍归 SPEC-002 |
| SPEC-009 | [启动器配置参数转发](009-start-cli-arguments.md) | 修复 | done | 有效 Red/Green、709 项回归、Windows 指定配置启动通过；与 SPEC-010 一并按用户要求本地提交 |
| SPEC-008 | [软删除会话被当成完成](008-soft-deleted-sessions.md) | 修复 | verifying | SQL 排除 `deleted_at > 0`；老库无该列时兼容 |
| SPEC-007 | [自动熄灭后重复亮绿](007-dismiss-reannounce.md) | 修复 | verifying | dismiss 同时确认水位；重启不为陈旧完成亮绿 |
| SPEC-006 | [dsh 回合完成亮绿](006-dsh-turn-success.md) | 修复 / 能力补齐 | verifying | dsh 此前永不产生 success；现按回合完成推断 |
| SPEC-005 | [dsh 端口自动跟随](005-dsh-port-auto-follow.md) | 新能力 | verifying | `authority: auto`；桌面端换端口自动重发现 |
| SPEC-004 | [dsh 长回合被判空闲](004-dsh-long-turn-idle.md) | 修复 | verifying | `running=true` 用更宽静默阈值；端口漂移已由 SPEC-005 接管 |
| SPEC-003 | [扩展切标签可靠性](003-extension-tab-switch-reliability.md) | 修复 / 可观测性 | verifying | 真机已通过"点击切标签"；仅"重启 Chrome 后恢复"待烟测 |
| SPEC-002 | [三工具状态与切换](002-three-tool-reliability.md) | 修复 / 新能力 / 特征重构 | verifying | 代码与云端回归已实现，Windows 真机验收待执行 |
| SPEC-001 | [引入 specTDD](001-spec-tdd-adoption.md) | 纯文档/流程 | done | 不改变应用行为，基线失败单独披露 |

`observed` 仅用于接管基线；变更状态使用 `draft → ready → implementing → verifying → done`，阻塞时使用 `blocked`。

## 下一轮候选（尚未安排实现）

1. ~~dsh 端口自动跟随~~：已由 SPEC-005 落地（`authority: auto`）；可优化点见该规格"已知限制"（发现耗时 15~20 秒）。
2. **简单 todo 功能**：优先级低于 AI 指示灯，待上面两项真机验收后另建规格。
3. lockfile 与 CI 仍为后续候选。

后续功能需求沿用现有监控和窗口能力，不自动执行旧 `05-NEXT-PROMPT` 中曾提议的 `type: http`。
