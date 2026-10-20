# Codex 审批黄灯（SPEC-011）

本功能是可选的官方 Hook 旁路。正常生命周期仍从只读 rollout 获取；不修改 Codex 的数据库、会话或认证文件。用户选择的语义为：请求审批时黄灯，对应工具返回后恢复蓝灯。因此点击“允许”之后、工具尚未返回的这段时间，灯仍可能为黄色。

## 配置与信任

1. 保留已有 `config.local.yaml`，给 Codex 任务的 `monitor` 合并 `approvalEventsFile: C:/your-repo/logs/codex-hook-events.jsonl`。用绝对路径，把事件文件放在应用自己的忽略目录，不放入 Codex sessions 目录。默认未设置时完全沿用原采集行为。
2. 备份并合并用户的 `~/.codex/hooks.json`；为 `PermissionRequest`、`PostToolUse`、`Stop`、`Interrupt`、`SessionEnd`、`UserPromptSubmit` 各添加以下 matcher group，保留原有 groups。不要给该组设置 matcher，以接收所有工具。

```json
{
  "hooks": [
    {
      "type": "command",
      "command": "node \"C:/your-repo/scripts/codex-status-hook.mjs\" --events \"C:/your-repo/logs/codex-hook-events.jsonl\"",
      "timeout": 3
    }
  ]
}
```

3. 使用系统 Node 24，确保 `node` 在 Codex 启动环境的 PATH 中。仓库移动后须相应修改路径并重新审阅。
4. **用户必须信任新 Hook**：官方明确要求对非 managed Hook 的具体定义审核信任。CLI 使用 `/hooks` 查看来源、审阅并信任这六项；如果桌面版提供相应 Hook 审核入口，也可在那里处理。不使用跳过信任参数，不修改信任数据库。当前对话启动前未加载的新定义，需在信任后按客户端提示刷新或开始新回合。
5. 构建后正常启动指示灯，不重复启动实例。首次真实事件产生前面板提示“授权 Hook 尚未连接”；文件存在本身不证明 Hook 已信任或所有事件均已接入。

该脚本读取官方 stdin JSON，仅输出 `{}`、退出 0；不返回任何 allow/deny/block/continue 决定。错误输入或写文件失败也中立返回，不能据此作出授权决定。事件文件只存版本、事件类型、session/turn 标识、时间、SHA-256 工具摘要和清理范围，不存命令、理由、用户正文或工具输出。不要把真实 stdin 或其他工具数据贴入问题报告。

## 行为及边界

| 事实 | 指示灯 |
| --- | --- |
| rollout 有真实开始，同 session/turn 有 PermissionRequest | 黄；优先于其他并行会话的蓝 |
| 对应 PostToolUse 返回 | 清一项等待；同输入并发按计数，全部清完后蓝 |
| 不相关工具返回、token 活动 | 不清理待批项 |
| Stop / Interrupt / SessionEnd / UserPromptSubmit | 按回合或会话清理，完成/失败事实仍由 rollout 判定 |
| 等待超过 waitingTimeoutMs、读取异常或待批证据丢失 | unknown，不猜已批准；沿用原浮窗隐藏规则 |
| Hook 未安装/未信任，事件文件尚不存在 | 原生命周期监控继续；面板注明未连接，不承诺黄灯 |

通过 session metadata 和 turn id 绑定，孤立审批不能绕过 `unknown -> waiting` 保护。新回合不能继承旧等待；已到达的清理水位挡住晚到旧请求。Bash 以规范化 command/cmd 的摘要匹配，忽略权限理由；其他工具对规范化输入取摘要，输入形态改变无法证明对应时保留等待，直到明确清理或超时。官方 PermissionRequest 没有单调用 tool_use_id，因此相同输入的并发调用只能按摘要计数，无法证明逐调用严格对应，混入相同输入但未审批的调用也可能影响计数。没有保证“拒绝瞬间恢复”的独立 Hook；没有 PostToolUse 的拒绝依靠 Interrupt/Stop 等清理。

读取复用每文件每轮 512 KiB 的增量 JSONL 游标、256 KiB 行限制；半行补齐后才生效。最多保留 128 个 session/turn、每回合 128 个工具摘要、同摘要 128 计数及 128 个清理水位，超限明确 unknown。事件日志是本地忽略文件，目前不自动轮换；如要清理，应在没有待批任务时停止指示灯，备份日志后重启。运行期间丢失待批日志会降级。

## 本机验收状态（2026-10-20）

代码回归已完成：746 项测试、类型检查、构建、smoke 通过。已备份本地配置并安装六项用户 Hook；未写信任存储。旧指示灯通过自身退出 API 关闭，确认退出后启动新版，主进程 PID 29928；三行真实 DOM 可见、布局仍为右侧灯带，初次检查 Codex 灰色空闲，面板明确 Hook 尚未连接。

随后用户明确回复“完成了”。真实 Hook 已产生本聊天的清理和工具返回事件，面板未连接提示消失；无需再次安装或重启。00:42:47 真实审批对应 snapshot/DOM 为 waiting、可见黄色 `rgb(245, 158, 11)`；匹配工具返回后，00:43:05 snapshot/DOM 为 running、可见蓝色 `rgb(59, 130, 246)`。只读观察器 `logs/spec011-real-approval.jsonl` 记录 PASS 并退出，未注入任何模拟事件。该记录替代最初的待信任/待验收状态，SPEC-011 已 done。

没有把 DOM 正确扩大为托盘目视或点击切换已通过。当前工具集不提供可用桌面操作能力，沿用 SPEC-002 的点击验收缺口；同输入并发匹配和恢复时机的边界仍如上文。

恢复入口：[SPEC-011](../specs/011-codex-approval-hooks.md)、[桌面验收](desktop-validation.md)。依据：[官方 Hooks 配置与信任、事件契约](https://learn.chatgpt.com/docs/hooks)，2026-10-20 核对；后续 Codex 升级需要再核对。
