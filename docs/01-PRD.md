# AI 任务状态指示灯（AI Task Indicator）PRD

> **文档版本**：v1.0
> **撰写人**：许清楚（产品经理）
> **撰写日期**：2026-10-12
> **竞品数据来源**：`api.github.com` REST API（Search + Repos + Contents + Readme 端点），检索日期 **2026-10-12**
> **状态**：待架构评审

---

## 0. 选型结论（一句话）

> **从零实现，不做二次开发**——GitHub 上 22+ 个候选项目**无一同时满足「Windows + 托盘 + 悬浮置顶灯 + 多任务并行 + 三类监控方式」**，绝大多数是 macOS 菜单栏 / tmux 插件 / 单 Agent 单会话的窄场景工具；**托盘与置顶窗口能力直接用 Electron 官方 API（`Tray` / `BrowserWindow{alwaysOnTop}` / `Notification`）即可，无需 fork 整个项目**，仅把 `accessd/tmux-agent-indicator`（MIT）的状态机与 hook 事件映射、`ru-gong/agent-beacon`（MIT）的状态 JSON 文件协议、`carlbuu/ai-status-light-esp32`（MIT）的状态优先级规则作为**设计参考**借鉴。

**技术栈建议**：`Electron + Vite + React + TypeScript + Tailwind CSS`，打包 `electron-builder`（NSIS）。

| 维度 | Electron 方案 | Tauri 2 方案 |
| --- | --- | --- |
| 托盘 API 成熟度 | ✅ `Tray` + `nativeImage`，动态换图标/改色零依赖 | ⚠️ 需 `tray-icon` crate + Rust 侧重绘图标 |
| 置顶透明窗 | ✅ `transparent + frame:false + alwaysOnTop` 开箱 | ✅ 同样支持 |
| 前端复用团队默认栈 | ✅ React + TS + Tailwind | ⚠️ 团队默认栈是 React，Tauri 侧要写 Rust |
| 构建工具链 | ✅ 只需 Node | ❌ 需 Rust 工具链 + MSVC |
| 资源占用 | ⚠️ 80~150MB RAM | ✅ 3.6MB / <30MB（ClaudeBar 实测） |
| 参考实现 | `agent-pulse`（Electron）、`dsh-desktop`（Electron） | `ClaudeBar`、`pane`、`Flow`（Tauri） |

**决策**：选 Electron。理由是本项目**瓶颈在"多源状态聚合 + 跳转定位"而非渲染性能**，托盘常驻 100MB RAM 可接受；且团队前端栈可 100% 复用，交付风险最低。Tauri 作为 P2 备选（若用户后续提出低占用硬需求再迁移）。

---

## 1. 产品目标

| # | 目标 | 可度量指标 |
| --- | --- | --- |
| G1 | 用户**不用切换窗口**就能判断每个 AI 任务的状态 | 状态识别准确率 ≥ 95%（对照人工判定，10 组真实任务）；从任务结束到弹窗通知延迟 ≤ 3s |
| G2 | 多任务并行状态**一眼可辨** | 托盘图标 + 悬浮灯徽标能在 1 次注视内回答「谁在跑 / 谁跑完了 / 谁挂了 / 几个」；任务列表滚动帧率 ≥ 30fps（20 任务） |
| G3 | 从通知到定位现场的**点击链路 ≤ 2 次** | 点击通知 → 目标终端窗口/目录/日志被激活 ≤ 2 次点击，成功率 ≥ 90% |

---

## 2. 目标用户与场景

### 2.1 目标用户

| 角色 | 特征 | 核心痛点 |
| --- | --- | --- |
| **AI CLI 重度并行用户**（主） | 同时跑 3~10 个 `workbuddy` / `deepseek harness` / `dsh` / `codex` / `claude code` 任务，分别在多个终端窗口、多个项目目录 | 任务跑完/挂掉时**无感知**，只能挨个 `Alt+Tab` 轮询；经常「等一个半小时才发现某个任务早就崩了」 |
| **带 AI 工具链的团队负责人** | 需要同时盯 CI/agent 集群，本地跑多个 harness | 无法汇总本地+远端状态，缺乏统一看板 |
| **自建 harness 的开发者** | 自己封装了 CLI，需要一个轻量状态指示层 | 现有工具要么 macOS 专属（`claude-status-bar` ★707），要么绑死单一 Agent（`agent-pulse` 只支持 opencode） |

### 2.2 核心场景

**场景 A（主场景，10:00 早上开工）**
用户同时启动 4 个任务：workbuddy server（A 项目）、deepseek harness（B 项目）、dsh（C 项目）、一个 codex（D 项目）。上午开会期间，用户希望：
- 会议中不看屏幕也能知道「有没有任务挂了」（失败要有声音）；
- 会议结束后扫一眼悬浮灯，知道「3 个还在跑、1 个已完成」。

**场景 B（完成即返回）**
任务完成后第一时间弹 Windows 通知 + 播放提示音。用户点通知 → 直接跳到那个任务的终端窗口，看到最后输出，判断要不要继续。

**场景 C（挂了要马上知道）**
某个 harness 进程退出但没跑完（failed）。托盘灯变红 + 列表里该行标红 + 提示音。点击 → 跳到日志文件末尾定位错误。

---

## 3. 用户故事

| # | 角色 | 故事 | 验收（Given/When/Then）|
| --- | --- | --- | --- |
| US1 | 并行任务用户 | 作为同时跑多个 AI 任务的用户，我需要**一盏常驻桌面的状态灯**，以便不切换窗口就知道整体状态 | Given 应用已启动，When 任意任务状态变化，Then 悬浮灯在 500ms 内变为对应颜色且始终置顶不被其他窗口遮挡 |
| US2 | 并行任务用户 | 作为并行任务用户，我需要**区分每个任务的状态**，以便知道谁在跑、谁跑完了、谁挂了 | Given 配置了 4 个任务，When 它们分别处于 idle/running/success/failed，Then 托盘灯显示聚合态（失败>等待>运行>成功>空闲），列表 4 行分别显示各自状态色 |
| US3 | 并行任务用户 | 作为并行任务用户，我需要**知道有几个任务在跑**，以便估算剩余工作量 | Given 3 个任务 running，When 悬浮灯显示，Then 徽标显示数字 `3`；When 点击展开列表，Then 每行有独立状态点与任务名 |
| US4 | 并行任务用户 | 作为并行任务用户，我需要**任务结束时立刻知道**，以便及时处理 | Given 通知与声音均开启，When 任务从 running → success，Then ≤3s 内弹出 Windows 通知并播放提示音 |
| US5 | 并行任务用户 | 作为并行任务用户，我需要**关掉声音和弹窗**（开会/夜间），以便不被打扰 | Given 在托盘菜单关闭「通知」与「声音」，When 任务完成，Then 不弹窗不播声，但**托盘灯与列表状态仍正常更新** |
| US6 | 并行任务用户 | 作为并行任务用户，我需要**点击通知直接跳到那个任务现场**，以便立刻处理 | Given 任务完成并弹出通知，When 点击通知主按钮，Then 目标终端窗口被置前（或项目目录/日志文件被打开） |
| US7 | 多工具用户 | 作为用不同 AI 工具的用户，我需要**按进程/日志/webhook 三种方式接入**，以便工具没有统一接口时也能监控 | Given 一个任务用日志轮询、另一个用进程监听、第三个用 webhook，When 三者状态变化，Then 三者都能在列表中正确显示与排序 |
| US8 | 健壮性敏感用户 | 作为长期挂机的用户，我需要**应用自身崩溃/断连能被发现**，避免灯一直骗我 | Given 监控源失联（进程消失且无兜底信号），Then 任务在 `stale_timeout`（默认 60s）后转 `unknown` 灰态而非保持 running |

---

## 4. 功能需求池

### P0 — Must have（首个可用版本必须有）

| ID | 需求 | 优先级 | 关键约束 |
| --- | --- | --- | --- |
| P0-1 | **系统托盘图标**：常驻 Windows 托盘，聚合态着色 | P0 | 单实例；左键点击展开任务面板；右键菜单含「打开面板 / 暂停监控 / 退出」 |
| P0-2 | **悬浮置顶指示灯**：无边框、可拖动、可半透明、置顶 | P0 | `alwaysOnTop: true` + `frame: false` + `transparent: true`；位置记忆；不抢占焦点（`focusable: false`） |
| P0-3 | **四态颜色体系**：idle / running / success / failed（+ waiting 辅助态） | P0 | 见 §5 状态机；颜色需在浅色/深色桌面背景上均可辨（对比度 ≥ 3:1） |
| P0-4 | **多任务列表面板**：列出任务名、状态、开始时间、耗时、项目目录 | P0 | 聚合态排序（异常优先置顶）；支持手动把某任务标记为已读 |
| P0-5 | **任务数量徽标**：悬浮灯与托盘显示 running 任务数 | P0 | running=0 时不显示徽标 |
| P0-6 | **完成/失败弹窗通知** + **提示音**，**均可独立开关** | P0 | 通知走 Electron `Notification`；提示音用 `app://` 内置短音频或系统默认通知音（避免依赖外部文件）；支持「仅失败时通知」模式 |
| P0-7 | **配置驱动**：所有监控项、开关来自 YAML 配置文件 | P0 | 配置文件路径 `~/.ai-task-indicator/config.yaml`；非法项不崩溃，记日志并降级 |
| P0-8 | **进程/命令行监听**：`process` 型监控源 | P0 | 匹配进程名 + 命令行子串；支持「进程存在=running」与「进程消失=success」（退出码可判则用退出码） |
| P0-9 | **日志/目录轮询**：`log` 型监控源 | P0 | 支持 glob 目录 + 文件尾部新增行读取；用正则/关键字规则映射到状态；默认轮询 3s |
| P0-10 | **点击跳转**：通知/列表项可跳到终端窗口、项目目录、日志文件 | P0 | 终端：用 `wt.exe -w <窗口名>` 或 PowerShell `WScript.Shell.AppActivate(<窗口标题>)`；目录：`explorer.exe`；文件：`start "" <path>` |

### P1 — Should have

| ID | 需求 | 优先级 | 说明 |
| --- | --- | --- | --- |
| P1-1 | **Webhook 接收端**：本地 HTTP 服务接收外部推送状态（`POST /hook`） | P1 | 内置 Node `http` 服务，默认端口 `17890`，仅监听 `127.0.0.1`，payload 见 §6 |
| P1-2 | **配置文件热重载**：监听 config 文件变化，5s 内生效 | P1 | 语法错误则保留旧配置并在托盘气泡提示 |
| P1-3 | **waiting（等待授权/输入）态** | P1 | AI CLI 常在等用户确认 permission，若不区分会导致「看似卡死」。黄灯 + 快闪 + 单独提示音 |
| P1-4 | **状态过滤规则**：支持「静默 N 秒无输出 = idle」等启发式 | P1 | 避免长尾任务被误判 running |
| P1-5 | **通知去抖与免打扰**：同任务 N 秒内多条完成事件只弹一次；支持「全屏游戏时不弹」 | P1 | 去抖窗口默认 30s |
| P1-6 | **任务分组/标签**：按项目目录分组显示 | P1 | 面板折叠分组 |
| P1-7 | **开机自启 + 崩溃自动拉起** | P1 | 托盘菜单开关；写入 `HKCU\...\Run` |
| P1-8 | **本地 HTTP 只读接口**：`GET /api/tasks` 输出 JSON 状态 | P1 | 借鉴 `ItsJazii/pane`（★74）的 `127.0.0.1:6736/v1/usage` 做法，便于接 Rainmeter / 脚本 |

### P2 — Nice to have

| ID | 需求 | 优先级 | 说明 |
| --- | --- | --- | --- |
| P2-1 | **历史统计**：今日完成数、失败数、平均耗时，按项目聚合 | P2 | 本地 SQLite / JSONL |
| P2-2 | **Webhook 推送出去**：本应用状态变更时反向回调用户指定 URL | P2 | 形成双向联动 |
| P2-3 | **悬浮灯形态切换**：圆点 / 三色交通灯 / 文字徽标 | P2 | 参考 `Z060049/AI-status-light`（★19）的交通灯形态 |
| P2-4 | **托盘图标自定义**：用户指定多尺寸 PNG/ICO 与各状态色 | P2 | 参考 `ClaudeBar` 在托盘图标里绘制数值 |
| P2-5 | **多显示器与 DPI 缩放适配** | P2 | 记住每显示器位置 |
| P2-6 | **Tauri 版本**（低占用） | P2 | 若资源占用成为用户抱怨点则启动迁移 |

---

## 5. 状态机定义

### 5.1 状态枚举与视觉规范

| 状态 | 语义 | 托盘/悬浮灯颜色 | 动画 | 提示音 | 默认通知 |
| --- | --- | --- | --- | --- | --- |
| `idle` | 已配置但无任务在跑 | 灰 `#6B7280` | 常亮 | — | 否 |
| `starting` | 进程已发现但尚未收到首个有效信号 | 淡蓝 `#93C5FD` | 慢呼吸 | — | 否 |
| `running` | 正在执行 | 蓝 `#3B82F6` | 呼吸脉冲（2s 周期） | — | 否 |
| `waiting` | 等待授权/确认/输入 | 黄 `#F59E0B` | 快闪（0.6s 周期） | 短促「叮」 | 是 |
| `success` | 正常完成且已查看 | 绿 `#22C55E` | 绿闪 1 次后常亮 | 上扬双音 | 是 |
| `failed` | 异常退出 / 命中错误规则 | 红 `#EF4444` | 常亮 + 双闪告警 | 低沉双音 | 是 |
| `unknown` | 监控源失联、心跳超时 | 深灰 `#4B5563` | 常亮 | — | 否 |

> 命名对齐 `ru-gong/agent-beacon`（★2, MIT）的 `busy/idle/needs_interaction/error/disconnected`，便于日后对接 hook 写入的状态文件。

### 5.2 状态优先级（聚合托盘灯用）

**借鉴 `carlbuu/ai-status-light-esp32`（★2, MIT）的优先级规则**，并补 idle：

```
failed > waiting > running > success > starting > idle
```

即：任一任务失败 → 托盘整体红；无失败但有人等授权 → 黄；全部空闲 → 灰。

### 5.3 状态转移图

```
                    ┌──────────────────────────────────────┐
                    │                                      │
              ┌─────▼─────┐                            ┌────┴─────┐
   (配置加载)─►│  idle    │◄──── idle_timeout / 完成已读  │          │
              └─────┬─────┘                            │          │
                    │ 首个子信号                        │          │
              ┌─────▼─────┐   无信号超时(stale_timeout) │          │
              │ starting  ├───────────────────────────►│ unknown  │
              └─────┬─────┘                            └────┬─────┘
                    │ 收到日志/心跳/进程存活                │ 恢复信号
              ┌─────▼─────┐                            ┌────┴─────┐
       ┌─────►│  running  │◄──────────────────────────┤          │
       │      └─────┬─────┘                            │          │
       │            │ 命中授权/输入提示                │          │
       │      ┌─────▼─────┐                            │          │
       │      │  waiting  ├────────────────────────────┘          │
       │      └─────┬─────┘                                    │
       │            │ 授权完成 / 继续输出                       │
       │      ┌─────▼─────┐                                    │
       ├──────┤  running  │                                    │
       │      └─────┬─────┘                                    │
       │            │ 命中完成规则 / 进程正常退出                 │
       │      ┌─────▼─────┐                                    │
       ├──────┤  success  ├────────────────────────────────────┘
       │      └─────┬─────┘
       │            │ 用户标记已读 / 停留超过 dismiss_after
       └──────► idle
       │
       │ 任意态命中错误规则 / 进程异常退出码
  ┌────▼─────┐
  │  failed  │◄─────────────────────────── 任意状态
  └──────────┘
```

### 5.4 关键转移规则

| 当前 | 事件 | 目标 | 备注 |
| --- | --- | --- | --- |
| idle | 检测到进程存在 / 日志新增有效行 / webhook 到达 | starting→running | starting 持续 `start_timeout`（默认 10s）无新信号自动转 idle |
| running | 匹配错误正则（如 `(?i)\b(error|panic|traceback|fatal)\b`） | failed | 失败不自动回落，需用户确认 |
| running | 匹配完成正则（如 `(?i)(done|success|completed|exit code 0)`） | success | |
| running | 匹配授权提示正则（如 `(?i)(approve|permission|y/n\[)\b`） | waiting | waiting 超 `waiting_timeout`（默认 30min）无响应转 failed（防悬挂） |
| waiting | 日志新增非授权行 / webhook 恢复 | running | |
| 任意 | 所有信号源停止更新且超过 `stale_timeout`（默认 60s） | unknown | 关键：防止灯一直是绿的 |
| failed | 用户点「重试」/ 新一轮同名任务启动 | starting | |
| success/failed | 用户标记已读 或 `dismiss_after`（默认 10min） | idle | 已完成任务自动清理，避免列表堆积 |

---

## 6. 配置文件 Schema（YAML）

**路径**：`%USERPROFILE%\.ai-task-indicator\config.yaml`（Windows）
**理由选 YAML**：需大量注释（每条监控规则的自定义说明），JSON 不支持注释，团队协作可读性差。

```yaml
version: 1

# ---------- 应用级设置 ----------
app:
  startMinimized: true              # 启动时最小化到托盘
  autoLaunch: false                 # 开机自启
  pollIntervalMs: 3000              # 全局轮询间隔（log/unknown 兜底）
  locale: zh-CN

# ---------- 悬浮指示灯 ----------
lamp:
  enabled: true
  x: 1870                          # 位置记忆（首次运行用 x= -1 表示未设置）
  y: 60
  size: 28                          # 直径 px
  opacity: 0.92
  alwaysOnTop: true
  showBadge: true                   # running 任务数徽标
  clickThrough: false               # true 时鼠标穿透，仅托盘可交互
  resetOnSuccess: true              # 成功后灯回到 idle 灰

# ---------- 通知 ----------
notify:
  popup: true                       # 完成/失败弹窗（Windows Notification）
  sound: true                       # 提示音
  soundOnlyOnFailure: false         # 仅失败时响
  debounceMs: 30000                 # 同任务去抖窗口
  notifyStates: [waiting, success, failed]
  doNotDisturbOnFullscreen: true    # 全屏应用时不弹
  actions:                          # 通知按钮
    - { id: focus_terminal, label: "打开终端" }
    - { id: open_log,       label: "打开日志" }
    - { id: open_dir,       label: "打开目录" }

# ---------- 任务列表 ----------
tasks:
  # ========== 示例 1：进程/命令行监听（workbuddy server）==========
  - id: workbuddy-server
    name: workbuddy server (A项目)
    enabled: true
    monitor:
      type: process
      # 任一匹配即认为任务存活
      match:
        - processNames: ["node.exe", "workbuddy.exe"]
          cmdlineContains: ["workbuddy", "server"]
      # 进程消失后的结果判定
      onExit:
        successExitCodes: [0]
        graceMs: 3000                 # 进程消失后等 3s 再定状态
      # 无进程但日志有新行时也视为 running（进程名被 node 混淆时的兜底）
      fallbackLog:
        paths: ["D:/projects/logs/workbuddy/**/*.log"]
        stateOnNewLine: running
    jump:
      terminal:
        type: windowTitle            # 用窗口标题定位已有终端
        match: "workbuddy"
      cwd: "D:/projects/ai-task-indicator"
      logFile: "D:/projects/logs/workbuddy/server.log"

  # ========== 示例 2：日志轮询 + 规则映射（deepseek harness）==========
  - id: dsh-b
    name: deepseek harness (B项目)
    enabled: true
    monitor:
      type: log
      paths:
        - "D:/projects/logs/dsh/**/*.log"
      # 增量读取，避免全量重扫
      readMode: tail
      fromEndBytes: 65536            # 首次只读末尾 64KB
      debounceMs: 1000
      rules:
        - { state: running,  match: "(?i)(thinking|streaming|step \\d+|executing)" }
        - { state: waiting,  match: "(?i)(approve|permission|\\[y/n\\]|choose an option)" }
        - { state: success,  match: "(?i)(task complete|finished|exit code 0|✓ done)" }
        - { state: failed,   match: "(?i)(\\berror\\b|panic|traceback|exit code [1-9])" }
      idleAfterSilenceMs: 60000      # 静默 60s 无新行 → 转 idle（防长尾误判）
      staleTimeoutMs: 180000
    jump:
      terminal: { type: spawn, cmd: "wt.exe", args: ["-w", "dsh", "new-tab", "-d", "D:/projects/B"] }
      cwd: "D:/projects/B"
      logFile: "D:/projects/logs/dsh/latest.log"

  # ========== 示例 3：Webhook 回调（dsh）==========
  - id: dsh-c
    name: dsh (C项目)
    enabled: true
    monitor:
      type: webhook
      listen: "127.0.0.1"            # 仅本机，不对外暴露
      path: "/hook/dsh-c"
      secret: "your-secret-token"     # 请求头 x-indicator-token 必须匹配
      fieldMap:                      # 从 JSON payload 映射状态
        state:  "$.status"           # idle|running|waiting|success|failed
        message: "$.message"
        progress: "$.progress"
      heartbeatTimeoutMs: 120000     # 无心跳则转 unknown
    jump:
      cwd: "D:/projects/C"
      logFile: "D:/projects/logs/dsh/c.log"

# ---------- 全局规则默认值（可被单任务覆盖）----------
defaults:
  stateTimeout:
    startTimeoutMs: 10000
    staleTimeoutMs: 60000
    waitingTimeoutMs: 1800000
    dismissAfterMs: 600000
  colors:
    idle: "#6B7280"
    starting: "#93C5FD"
    running: "#3B82F6"
    waiting: "#F59E0B"
    success: "#22C55E"
    failed: "#EF4444"
    unknown: "#4B5563"
```

**Webhook 回调 payload 示例**（外部工具 POST 到 `http://127.0.0.1:17890/hook/dsh-c`）：

```bash
curl -X POST http://127.0.0.1:17890/hook/dsh-c \
  -H "Content-Type: application/json" \
  -H "x-indicator-token: your-secret-token" \
  -d '{"status":"success","message":"3 files changed","progress":1}'
```

---

## 7. UI/UX 规格

### 7.1 托盘图标（四态表现）

```
    idle 灰         running 蓝        waiting 黄      success 绿       failed 红
   ┌────────┐     ┌────────┐      ┌────────┐     ┌────────┐     ┌────────┐
   │  ●     │     │  ◐     │      │  ◆     │     │  ●     │     │  ▲     │
   │(dim)   │     │(pulse) │      │(flash) │     │(flash1)│     │(blink) │
   └────────┘     └────────┘      └────────┘     └────────┘     └────────┘
   灰 #6B7280     蓝 #3B82F6      黄 #F59E0B      绿 #22C55E     红 #EF4444
```

- 渲染方式：`nativeImage` 预生成 7 套 PNG（16/24/32 px），运行时替换 `tray.setImage()`，避免每帧重绘开销。
- running 时在托盘图标**右上角叠加数字徽标**（running 任务数，1~99+）。
- tooltip 文本：`AI 任务指示灯 — 运行 3 · 完成 1 · 失败 0`。

### 7.2 悬浮指示灯

**形态 A（默认，圆点灯）** **形态 B（交通灯，P2）** **形态 C（徽标数字）**

```
        ●                  ●  ●  ●              ┌────────┐
     ⌀ 28px              ┌─┐┌─┐┌─┐            │ ③ running│
   opacity .92           │ ││ ││ │            └────────┘
  alwaysOnTop            └─┘└─┘└─┘              3 个任务运行中
  draggable              红黄绿竖排
```

**交互定义**：

| 操作 | 行为 |
| --- | --- |
| 左键单击 | 展开/收起任务列表面板（面板以灯为锚点定位） |
| 左键拖拽 | 移动灯（松手后写回 config `lamp.x/y`） |
| 右键单击 | 菜单：打开面板 / 暂停监控（30min）/ 声音开关 / 通知开关 / 打开配置文件 / 退出 |
| 滚轮 | 无（避免误触） |
| 悬浮（hover） | 显示 tooltip：聚合态摘要 |

### 7.3 任务列表面板

```
┌─ AI 任务指示灯 ────────────────────── ⚙  ⏸  ✕ ─┐
│  ⬤ running 3   ⬤ success 1   ⬤ failed 1         │
├─────────────────────────────────────────────────┤
│ ✕ FAILED   dsh-b                 失败 · 12:04   │
│            deepseek harness (B项目)              │
│            D:/projects/B                          │
│            [打开终端] [日志] [目录] [重试] [已读] │
├─────────────────────────────────────────────────┤
│ ▶ RUNNING  workbuddy-server       32:11 · 09:32 │
│            workbuddy server (A项目)              │
│            [打开终端] [日志] [目录] [暂停]        │
├─────────────────────────────────────────────────┤
│ ⏸ WAITING  dsh-c                  等待授权 05:12│
│            dsh (C项目) · "Allow write to ...?"   │
│            [打开终端] [日志] [批准提示]           │
├─────────────────────────────────────────────────┤
│ ✓ SUCCESS  codex-d                完成 · 10:48   │
│            codex (D项目) · "3 files changed"     │
│            [打开终端] [日志] [目录] [已读]        │
└─────────────────────────────────────────────────┘
```

**排序规则**：`failed` → `waiting` → `running` → `starting` → `success` → `unknown` → `idle`

**表格化交互规格**：

| 元素 | 规格 |
| --- | --- |
| 面板尺寸 | 宽度 380px，最大高度 = 视口 70%，超出内部滚动 |
| 面板材质 | 跟随系统深/浅色（`nativeTheme.shouldUseDarkColors`），`backgroundColor: '#1F2430' / '#F7F8FA'`，圆角 10px，阴影 |
| 状态行高 | 64px（两行：标题 + 元信息） |
| 状态标记 | 左侧 8px 色条 + 状态图标（✕/▶/⏸/✓/⬤） |
| 空态 | 「暂无任务」+ 「+ 添加任务」引导到 config 文件 |
| 操作按钮 | hover 时显示；4 个小按钮，每个 ≥ 28×28px（可点击区域 ≥ 32px） |

### 7.4 通知弹窗

```
╭──────────────────────────────────────────────╮
│ ✓  dsh-c 已完成                                │
│    dsh (C项目) · 耗时 12:31 · 3 files changed  │
│    ─────────────────────────────────────────  │
│    [ 打开终端 ]  [ 打开日志 ]  [ 打开目录 ]     │
╰──────────────────────────────────────────────╯
        ↑ 右下角 toast，glimmer 背景，5s 后自动淡出
```

| 属性 | 规格 |
| --- | --- |
| 位置 | 屏幕右下角，向上堆叠（多任务完成不互相遮挡） |
| 停留 | 5s（可点击时不自动消失） |
| 同一任务去抖 | 30s 内重复完成只弹一次，徽标计数 `×3` |
| 免打扰 | 全屏应用时不弹，仅托盘图标变红 + 声音关闭 |
| 点击空白 | 关闭并标记已读 |
| 动作按钮 | 最多 3 个，顺序：打开终端 / 打开日志 / 打开目录 |

### 7.5 点击跳转行为

| 跳转目标 | 实现方式 | 备注 |
| --- | --- | --- |
| **终端窗口（已开）** | 优先 `wt.exe -w <窗口名> new-tab -d <cwd>` 复用 Windows Terminal 窗口；否则 PowerShell `(New-Object -ComObject WScript.Shell).AppActivate('<标题>')` | 用户终端可能用 Windows Terminal / PowerShell 独立窗口 / ConEmu，按 `terminal.type` 可配 |
| **新建终端** | `spawn('wt.exe', ['-d', cwd, ...cmd])` | `terminal.type: spawn` |
| **项目目录** | `spawn('explorer.exe', [cwd])` | 复用已打开的资源管理器窗口 |
| **日志文件** | `spawn('cmd', ['/c', 'start', '', file])` | 跳到文件并用系统默认编辑器打开 |
| **日志末尾** | 若配置 `tailOnOpen: true`，先读取末尾 200 行写入剪贴板旁侧展示（P1） | 便于快速看错误 |

---

## 8. 竞品选型结论表（GitHub 候选清单）

**数据来源**：`api.github.com`，检索日期 **2026-10-12**。star / 语言 / 最近提交时间均为实时接口返回值。

### 8.1 第一梯队：功能最接近（但仍不适合作基座）

| # | 仓库 | Star | 技术栈 | 最近提交 | 核心能力 | 可复用度 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [accessd/tmux-agent-indicator](https://github.com/accessd/tmux-agent-indicator) | **98** | Shell + Python（MIT） | 2026-09-30 | **最贴近状态机需求**：三态 `running/needs-input/done`；hook 驱动（Claude Code/Codex 的 `UserPromptSubmit`/`PermissionRequest`/`Stop`）；四通道可视化（pane 边框/背景/窗口标题/状态栏图标）；进程检测兜底；`agent-state.sh --agent X --state Y` 通用 CLI 供任意 agent 调用；通知可挂外部命令 | **中**：★ 最高、MIT、状态机设计可直接借鉴；但它是 **tmux 插件，必须跑在 tmux 3.1+ 上，Windows 原生无 tmux**，托盘/悬浮窗/弹窗全无 → **不可作基座** |
| 2 | [ru-gong/agent-beacon](https://github.com/ru-gong/agent-beacon) | 2 | Python + PySide（MIT） | 2026-05-31 | **中文项目，跨平台托盘状态灯**（Windows/macOS/Linux）；进程扫描发现 Agent+Session；写本地 Hook 让 Agent 写状态文件；定义了状态 JSON 协议 `busy/idle/needs_interaction/error/disconnected`，存于 `%APPDATA%\Agent Beacon\`；状态灯：绿闪=运行/绿常=空闲/黄=待确认/红=错误/灰=断开 | **中**：状态文件协议设计值得直接借鉴；但**同一时间只接入一个目标 Session**（多任务并行是其明确短板），无悬浮灯、无提示音、★2 无生态 |
| 3 | [carlbuu/ai-status-light-esp32](https://github.com/carlbuu/ai-status-light-esp32) | 2 | C# WinForms + Arduino（MIT） | 2026-09-09 | **状态优先级与多任务表达最佳范本**：`等待允许 > 工作中 > 报错 > 完成未查看 > 已查看/空闲`；黄灯按任务数**常亮/双闪/三闪**表达 1/2/3+ 个并行任务；Codex/Cursor hook 事件映射表（`UserPromptSubmit`→工作中、`PermissionRequest`→等待允许、`PostToolUse`→工作中、`Stop`→已完成）；互斥体+UDP `127.0.0.1:38451` 单实例 IPC；写 Hook 前备份且保留用户已有 Hook；配置 `%LOCALAPPDATA%\CodexStatusLight\settings.json`；CLI `hook <STATE>` | **高（仅设计层）**：架构与状态优先级可直接照搬（含 hook 合并/备份策略）；但输出端是 **ESP32 串口 LED**，需额外硬件，UI 层为零 → **不可作基座** |
| 4 | [BJlaoma/agent-pulse](https://github.com/BJlaoma/agent-pulse) | 2 | TypeScript / Electron（**无 LICENSE**） | 2026-06-17 | **形态最接近的 Electron 参考实现**：Windows 托盘图标 绿/黄/红/灰 四色；自绘桌面弹窗（模型名 + token 用量 + 用户问题），slide-up 动画，点击聚焦 opencode；托盘菜单（暂停/关闭/聚焦/设置/卸载）；GUI 设置面板 | **中（仅参考）**：UI/交互形态可直接对照抄；但**强绑 opencode 插件机制**（需在 `opencode.json` 注册 `plugin`），无进程/日志/webhook 通用监控、**无 LICENSE（法律上不可 fork）** |
| 5 | [SwordSifu/dsh-desktop](https://github.com/SwordSifu/dsh-desktop) | 0 | JavaScript / Electron（无 LICENSE） | 2026-08-14 | **对用户 dsh 场景直接对口**：DeepSeek Harness 的 Electron 桌面壳；spawn `dsh web --port 0` + 健康检查 + 指数退避崩溃重启；托盘常驻/开机自启；**通过下行 WebSocket（`/api/events.mux` + `/api/events.host`）监听 `approval/requested` 与 `turn/end`** 并弹 Windows 通知（30s 去抖）；NSIS 打包 + 内置 Node 运行时 | **中**：证明了「dsh 事件流 → 系统通知」链路可行，可作 webhook 型监控的对接依据；但它是**单个 dsh 的 GUI 壳**，不是通用多任务监控器 |

### 8.2 第二梯队：托盘/悬浮窗能力参考（能力单一，非监控器）

| # | 仓库 | Star | 技术栈 | 最近提交 | 核心能力 | 可复用度 |
| --- | --- | --- | --- | --- | --- | --- |
| 6 | [daybigo/ClaudeBar](https://github.com/daybigo/ClaudeBar) | 40 | Rust + Tauri 2（MIT） | 2026-10-02 | Windows 托盘菜单栏应用；**`tray_icon.rs` 在托盘图标里绘制百分比（绿→琥珀→红）**；紧凑常驻小挂件 + glassmorphism；Windows 通知；用系统 WebView2（不打包 Chromium），RAM < 30MB，二进制 3.6MB | **中**：托盘图标**动态绘制数值**这一招值得借鉴（P2-4）；但只监控 Claude **用量额度**，不监控任务状态 |
| 7 | [ItsJazii/pane](https://github.com/ItsJazii/pane) | 74 | Rust + Tauri 2 + TS（MIT） | 2026-10-09 | Windows 托盘聚合 **25+ AI 供应商**（Claude/Codex/Cursor/OpenCode/Copilot/Grok/Devin/Kimi/DeepSeek…），多账号；Widget 模式可折叠成 40px 状态栏轮播；**本地只读 HTTP API `GET 127.0.0.1:6736/v1/usage`**（loopback-only + Host 检查 + 不发 CORS 头） | **中**：**本地 HTTP 状态接口的安全做法**值得照抄（P1-8）；但监控的是**额度/费用**，非任务运行状态 |
| 8 | [gamith24/sidelong-claude-code-status-bar](https://github.com/gamith24/sidelong-claude-code-status-bar) | 2 | TypeScript | 2026-08-11 | 常驻置顶状态条，显示「Claude Code 正在做什么」以及**「何时在静默等待授权提示」**；**基于 hook 系统而非屏幕抓取**（README 明确强调） | **中**：「hook 优先于轮询/抓屏」的判断正确，印证本项目 P0-8/P0-9 路线正确；仅 macOS/单 Agent |
| 9 | [revazi/tasklight](https://github.com/revazi/tasklight) | 4 | Go | 2026-08-31 | 终端任务运行器，含**通知 + idle 检测 + 输出匹配告警 + 点击回到 tmux 会话** | **低-中**：「idle 超时」与「输出匹配告警」两个思路可参考；Go + tmux 路线不同 |
| 10 | [karanikn/PingTray](https://github.com/karanikn/PingTray) | 2 | PowerShell | 2026-04-02 | 单文件 PowerShell 托盘工具；**彩色托盘图标 + 气泡通知 + Telegram/SMTP 外发**；多主机告警 | **低**：形态参考（单文件、零依赖）；监控对象是主机存活，非 AI 任务 |
| 11 | [Fabian2000/pc_watcher](https://github.com/Fabian2000/pc_watcher) | 0 | Rust | 2025-12-14 | Windows 窗口焦点事件监控 GUI，含**托盘图标 + 进程层级（process hierarchy）** | **低-中**：Windows 进程/窗口枚举的具体实现可参考（利于「跳到终端窗口」） |
| 12 | [projectvelox/claude-usage-widget](https://github.com/projectvelox/claude-usage-widget) | 40 | JavaScript | 2026-09-30 | Windows 优先的**常驻置顶浮动 widget**（便携 EXE） | **低**：悬浮窗形态参考；监控额度非状态 |
| 13 | [Z060049/AI-status-light-Claude-Code-Cursor-Codex](https://github.com/Z060049/AI-status-light-Claude-Code-Cursor-Codex) | 19 | Python | 2026-06-24 | Claude Code / Cursor / Codex 的**物理红黄绿交通灯** | **低**：交通灯三色形态可作 P2-3 备选；需硬件 |
| 14 | [LumoRez07/Flow](https://github.com/LumoRez07/Flow) | 156 | JavaScript + Tauri | 2026-08-26 | Windows 提词器：极简**常驻置顶 UI + 托盘控制**（Tauri 2） | **低**：Tauri 置顶 + 托盘组合参考 |
| 15 | [sablezoob/claude-limits-widget](https://github.com/sablezoob/claude-limits-widget) | 1 | PowerShell | 2026-08-22 | Windows 置顶 widget + 托盘图标，5 语言，免管理员权限 | **低**：低权限/免管理员思路可参考 |
| 16 | [ViniciusCastroo/waybar-claude-status](https://github.com/ViniciusCastroo/waybar-claude-status) | 3 | Shell | 2026-09-17 | Waybar 指示器：busy/idle/completion + **任务完成时绿色脉冲** | **低**：Linux only；但「完成绿脉冲」反馈形式值得借鉴 |
| 17 | [PickedAshi/DSH_taskbar_status_display_2.0](https://github.com/PickedAshi/DSH_taskbar_status_display_2.0) | 2 | — | 2026-10-10 | DSH 工作状态反映到任务栏指示器，完成或**等待用户选择**时通知 | **低**：证实「DSH 等待态必须单独表达」的真实痛点；实现细节未公开 |
| 18 | [jondot/tauri-tray-app](https://github.com/jondot/tauri-tray-app) | 114 | TypeScript + Tauri | 2023-04-25 | Tauri 托盘应用脚手架 | **低**：脚手架，2023 年后未更新 |
| 19 | [4gray/tauri-menubar-app](https://github.com/4gray/tauri-menubar-app) | 130 | Rust + Tauri | 2023-01-28 | 简洁 Tauri menubar 应用示例 | **低**：同上，已过时 |

### 8.3 高关注但**明确排除**（macOS / Web 方向）

| # | 仓库 | Star | 技术栈 | 最近提交 | 排除原因 |
| --- | --- | --- | --- | --- | --- |
| 20 | [m1ckc3s/claude-status-bar](https://github.com/m1ckc3s/claude-status-bar) | **707** | Swift | 2026-09-18 | **该方向 star 最高的需求验证**：macOS 菜单栏 Claude Code 状态指示器。**Swift/macOS 专属，Windows 不可用**，故只能作为「需求已被验证」的证据 |
| 21 | [sooink/claude-watch](https://github.com/sooink/claude-watch) | 5 | Swift | 2026-02-11 | macOS 菜单栏，展示 Claude Code **并行 subagent** 在做什么 → 印证「多任务并行展示」是真实需求；平台不符 |
| 22 | [hiroppy/tmux-agent-sidebar](https://github.com/hiroppy/tmux-agent-sidebar) | **544** | Rust | 2026-10-12 | 跨全部 window/session 实时监控 AI agent 的 tmux 侧边栏。**需 tmux**（Windows 无原生 tmux），且形态是终端内 TUI 而非桌面悬浮灯 |
| 23 | [snirt/agenmux](https://github.com/snirt/agenmux) | 54 | Rust | 2026-10-08 | tmux agent 监控器 + session 管理 + 可导航 session/window/pane 树。同上，tmux 限定 |
| 24 | [hoangsonww/Claude-Code-Agent-Monitor](https://github.com/hoangsonww/Claude-Code-Agent-Monitor) | **1066** | TypeScript | 2026-10-11 | Claude Code/Codex 实时监控 **Web Dashboard**（SQLite + Express + React + WebSocket）。形态是浏览器页面，不是桌面托盘/悬浮灯；★ 最高说明需求强烈，但交付形态不符 |
| 25 | [electron/electron](https://github.com/electron/electron) | 123288 | C++ | 2026-10-12 | **作为运行时依赖采用**（不 fork）：`Tray`/`nativeImage`/`BrowserWindow{alwaysOnTop, frame:false, transparent}`/`Notification`/`app.setLoginItemSettings` 全部开箱可用 |
| 26 | [tauri-apps/tauri](https://github.com/tauri-apps/tauri) | 111791 | Rust | 2026-10-12 | Tauri 2 备选运行时（P2-6），托盘需 `tray-icon` crate，动态图标需 Rust 侧重绘 |

### 8.4 复用决策汇总

| 决策 | 项目 | 理由 |
| --- | --- | --- |
| ✅ **直接借鉴设计**（注明出处，符合 MIT/署名要求） | `accessd/tmux-agent-indicator`、`ru-gong/agent-beacon`、`carlbuu/ai-status-light-esp32` | 三者 MIT 许可，状态机/状态文件协议/状态优先级/hook 合并策略是本项目最核心的设计资产 |
| ✅ **作为运行时依赖** | `electron/electron`、`electron/electron-builder` | 托盘/置顶窗/通知能力成熟，无需自研或 fork |
| ⚠️ **仅作 UI/交互对照** | `BJlaoma/agent-pulse`、`SwordSifu/dsh-desktop` | 形态最接近但**无 LICENSE 或强绑单一 Agent**，不可 fork，仅参考 |
| ❌ **排除** | 其余 20 个候选 | macOS 专属（★ 最高的三個都在此列）/ 需 tmux / 需 ESP32 硬件 / 只监控额度而非任务状态 / 已过时 |

**结论论证（为何不能二次开发）**：

1. **平台错配**：Star 最高的 3 个可用项目（`claude-status-bar` ★707、`Claude-Code-Agent-Monitor` ★1066、`tmux-agent-sidebar` ★544）分别是 macOS 菜单栏、Web Dashboard、tmux TUI —— **没有一个是 Windows 桌面托盘应用**。
2. **场景错配**：真正做 Windows 托盘状态灯的 3 个项目（`agent-pulse` ★2、`agent-beacon` ★2、`ai-status-light-esp32` ★2）**star 均 ≤ 2**，且各缺一块：`agent-pulse` 强绑 opencode 插件且无 LICENSE；`agent-beacon` 明确「同一时间只接入一个目标」；`ai-status-light-esp32` 输出到 ESP32 串口 LED。**没有一个同时具备「多任务并行 + 三类监控方式 + Windows 托盘 + 悬浮置顶」**。
3. **能力无需 fork**：`Tray`、置顶无边框透明窗、Windows 通知、开机自启在 Electron 均为**官方 API**，直接调用即可，引入 fork 反而会带来上游合并、无 LICENSE 侵权、单点作者单点故障三重风险。
4. **成本对比**：fork 一个 ★2、无 LICENSE、架构与需求错配的项目，改造成本 > 从零实现一个 6 模块的监控器（托盘/灯/列表/监控器/配置/通知）。

---

## 9. 待确认问题（含默认假设）

| # | 问题 | 默认假设（架构阶段可直接开工） | 若用户不同意的风险 |
| --- | --- | --- | --- |
| Q1 | **要监控哪些具体工具的什么信号？** workbuddy / dsh 有无稳定的 hook 机制或状态输出？ | **假设：三者均不保证有稳定 hook**，因此 **P0 强制要求 `process`（进程/命令行）与 `log`（日志正则）两种通用方式即可跑通**，`webhook` 作为可选精确通道（P1-1）。日志路径与关键字规则全部写进 YAML，由用户自行填。 | 若 dsh 的 `/api/events.mux` WebSocket 可直连，状态精度会显著提升（`dsh-desktop` 已验证），可把 webhook 监控器升级为 `dsh-native` 专用监控器 |
| Q2 | **默认监控哪几个任务？是否要预置 workbuddy/dsh 的模板配置？** | **假设：预置 3 个 disabled 模板**（`workbuddy-server` 进程型、`dsh` webhook 型、`generic-log` 日志型），用户改名+改路径即用；不在应用内做任务增删 UI（P1 明确排除） | 若期望 GUI 化管理任务，工作量增加约 40%，需插入 P0 |
| Q3 | **悬浮灯是"始终可见"还是"仅在有任务运行时显示"？** | **假设：常驻可见但极简**（28px 圆点、92% 不透明度、无焦点），空闲时为灰色小点，可用 `clickThrough: true` 让鼠标穿透 | 若用户长期嫌碍事，需加「仅 running 时显示」的自动隐藏模式（可作为 P1 补充） |
| Q4 | **"跳转到终端窗口"如何确定目标？** | **假设：优先 Windows Terminal（`wt.exe -w <窗口名>`），匹配失败则回退「在任务 cwd 新开一个终端窗口」**。**不支持**定位 conhost/PowerShell 独立控制台窗口（技术限制：现代 Windows Terminal 已成默认，且 conhost 窗口标题可被任意程序占用，匹配不可靠） | 若用户强依赖「切回已在跑的独立控制台窗口」，只能靠窗口标题模糊匹配，可用 `Fabian2000/pc_watcher` 类思路增强，成功率会低于 90% |
| Q5 | **提示音用自备音频文件还是系统默认通知音？** | **假设：用系统默认通知音**（`Notification` 自带），不内置音频文件 —— 避免分发二进制资源、避免版权问题、零体积。若需自定义音效，做成 P2（配置项 `notify.soundFile`） | 用户若要区分「完成音/失败音/等待音」三套（P0-6 四态已有不同音的描述），必须内置音频，届时以 3 个 ≤ 1s 的 WAV 随包分发 |

---

## 10. 交付物清单（给架构与研发阶段）

| # | 交付物 | 说明 |
| --- | --- | --- |
| D1 | 完整可运行代码 | Electron + Vite + React + TS + Tailwind，`npm run dev` / `npm run dist` |
| D2 | 依赖说明与版本锁定 | `package.json` + `package-lock.json` |
| D3 | 配置文件示例 + Schema 文档 | `config.example.yaml` + §6 文档 |
| D4 | 三类监控方式的接入说明 | 逐个给 `process` / `log` / `webhook` 的最小可用配置 + 验证步骤（如「故意让进程崩溃看灯变红」） |
| D5 | 打包配置 | `electron-builder` NSIS，含开机自启项、单实例锁 |
| D6 | 设计出处说明 | 借鉴 `tmux-agent-indicator`（MIT）、`agent-beacon`（MIT）、`ai-status-light-esp32`（MIT）的部分，在 `README` 与代码注释中标注 |

---

*文档结束。数据核验：`api.github.com` 检索于 2026-10-12；star 数与最近提交时间为该日期实时值。*