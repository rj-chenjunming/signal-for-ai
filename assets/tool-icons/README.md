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

2026-10-20 用户回复“没问题”确认画稿后，桌面鲸鱼、小猫、机器人已接入 `src/renderer/ui.ts` 并在实际指示灯加载。应用内使用 currentColor 跟随深浅色，状态点独立表达状态。dsh Web 图形作为 `dsh-web` 素材保留；当前监控配置仍映射桌面 dsh，没有新增 Web/桌面自动分类。此切片不改变配置、监控、IPC 或跳转行为，TDD 不适用；回归、实际渲染与运行记录见 [SPEC-012](../../docs/specs/012-lightweight-desktop-ui.md)。
