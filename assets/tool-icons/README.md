# 工具简笔图

2026-10-20，根据用户“画几个简笔图分别对应这几个进程”的要求绘制。本组为原创示意图，不是官方商标。

| 文件 | 对应工具 | 造型 |
| --- | --- | --- |
| [dsh.svg](dsh.svg) | dsh / DeepSeek Harness | 小鲸鱼 |
| [dsh-web.svg](dsh-web.svg) | dsh Web | 浏览器窗口里的小鲸鱼 |
| [workbuddy.svg](workbuddy.svg) | WorkBuddy | 小猫 |
| [codex.svg](codex.svg) | GPT / Codex | 小机器人 |

2026-10-20 用户明确修订：WorkBuddy 对应小猫，GPT 对应小机器人，并增加 dsh Web 形式。本版替代首版对话搭档/小终端造型；GPT/Codex 先共用机器人素材，不新增或改变进程识别规则。

均为透明背景、24×24 viewBox、圆头单色线条的可缩放 SVG。状态颜色仍应由应用独立的状态点表达；图形本体保持中性。

[预览](preview.png)同时展示大图和实际 20/24/32px 尺寸。预览只使用本地图形，无远程资源。

2026-10-20 用户回复“没问题”确认画稿后，桌面鲸鱼、小猫、机器人已接入 `src/renderer/ui.ts` 并在实际指示灯加载。应用内使用 currentColor 跟随深浅色，状态点独立表达状态。

2026-10-21 用户指出「dsh Web 端的另一个图标（小鲸鱼在浏览器中）没有体现」后，按 [SPEC-019](../../docs/specs/019-dsh-web-icon.md) 补齐分类：dsh 型任务只要配置了浏览器 URL 跳转能力（`jump.openUrl` / `openUrlTitleMatch` / `openUrlDebugPort` / `openUrlViaExtension` 任一），显示元数据即为 `dsh-web`，悬浮灯/面板使用「浏览器＋鲸鱼」；没有这些字段的 dsh 仍是桌面鲸鱼。分类只依据任务配置推导，不新增必填配置，也不改变监控、IPC、跳转或状态行为。
