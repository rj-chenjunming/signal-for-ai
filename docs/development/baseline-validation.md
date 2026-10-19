# 接管验证记录

> 验证日期：2026-10-18（Asia/Shanghai）
> 代码提交：`6dbe5a6`；测试前应用/测试无本地修改
> 环境：Linux，Node 24.19.0，npm 11.9.0
> 定位：已有工程的真实基线，不能作为后续迭代的运行结果复用

## 同步与依赖

在 `/workspace/signal-for-ai` 执行 `git fetch origin main` 和 `git merge --ff-only origin/main`，结果 Already up to date。保留云任务原有 `work` 分支，不强行切换或重置。

按[云端安装命令](testing.md)安装依赖，退出码 0；跳过 Electron 二进制下载，未启动 GUI，未生成 lockfile。直接依赖解析结果：Electron 33.4.11、yaml 2.9.1、TypeScript 5.9.3、Vitest 2.1.9、electron-builder 25.1.8、electron-log 5.4.4、@types/node 22.20.5。它们是本次实装结果，不是版本固定承诺。

随后重复执行完整安装脚本（版本前置检查、相同 npm 安装命令、typecheck、build），安装报告 up to date，整段退出码 0，确认当前清单下可重复执行。该脚本和未来任务的目录/specTDD/检查说明已分别保存到云环境配置草稿的 `install_script`、`start_skill`；保存不执行、不应用或发布，后续跨任务恢复尚未验证。

## 检查结果

下列命令均在仓库根执行；构建成功后才执行 smoke。没有删除、跳过或改写测试。

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run typecheck` | 0 | main、renderer、test 三份类型检查通过 |
| `npm test -- --maxWorkers=2 --minWorkers=1` | 1 | 28 文件中 23 通过、5 失败；618 用例中 608 通过、10 失败，无跳过 |
| `npm run build` | 0 | 主进程、渲染层、资源复制通过 |
| `npm run smoke` | 1 | 22 项断言中 16 通过、6 失败；真实 HTTP Webhook 链路通过，glob/日志链路失败 |
| 仅重跑下表涉及的 5 个失败文件，同样使用 2 worker 参数 | 1 | 107 用例中 97 通过、10 失败，与全量失败清单一致 |

本次完成类型/构建和部分功能验证，**全量回归和 smoke 未通过**；未验收 Windows 桌面，不称应用就绪或环境全部验证通过。

## 已诊断的问题

| 编号 | 失败范围 | 证据与原因 | 后续建议 |
| --- | --- | --- | --- |
| B-01 | `log-tail.test.ts` 4 条、`store-waiting.test.ts` 3 条；smoke 6 条 | `globFiles()` 对 POSIX 绝对路径拆分后过滤空段，重拼 root 丢掉前导 `/`，导致真实存在的临时文件匹配为空。单独用现有 dist 探针复现：文件存在，glob 返回 0，重拼 root 非绝对路径。日志测试因此收不到状态事件 | 属于仓库的 Linux 路径兼容缺陷，另开 bugfix 规格，补绝对/相对及 Windows 路径用例后修复，不靠移动工作目录掩盖 |
| B-02 | `process-enum-script.test.ts` 1 条 | 测试真实执行 `powershell.exe`，Linux 返回 `spawn powershell.exe ENOENT` | Windows 平台能力前置缺失；单独规格划分平台测试，保留 Windows 必跑，不以安装 `pwsh` 冒充 `powershell.exe` 真机验证 |
| B-03 | `config-dsh.test.ts` 1 条 | 用例断言 `%USERPROFILE%` 展开后含反斜杠；本机未设置该变量，实际展开成 `/.dsh`，依赖 Windows 环境的假设不成立 | 测试应自行设置并恢复受控 Windows 路径夹具，另开测试隔离变更；不改机器全局变量去伪造通过 |
| B-04 | `dsh-monitor.test.ts` 1 条 | “本机密钥被拒绝后走远端兜底”用例直接读取 `homedir()/.dsh`。此处凭据文件不存在，第一次调用就正确走了注入的远端来源，`remoteFetches` 为 1 而断言要求 0 | 依赖作者本机的测试夹具缺陷；应在临时目录构造样本。不要求用户提供真实密钥以满足单测，本轮未创建或读取真实密钥值 |

B-01 是明确的应用跨平台缺陷；B-02 是平台前置；B-03/B-04 是不隔离本机条件的测试设计问题。Windows 行为是否有相同问题尚未重验，不从 Linux 失败推断 Windows 已坏或已通过。

## 未运行的验收

- Electron GUI：托盘、通知/声音、焦点、左右/顶部停靠、跨屏/DPI、穿透交互。
- Chrome 扩展的真实标签页激活，真实 dsh/SSH/WorkBuddy 数据库集成。
- Windows NSIS 打包与安装。

本轮仅整理文档，没有这些行为的新增验收目标。后续若变更涉及这些路径，必须按规格验收；不能继承历史报告的成功结论。

## 本次文档检查

本轮新增/调整 Markdown 的本地文件链接、规格状态、脚本命令与 `package.json` 对应关系已核对，`git diff --check` 通过。应用源码、原测试、依赖清单与历史同步副本保持原样；生成的 `node_modules/`、`dist/` 已被原忽略规则排除。

本记录不接受或豁免后续行为变更的失败；是否允许带具体既有失败交付，须遵循[完成门槛](spec-tdd.md)。建议下一轮先收敛上述基线，再开展功能迭代。

## 后续修复追踪

上述数字保留为 6dbe5a6 接管时证据。B-01～B-04 已在 [SPEC-002](../specs/002-three-tool-reliability.md) 中修复或按平台划分；最新回归结果见该规格，不再将本页旧失败当作当前工作区状态。Windows 真机仍单独验收。
