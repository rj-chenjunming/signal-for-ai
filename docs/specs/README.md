# 规格与迭代索引

新变更先复制 [_template.md](_template.md)，使用下一个三位编号，填清来源与验收后再进入实现。编号不重复使用，状态与规格正文同步；文件名示例 `002-log-path-portability.md` 仅示意，不代表该需求已获授权。

| Spec ID | 文档 | 类型 | 状态 | 备注 |
| --- | --- | --- | --- | --- |
| BASELINE-000 | [当前基线](000-baseline.md) | 接管现状 | observed | 从当前提交核对，不补造历史 TDD |
| SPEC-027 | [目标进展本地同步入口](027-goal-progress-sync.md) | feature（自动化/集成） | done | `goal-sync` CLI + goal-inbox 轮询导入；Red 8失败 → Green 10；全量 928；实机 4 条 1 秒内导入、收件箱清空 |
| SPEC-026 | [目标卡片拖拽排序](026-goal-reorder.md) | feature（交互） | done | 用户 2026-10-22 真机确认「验证通过了」；Red 6失败 → Green 40；全量 918、check:ui/check:goals PASS |
| SPEC-025 | [悬浮灯「目标」行与新目标图标](025-overlay-goals-row.md) | feature（显示集成） | done | 用户 2026-10-22 12:31 真机确认「没问题」；Red 3失败 → Green 56；全量 909、check:ui 31、check:goals PASS |
| SPEC-024 | [目标清单（独立窗口/进度/时间线/导出）](024-goals.md) | feature | done | 用户 2026-10-22 12:21 重启真机确认通过；全量 897、smoke、check:ui、check:goals 通过 |
| SPEC-023 | [dsh 点击后窗口无法关闭（回归）](023-dsh-close-after-focus.md) | bugfix（回归） | done | dsh 一律单实例恢复、不再 Win32 最小化；Red 2失败/Green 114、全量 863；真机 1.786s，用户确认 X 正常 |
| SPEC-022 | [桌面切换延迟（点击任务行到前台确认）](022-focus-latency.md) | bugfix（性能/交互时延） | done | 缓存优先 + 原生脚本内前台确认；真机 WorkBuddy 2.18s、dsh 1.90s（原 5.5–14s）；Red 7失败/Green 104、全量 862 项 |
| SPEC-021 | [dsh 长回合活跃信号](021-dsh-long-turn-liveness.md) | feature（状态判定） | done | asOfSeq/tokenUsage/contextPressure 指纹延长 running；Red 2失败/Green 98、全量 858；真机静默 645 秒 dsh 行仍蓝；卡死侧由测试覆盖 |
| SPEC-020 | [后台窗口恢复（隐藏/最小化）](020-window-reveal-hidden-minimized.md) | 修复/行为补齐 | done | 隐藏查找支持 windowTitle＋processNames；仅隐藏候选/windowProcess 走单实例，可见/最小化 windowTitle 保持 Win32（15:28 真机回归已修）；Red 15→1失败/Green 57、全量852项；16:06 用户确认 dsh/WorkBuddy 恢复与 X 后台均正常 |
| SPEC-019 | [dsh Web 使用浏览器+鲸鱼图标](019-dsh-web-icon.md) | feature（显示元数据） | done | 按配置 URL 跳转字段区分 dsh 桌面/Web；Red 2失败/Green 4通过；15:18 check:ui 24 用例 PASS，夹具与实机悬浮灯截图均出现「浏览器+鲸鱼」 |
| SPEC-018 | [启动器配置参数转发](018-start-cli-arguments.md) | 修复 | done | 有效 Red/Green、709 项回归、Windows 指定配置启动通过；原编号 SPEC-009，2026-10-21 与 dsh 看门狗规格冲突后改为 018 |
| SPEC-017 | [桌面工具存在时才监控](017-desktop-process-presence.md) | 修复/行为 | done | 16:10 用户确认真正退出 WorkBuddy 后行隐藏/不红、重开自动恢复；逻辑层/真实 tasklist/进程 IO 与全量 852 项通过 |
| SPEC-016 | [Windows双击启动入口](016-desktop-start-script.md) | 新能力 | done | 824项/类型/构建/smoke通过；真实cmd从其他目录启动及单实例复用通过，保留配置与自动运行时回退 |
| SPEC-015 | [WorkBuddy 恢复后可关闭到后台](015-workbuddy-native-window-reveal.md) | 修复 | done | 16:06 用户确认最小化恢复后 X 仍可后台；此前 X 隐藏、原生恢复、隔离夹具与全量 852 项证据保留 |
| SPEC-014 | [dsh 恢复后保留正常关闭](014-dsh-native-window-reveal.md) | 修复 | done | 16:06 用户确认 dsh 隐藏/最小化后侧边图标与面板均恢复、X 仍可后台；SPEC-020 修复与真机证据见该规格 |
| SPEC-013 | [桌面跳转失败与窄灯条反馈](013-focus-failure-feedback.md) | 修复 | done | 17:14 独立实例受控失败：真实点击→面板完整提示“未找到…主窗口”；窄灯条 201 字长消息单行省略（nowrap/ellipsis/高 29）；隐藏恢复已由用户确认 |
| SPEC-012 | [轻量桌面 UI 与面板操作](012-lightweight-desktop-ui.md) | UI / 交互 | done | 16:15 用户确认三边停靠/多屏/DPI 正常；15:38–15:44 真实面板、dsh 切回、暂停/恢复通过；check:ui 24 场景与全量 852 项通过 |
| SPEC-011 | [Codex 授权等待 Hook](011-codex-approval-hooks.md) | 新能力 / 修复 | done | 746 测试/构建/smoke 通过；用户信任后真实审批黄灯→匹配工具返回蓝灯 PASS |
| SPEC-010 | [Codex 完成灯与长回合连续性](010-codex-completion-continuity.md) | 修复 | done | 722 项回归全过；真机蓝→绿连续保留 PASS，用户确认效果；点击矩阵仍归 SPEC-002 |
| SPEC-009 | [dsh 轮询看门狗](009-dsh-poll-watchdog.md) | 修复 | done | 单轮挂死不静默；warn + 立即排下一轮；2026-10-21 用户真机确认 dsh-web 行蓝→绿正常 |
| SPEC-008 | [软删除会话被当成完成](008-soft-deleted-sessions.md) | 修复 | done | 17:54 真实完成正常亮绿/10 分钟熄灭；18:30 前 36 分钟静置完成水位不变、无幽灵绿；软删除 8 条仍被排除（`logs/spec008-quiet-final.log`） |
| SPEC-007 | [自动熄灭后重复亮绿](007-dismiss-reannounce.md) | 修复 | done | 17:54:40 完成 → 18:05 熄灭 → 18:30 仍灰；25 分钟静置采样水位恒定、不复亮（`logs/spec007-*`） |
| SPEC-006 | [dsh 回合完成亮绿](006-dsh-turn-success.md) | 修复 / 能力补齐 | done | dsh 此前永不产生 success；现按回合完成推断；2026-10-21 用户真机确认变绿保持、确认后不复亮 |
| SPEC-005 | [dsh 端口自动跟随](005-dsh-port-auto-follow.md) | 新能力 | done | 16:52–16:53 真机：dsh 重启 52119→56388，自动发现选中新端口并恢复；用户确认通过 |
| SPEC-004 | [dsh 长回合被判空闲](004-dsh-long-turn-idle.md) | 修复 | done | 16:54 新回合 running 静默 28 秒、dsh 行蓝色截图；16:11 长静默 4547 秒→idle 属 AC-03 预期；全量 852 项通过 |
| SPEC-003 | [扩展切标签可靠性](003-extension-tab-switch-reliability.md) | 修复 / 可观测性 | done | 16:10 用户重启 Chrome 后点击 dsh-web 通过；重载/长轮询/点击切标签证据保留 |
| SPEC-002 | [三工具状态与切换](002-three-tool-reliability.md) | 修复 / 新能力 / 特征重构 | verifying | 16:15 用户确认托盘/通知/toast 正常；15:38/15:45 dsh 侧边图标与面板点击真机通过，WorkBuddy 最小化恢复通过；Codex 实际窗口/数据面与并行矩阵仍待验收 |
| SPEC-001 | [引入 specTDD](001-spec-tdd-adoption.md) | 纯文档/流程 | done | 不改变应用行为，基线失败单独披露 |

`observed` 仅用于接管基线；变更状态使用 `draft → ready → implementing → verifying → done`，阻塞时使用 `blocked`。

## 下一轮候选（尚未安排实现）

1. ~~dsh 端口自动跟随~~：已由 SPEC-005 落地（`authority: auto`）；可优化点见该规格"已知限制"（发现耗时 15~20 秒）。
2. ~~简单 todo 功能~~：已由 [SPEC-024](024-goals.md) 落地为「目标清单」；悬浮灯展示由 [SPEC-025](025-overlay-goals-row.md) 落地，两者均已真机确认通过。
3. lockfile 与 CI 仍为后续候选；JSON 导入/导出与窗口位置记忆未实现（见 SPEC-024 非目标）。

后续功能需求沿用现有监控和窗口能力，不自动执行旧 `05-NEXT-PROMPT` 中曾提议的 `type: http`。
