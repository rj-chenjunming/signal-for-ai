# AI 任务状态指示灯 · 需求规格说明

> **已由后续规格接管**：下文是早期三类监控阶段的历史快照。“尚缺 dsh”、测试数量和部分转移表已经过时，不作为新迭代指令。当前入口：[现有工程基线](specs/000-baseline.md)、[规格索引](specs/README.md)、[specTDD 流程](development/spec-tdd.md)。

> **文档目的**：这是一份给「下一个接手的人（或 AI）」看的规格说明。
> 包含：要做什么、现在做到哪了、踩过哪些坑、下一步做什么。
>
> **项目路径**：`D:/projects/ai-task-indicator`
> **更新日期**：2026-10-13
> **当前状态**：功能可用，核心链路已实测通过，尚缺 dsh 对接

---

## 一、TL;DR

一个 Windows 桌面应用，把「AI 任务现在什么状态」用**托盘图标 + 桌面悬浮灯**显示出来：
绿色=完成、红色=崩溃、黄色=卡住等你授权、蓝色=正在跑。

**已完成**：三种监控方式（进程 / 日志 / Webhook）、完整状态机、托盘与悬浮灯 UI、224 个测试。
**未完成**：对接用户实际的 dsh（DeepSeek Harness）任务。

---

## 二、要解决的问题

### 2.1 用户痛点

用 AI 干活时最难受的三个瞬间：

| 时刻 | 体验 |
|---|---|
| 提交一个长任务后离开 | 不知道跑到哪了，得回去翻终端 |
| 任务卡住等授权 | 人不在，回来才发现白等了几小时 |
| 任务崩了 | 完全没有感知，重新打开才发现白跑了 |

**现有方案的不足**（竞品检索 26 个项目后的结论）：

- `tmux-agent-indicator`（★98）设计最好，但**必须跑 tmux**，Windows 原生没有
- `ai-status-light-esp32` 输出到 **ESP32 硬件**，不是桌面
- `claude-status-bar`（★707）只支持 macOS
- Electron 形态的（`agent-pulse`、`dsh-desktop`）**无 LICENSE 或强绑单一 Agent**，不可 fork

### 2.2 结论：不做二次开发

无一个候选同时满足「Windows + 托盘 + 悬浮灯 + 多任务 + 三类监控」。
**托盘、置顶窗、通知全部直接用 Electron 官方 API**，原创部分是任务模型 + 监控适配器 + 状态机。

### 2.3 竞品检索原始数据

见 `docs/_archive/_search_raw.json`（GitHub API 实时返回，26 个候选的 star / 语言 / 最近提交）。

---

## 三、功能需求

### 3.1 核心概念

**任务（Task）**：一个被监控的工作单元。有唯一 `id`、显示名、监控配置。

**七种状态**：

| 状态 | 灯色 | 含义 |
|---|---|---|
| `idle` | ⚪ 灰 | 未开始 |
| `starting` | 🔵 青 | 已启动，还没收到实质信号 |
| `running` | 🔵 蓝 | 正在干活 |
| `waiting` | 🟡 黄 | 卡住，等你授权 |
| `success` | 🟢 绿 | 完成 |
| `failed` | 🔴 红 | 崩溃 |
| `unknown` | ⚫ 深灰 | 失联（监控源断了） |

**聚合态（灯色）**：多个任务时的整体颜色。优先级：`failed` > `waiting` > `running` > `success` > 未知。

### 3.2 三种监控方式

#### 方式一：process 型（监控进程）

```yaml
monitor:
  type: process
  processNames: [node.exe, dsh.exe]
  cmdlineContains: ["run", "task"]   # 匹配命令行关键词
  rules:
    - state: failed
      match: (error|fatal)
```

**实现**：PowerShell `Get-CimInstance Win32_Process` 拿全量进程快照，增量 diff。
降级链：长驻 PS → 单次 PS → `tasklist`（只能匹配进程名）。

**⚠️ 已知环境限制**：`Get-CimInstance` 在部分沙箱环境会被拦截，导致监控源失联。
真实 Windows 上正常。

#### 方式二：log 型（监控日志文件）★ 推荐

```yaml
monitor:
  type: log
  paths:
    - "D:/your/project/**/*.log"
  rules:
    - state: failed
      match: (error|fatal|exception)
    - state: waiting
      match: (permission request|needs?_input)
    - state: success
      match: (task complete|done|完成)
    - state: running
      match: (running|step [0-9]+)
  readMode: tail
  fromEndBytes: 65536
  idleAfterSilenceMs: 60000      # 静默 60 秒转灰
  staleTimeoutMs: 120000# 120秒无信号转深灰
```

**关键语义**：
- 只读**新增**内容，历史内容不当信号（避免启动时误判）
- 新出现的文件先建立游标，下一轮才开始判定
- 日志轮转/截断能识别，不会崩
- 支持 `**` 递归通配、字面量文件路径、环境变量展开

#### 方式三：webhook 型（外部推送）

```yaml
monitor:
  type: webhook
  listen: 127.0.0.1# 只监听本地，绝不绑 0.0.0.0
  path: /hook/my-task
  secret: your-token# 必填，防止本机其他程序误调
  fieldMap:                # 从 JSON 里提取字段
    state: $.status
    message: $.message
    progress: $.progress
  heartbeatTimeoutMs: 120000
```

**用法**：
```bash
curl -X POST http://127.0.0.1:17890/hook/my-task \
  -H "Content-Type: application/json" \
  -H "x-indicator-token: your-token" \
  -d '{"status":"running","message":"开始"}'
```

**已验证的安全行为**：

| 场景 | 响应 |
|---|---|
| 无 token / 错 token | `401 invalid token` |
| 非法 status / 缺 status | `400 invalid status` |
| 未注册任务 | `404 unknown task` |
| 绑定地址 | `127.0.0.1`（仅 loopback） |

### 3.3 UI 要求

| 元素 | 要求 |
|---|---|
| **托盘图标** | 四态变色（灰/蓝/黄/红）、运行中数量徽标、右键菜单 |
| **桌面悬浮灯** | 52×52 免激活窗口、置顶、呼吸动画 |
| **任务面板** | 380×728、点行跳转、Esc 收起 |
| **通知** | 状态变化时弹气泡，可静音 |

---

## 四、状态机规格

### 4.1 转移表（当前真实值）

```
idle      → starting, running, failed
starting  → running, failed, unknown, idle
running   → waiting, success, failed, unknown, idle
waiting   → running, success, failed, unknown, idle
success   → idle, starting, failed
failed    → idle, starting, running, waiting
unknown   → starting, running, failed, idle
```

### 4.2 三条必须守住的不变量

这三条是「灯可信」的基础，**任何改动都不能破坏**：

| 不变量 | 原因 |
|---|---|
| `failed -> success` 禁止 | 失败的任务不允许自己显示成完成 |
| `unknown -> success` 禁止 | 失联任务不得凭空变绿 |
| 非法转移记日志但拒绝 | 拒绝时要有日志，便于排查 |

### 4.3 已做过的两处「反直觉」放宽

这两处看着违反直觉，实则是实测踩坑后的必要修正，**改动前请先读代码注释**：

**① `waiting -> success`**
-问题：一轮日志里同时有授权提示和完成信号时，`judgeStatusBatch` 按「最后一条命中」只返回 `success`，中间不会有 `running`
- 原后果：转移表拒绝 → 灯**永久停在黄色**，用户以为还在等授权
- 修正：允许这一跳

**② `failed -> running` / `failed -> waiting`**
- 问题：任务崩溃后重试（最常见场景），日志立刻又输出 `running`，但转移表禁止回去
- 原后果：灯卡在红色 10 分钟，直到 `dismiss_after` 清理
- 修正：允许。但这**不属于「洗绿」**——这些转移由真实的 `running` 信号驱动（`apply` 带 `isSignal`），不是自动回落

### 4.4 规则判定的跨行优先级

多行日志批量判定时（`judgeStatusBatch`）：

```
["fatal crash", "task done"]  →  failed   （failed 一票否决，立即定案）
["step 1 running", "task done"]  →  success  （非 failed 之间看最后一条）
```

**原因**：`["fatal crash", "task done"]` 若判成 `success`，就是**假绿灯**——
用户以为任务正常结束，实际早就崩了。这比误报红危险得多。

---

## 五、技术栈与架构

### 5.1 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 框架 | Electron 33 | 托盘 + 置顶窗 + 通知都是官方 API |
| 语言 | TypeScript（strict） | — |
| 打包 | `tsc` 直编，**不引入 Vite/webpack** | 主进程与 preload 是纯 Node，打包器没用 |
| UI | 原生 DOM + CSS，**零 UI 框架** | 界面只有两个小窗口，框架是负担 |
| 运行时依赖 | 仅 `electron` + `yaml` | — |

### 5.2 文件结构（33 文件 / 9464 行）

```
src/
  main/                主进程
    index.ts           入口：单实例锁、启动顺序、全局兜底
    config.ts          配置加载 + 校验 + 环境变量展开
    store.ts           状态机（唯一数据源）+ 转移表
    ipc.ts             7 个 R→M 通道
    tray.ts            托盘
    overlay.ts         悬浮灯
    panel.ts           任务面板
    focus.ts           终端跳转（5 级降级链）
    notify.ts          通知
    logger.ts          日志
    autolaunch.ts     开机自启
    snapshot.ts        状态快照
    monitors/
      base.ts监控器抽象基类（错误隔离契约）
      host.ts          监控器宿主（逐个 try-catch）
      process.ts       进程型
      process-enum.ts  进程枚举（CIM/tasklist 双模式）
      logfile.ts       日志型
      log-tail.ts      增量 tail + glob
      webhook.ts       Webhook 型
      hook-server.ts   共享 HTTP 服务（只 listen 一个端口）
      pattern.ts       规则编译 + 状态判定
  preload/preload.ts   contextBridge 暴露
  renderer/            渲染层（overlay.html/ts、panel.html/ts、shared.css、audio.ts）
  shared/              主进程与渲染层共用
    types.ts           类型定义 + 状态常量
    constants.ts       默认值常量
    ipc-contract.ts    IPC 契约（两端共享，防漂移）
```

### 5.3 架构铁律

1. **错误隔离**：单个监控器的异常**绝不能**扩散到主进程（`emit()` 内部全捕获 + Host 侧再包一层）
2. **崩溃不崩灯**：主进程 `uncaughtException` 只记日志不退出——灯一直在比崩了更安全
3. **唯一数据源**：状态只存在 `TaskStore`，UI 全部是它的投影
4. **不绑0.0.0.0**：所有监听仅loopback（架构 §4.4 安全措施 1）

---

## 六、已踩过的坑（重要，别重复踩）

### 6.1 启动失败：`ELECTRON_RUN_AS_NODE=1`

**现象**：
```
TypeError: Cannot read properties of undefined (reading 'requestSingleInstanceLock')
栈里有 run_main_module
```

**真因**：该环境变量让 `electron.exe` 退化成普通 Node 解释器。
部分 CI / 容器 / IDE 内置终端会预设它，导致「双击能开、命令行启动失败」。

**关键**：Electron 在**启动早期**就把该变量读进内部状态，
在 main 进程里 `delete process.env.ELECTRON_RUN_AS_NODE` **来不及**（实测无效）。
唯一可靠做法是**在 spawn 之前由父进程剔除** → `scripts/start.mjs`。

**排查建议**：怀疑启动失败时，先 `env | grep -i electron` 排除环境污染，
别急着归因到「环境不支持 GUI」。

### 6.2 启动失败：GPU 进程崩溃

**现象**：`FATAL: GPU process isn't usable. Goodbye.`（GPU 进程以 `0xC0000409` 连环崩溃）

**修法**：只调 `app.disableHardwareAcceleration()` **不够**，
必须在**命令行参数**层面加 `--disable-gpu --disable-software-rasterizer
--disable-gpu-compositing --in-process-gpu`。

本应用是纯2D UI，关GPU 完全无损。

### 6.3 改代码后测不出效果：单实例锁

**现象**：编译了新代码，实测行为却完全没变。

**真因**：旧进程还在跑，占着端口 + 单实例锁，新实例被**静默挡掉**（无任何提示）。

**教训**：改完 main 进程代码，必须确认用户重启的是新进程——
用 `netstat` 查监听 PID 并与启动时间比对，否则会误判修复无效。

### 6.4 静默失效类问题的排查方法

这类问题的共同特征：**不报错，只是没反应**。按顺序查三样：

```javascript
// 1. 路径匹配到文件了吗？0 个就是路径问题
globFiles(配的路径)

// 2. 规则编译成功吗？看 .errors
compileRules(配的规则).errors

// 3. 真实日志样例能判出目标状态吗？
judgeStatusBatch(["你的真实日志样例"], 编译后规则)
```

**别靠读代码猜**，要实际 require 跑一遍。

### 6.5 配置三个坑（都曾导致灯不亮）

| 坑 | 后果 | 现状 |
|---|---|---|
| 正则写 `(?i)(error\|...)` | **JS 不支持该语法**，规则被静默丢弃 | 已移除；`compileRules` 默认带 `i` 标志 |
| 路径写 `%USERPROFILE%/...` | Node 不展开，匹配 0 个文件 | 已实现 `expandEnvVars`，支持 `%VAR%`/`${VAR}`/`$VAR` |
| YAML 里 `match:` 换行 | 折叠标量吞掉空格，正则语法坏掉 | 已改单行。**规则不要跨行写** |

---

## 七、当前状态

### 7.1 已验证可用

| 项 | 结果 |
|---|---|
| 类型检查 | main / renderer / **test** 三份tsconfig 全部 0 诊断 |
| 单元测试 | **224 个用例全绿**（11 个测试文件） |
| 端到端冒烟 | 22 项断言通过（`npm run smoke`，~1.3秒） |
| GUI 启动 |托盘 / 悬浮灯 / 面板 / 热重载 / 免打扰全部实测工作 |
| 五色流转 | log 型实测：灰→蓝→红→蓝（重试）→黄→绿 |
| 安全防护 | 401 / 400 / 404 + 仅 loopback 绑定，全部实测 |

### 7.2 未验证

- **托盘/悬浮灯的视觉呈现**：沙箱无法真正起窗口，逻辑层已验证但像素效果未看过
- **终端跳转的L1（spawn 新终端）**：本机没装 Windows Terminal，只验证了降级链

### 7.3 环境限制（非代码问题）

| 限制 | 表现 | 影响 |
|---|---|---|
| 沙箱拦PowerShell 子进程 | `进程枚举子进程第 N 次重启` | **process 型不可用**，log/webhook 型正常 |
| 沙箱拦 `taskkill` | 停不掉旧进程 | 只能请用户手动关窗口 |
| 控制台默认 GBK | 中文日志乱码 | 启动前 `chcp 65001` |

---

## 八、下一步（按优先级）

### P0：对接用户的 dsh 任务 ⏳

**现状**：用户的 dsh 通过 `http://127.0.0.1:13080/`（dsh web）监控，实测所有路径需认证：
```
/→ 401 "dsh web authentication required"
/api/tasks     → 401 unauthorized
```
token 在 dsh web **启动时打印到终端**，不在配置文件里。

**需要的信息**（要问用户）：
1. dsh web 启动时打印的完整 URL（含 token）
2. dsh 的状态怎么表达（哪个接口、什么字段）

**技术方案**：新增「HTTP 轮询型」监控 —— 每 N 秒请求一次 dsh 状态接口，
用 `fieldMap` 提取字段判定状态。**与现有 webhook 型共用同一套 fieldMap 机制**，改动不大。

**备选方案（更快）**：如果用户跑任务时本来就有日志落到某个目录，
直接配成 `log` 型即可（已实测跑通）。这是最快见效的路径。

### P1：视觉验收

在有桌面的真机上确认：托盘四态变色、悬浮灯呼吸动画、面板点行跳转。

### P2：打包分发

`npm run dist` 已有 electron-builder 配置，需在真机验证 NSIS 安装包流程。

---

## 九、常用命令

```bash
cd D:/projects/ai-task-indicator

npm run smoke          # 端到端冒烟（~1.3秒，不开窗口，最快的自检）
npm run start:demo     # 用演示配置启动GUI
npm start              # 用默认配置启动
npm run start -- --config ./your-config.yaml
npm run build          # 只编译
npm test               # 单元测试
npm run typecheck      # 三份 tsconfig 类型检查
npm run dist           # 打包 Windows NSIS
```

**不要用 `npx electron .` 或 `npm run dev`** —— 它们绕过了 `scripts/start.mjs`，
会被 6.1 / 6.2 两个环境问题卡住。

查状态：`curl -s http://127.0.0.1:17890/api/tasks`
查日志：`%APPDATA%\ai-task-indicator\logs\ai-task-indicator-YYYY-MM-DD.log`
改配置：编辑 `%USERPROFILE%\.ai-task-indicator\config.yaml`，**保存即生效**（热重载）

---

## 十、参考文档

| 文档 | 内容 |
|---|---|
| `docs/01-PRD.md` | 完整 PRD（竞品分析、需求池 P0/P1/P2、UI 设计） |
| `docs/02-ARCHITECTURE.md` | 架构设计（时序图、类图、模块职责、ADR 决策记录） |
| `docs/03-POC-REPORT.md` | POC 实测报告（Win32 API 的5 个反直觉结论） |
| `README.md` | 安装运行、配置说明、**启动失败排查表** |
| `config.example.yaml` | 带注释的完整配置示例 |
