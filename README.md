# AI 任务状态指示灯（ai-task-indicator）

Windows 桌面悬浮指示灯，用于实时监控多个 AI 工具（WorkBuddy / DeepSeek Harness / dsh 等）并行任务的执行状态。

托盘常驻 + 桌面置顶指示灯，七态颜色一眼可辨；任务完成或失败时弹窗 + 提示音；点击可直接跳回任务现场 —— 包括**经附带的 Chrome 扩展精确切回已打开的那个浏览器标签页**，而不是又新开一个。

![灯带预览](./deliverables/strip-preview.png)

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [快速开始](#快速开始)
- [五种监控方式如何配置](#五种监控方式如何配置)
- [配置文件说明](#配置文件说明)
- [状态与颜色](#状态与颜色)
- [浮窗的两个形态（含边缘停靠）](#浮窗的两个形态含边缘停靠)
- **⚠️ 已知限制：跳转能做到什么程度**（先读这一节）
- [浏览器扩展：精确切回已打开的标签页](#浏览器扩展精确切回已打开的标签页)
- [开发与打包](#开发与打包)
- [验证步骤](#验证步骤)
- [设计出处](#设计出处)

---

## 它解决什么问题

同时跑多个 AI CLI 任务时，你没法一直盯着终端。常见痛点：

- 任务卡在「等待授权」，你没注意到，白等半小时；
- 某个任务崩了，另外三个还在跑，你分不清哪个挂了；
- 想看某个任务的状态，必须切窗口 + 找对标签页。

这个应用把这些状态收到一个常驻托盘图标 + 一个桌面小灯上。

```
托盘图标        绿=空闲  蓝闪=运行中  黄闪=等待授权  绿✓=已完成  红=失败  灰=失联
                右上角数字 = 正在运行的任务数
悬浮灯          桌面右上角 28px 圆点，同色系，running 时有呼吸动画
任务面板        点托盘左键展开，列出每个任务的状态/耗时/最近消息
```

---

## 快速开始

### 环境要求

- Windows 10/ 11
- Node.js ≥ 20

### 安装与运行

```bash
# 1. 安装依赖
npm install

# 2a. 一键冒烟自检（不开窗口，~2秒，22 项断言）
npm run smoke

# 2b. 用演示配置启动 GUI（config.demo.yaml 里三个任务都已 enabled: true）
npm run start:demo

# 2c. 或者用你自己的配置
npm run build && npm start -- --config D:/path/to/your-config.yaml
```

首次运行会自动在 `%USERPROFILE%\.ai-task-indicator\config.yaml` 落盘一份配置模板，直接编辑该文件即可。

> **请用 `npm start` 而不是 `npx electron .`**
> 启动器脚本会自动处理两个会让 GUI 静默失效的环境问题（都实测踩过，详见下方「启动失败排查」）：
> 1. `ELECTRON_RUN_AS_NODE=1` —— 部分 IDE 终端 / CI 会预设它，会让 electron.exe 退化成普通 Node 解释器；
> 2. GPU 进程崩溃 —— 无显卡 / 远程桌面 / 虚拟机里会 `FATAL: GPU process isn't usable. Goodbye.`。
>
> 本应用是纯 2D UI，禁用 GPU 加速完全无损。需要排查渲染问题时用 `npm start -- --enable-gpu`。

> **`npm run smoke` 是最快的验证方式**：它不依赖 Electron 窗口，会真实启动本地 HTTP 服务读写日志文件、驱动状态机，验证「配置加载 → 日志判定 → 状态流转 → Webhook 回调」这条主链路。任何时候改了核心逻辑，先跑它。

### 启动失败排查

| 现象 | 原因 | 处理 |
|------|------|------|
| `Cannot read properties of undefined (reading 'requestSingleInstanceLock')` | `ELECTRON_RUN_AS_NODE=1` 让 electron.exe 退化成普通 Node | 用 `npm start`（自动清除），或 `set ELECTRON_RUN_AS_NODE= && npx electron .` |
| `FATAL: GPU process isn't usable. Goodbye.` | GPU 进程以 `0xC0000409` 崩溃 | 用 `npm start`（自动加 `--disable-gpu` 等参数） |
| 双击图标能开、命令行启动失败 | 上述变量只存在于某些终端会话 | 同上，统一走 `npm start` |
| 日志里 `进程枚举子进程第 N 次重启` 后任务转 `unknown` | `Get-CimInstance` 被沙箱/安全策略拦截 | 正常降级行为，进程型监控不可用；改用 log 型或 webhook 型 |

应用日志在 `%APPDATA%\ai-task-indicator\logs\ai-task-indicator-YYYY-MM-DD.log`，排查问题时先看它。

> 如果 `npm install` 卡在 electron 下载或报 rollup 平台包缺失，属环境问题，可用项目内置的补齐脚本：
> ```bash
> node scripts/fix-missing-deps.mjs @rollup/rollup-win32-x64-msvc
> ```

---

## 五种监控方式如何配置

配置文件的 `tasks` 数组里，每个任务用 `monitor.type` 指定监控方式：`process` / `log` / `webhook` / `dsh` / `sqlite`。

### 方式一：process —— 监听本地进程与命令行参数

适用：任务有明确的常驻进程（如 WorkBuddy 主进程、某个 IDE、CI runner）。

原理：应用启动一个**长驻 PowerShell 子进程**，周期性输出 `Get-CimInstance Win32_Process` 的结果（JSON 行），主进程按进程名 + 命令行子串匹配判断任务存活。

```yaml
tasks:
  - id: workbuddy
    name: WorkBuddy 主进程
    enabled: true
    monitor:
      type: process
      match:
        # match 数组之间是「或」；单个 match 内 processNames 与 cmdlineContains 是「与」
        - processNames: [node.exe, workbuddy.exe]
          cmdlineContains: [workbuddy]
      onExit:
        successExitCodes: [0]      # 退出码 0 算成功，其余算失败
        graceMs: 3000               # 进程消失后等3s 再定状态，留出日志刷尾时间
      fallbackLog:                 # 可选：没匹配到进程时的兜底信号源
        paths: ["%USERPROFILE%/.workbuddy/logs/*.log"]
        stateOnNewLine: running
    jump:
      terminal: { type: windowTitle, match: WorkBuddy }
      cwd: "%USERPROFILE%"
```

**要点**

- 进程存在 → `running`；进程消失 → 等 `graceMs` → 按退出码判`success` / `failed`。
- `cmdlineContains` 强烈建议填写。本机 `node.exe` 可能同时跑着好几个项目，只按进程名匹配会误报。
- **实现说明**：出于兼容性考虑，此处不使用已被 Windows 10 21H1 弃用的 `wmic`；`tasklist` 又拿不到命令行，因此采用 `Get-CimInstance`。
- 若想省内存可设 `app.processPollMode: onDemand`（每轮 spawn 一次，慢但轻量）。

### 方式二：log —— 轮询日志文件或目录变化

适用：没有独立进程，但会往日志文件写输出的任务（多数 AI CLI 都属于这类，如 dsh、pytest、仿真脚本）。

原理：递归扫描配置的路径，对每个文件做**增量 tail**（只读新增字节），用正则规则把日志行判定成状态。

```yaml
tasks:
  - id: dsh-harness
    name: dsh 仿真任务
    enabled: true
    monitor:
      type: log
      paths:
        - "D:/projects/demo/**/*.log"   # 支持 ** 递归通配
      readMode: tail
      fromEndBytes: 65536          # 首次接入只读末尾 64KB，避免全量重扫大文件
      rules:
        - state: failed
          match: "(error|fatal|exception|failed|\\bE[0-9]{4}\\b)"
        - state: waiting
          match: "(permission request|waiting for input|needs?_input|请确认)"
        - state: success
          match: "(task complete|completed|done|完成)"
        - state: running
          match: "(running|executing|subagent|step [0-9]+)"
      idleAfterSilenceMs: 60000    # 日志静默 60s → 转idle（防长尾任务一直显示在跑）
    jump:
      cwd: "D:/projects/demo"
      openWith: notepad.exe
```

**要点**

- **`paths` 必须是「文件」或「带通配符的目录」**，两种写法：
  - 单个日志文件：`paths: ["D:/logs/run.log"]` ✅（无通配符时按精确路径匹配，需文件真实存在）
  - 目录下的日志：`paths: ["D:/logs/**/*.log"]` ✅（递归任意层级）
  - ⚠️ **不要只写目录**：`paths: ["D:/logs"]` 会返回 0 个文件 —— 因为「目录 = 递归所有文件」会让 `node_modules` 这类海量目录被整个扫进来。若确实要监控目录下所有日志，请写 `"D:/logs/**"` 或 `"D:/logs/**/*.log"`。
- **正则不要写 `(?i)` 前缀**——JS 正则不认它，会被当成字面量匹配，导致所有规则静默失效。应用默认已用 `i` 标志（忽略大小写）。
- 某条正则写错时**只有那一条被丢弃**，其余照常生效，托盘气泡会提示哪条出错。
- `failed` 拥有最高判定优先级：同一段文本里既有 `running` 又有 `error` 时，一定判 `failed`。
- 日志文件被截断或轮转不会导致崩溃。

### 方式三：webhook —— 接收外部状态回调

适用：你自己写的脚本/CI/其他工具能感知任务状态，主动上报。

原理：主进程内建一个**仅监听 127.0.0.1** 的 HTTP 服务，收到 POST 后更新状态。

```yaml
app:
  hookPort: 17890

tasks:
  - id: remote-agent
    name: 远程 Agent 任务
    enabled: true
    monitor:
      type: webhook
      listen: 127.0.0.1
      path: /hook/remote-agent
      secret: change-me-local-token
      fieldMap:
        state: $.status        # 从 JSON payload 里取字段，支持 $.a.b
        message: $.message
        progress: $.progress
      heartbeatTimeoutMs: 120000  # 心跳超时 → 转 unknown
```

**测试用curl**：

```bash
curl -X POST http://127.0.0.1:17890/hook/remote-agent \
  -H "Content-Type: application/json" \
  -H "x-indicator-token: change-me-local-token" \
  -d '{"status":"running","message":"开始执行","progress":0.2}'

curl -X POST http://127.0.0.1:17890/hook/remote-agent \
  -H "Content-Type: application/json" \
  -H "x-indicator-token: change-me-local-token" \
  -d '{"status":"waiting","message":"等待授权"}'
```

**可用状态**：`idle` / `starting` / `running` / `waiting` / `success` / `failed` / `unknown`。非法状态返回 400，token 不匹配返回 401。

**安全性**：强制 loopback（不会监听 0.0.0.0）、校验 Host 头、token 用 `timingSafeEqual` 比较、请求体上限 64KB、不发 CORS 头。

**读状态接口**：`GET http://127.0.0.1:17890/api/tasks` 返回当前所有任务状态（JSON）。

### 方式四：dsh —— 主动轮询 DeepSeek Harness 实例（含 SSH 隧道）

适用：任务跑在 dsh（DeepSeek Harness）里 —— 本地客户端、本机 web、或经 SSH 隧道暴露的远端实例。

原理：**零侵入**。应用自己发现监听端口、用 `~/.dsh/.credentials.yaml` 里的明文密钥离线自签
`dsh-auth-<sha256(authority)>` cookie，再打 `POST /api/session/list` 拿会话状态 ——
**不需要在 dsh 里装任何东西**。

```yaml
tasks:
  - id: dsh-local
    name: dsh（本地客户端）
    monitor:
      type: dsh
      authority: 127.0.0.1:19387      # cookie 名与签名都绑定它
      intervalMs: 5000
      heartbeatTimeoutMs: 120000
    shortLabel: 本地客户端            # 灯带上显示的短标签（不填则显示端口号）

  - id: dsh-web
    name: dsh（远端隧道）
    monitor:
      type: dsh
      authority: 127.0.0.1:13080
      sshHost: user@your-host         # ★ 隧道型：本机密钥必然 401，需从远端取
```

**要点**

- **隧道型实例必须配 `sshHost`**：本机密钥对隧道端口会 401（这正是识别"远端实例"的可靠信号）。
  配上后应用会经 `ssh <host>` 读远端 `~/.dsh/.credentials.yaml`，在**本地**为该隧道端口签
  cookie，并缓存 30 分钟。
- 主动轮询拿不到"等待授权"的**精确**信号（关键字扫描 0 命中），只能用 `plan.pending` 近似；
  要精确值需在 dsh 侧装插件、走 `webhook` 型上报。
- 连续失败 5 次 → 该实例转 `unknown`（浮窗会隐藏该行）。

### 方式五：sqlite —— 直接读应用的数据库

适用：目标应用把任务状态写在 SQLite 库里（本项目用于 WorkBuddy）。

原理：**spawn 系统 `node.exe`** 以只读方式查库。Electron 33 内置的 Node 20 没有 `node:sqlite`
（该模块要 Node 22.5+），所以走外部 node；没装时优雅降级，不会崩。

```yaml
tasks:
  - id: workbuddy
    monitor:
      type: sqlite
      database: D:/your-appdata/.workbuddy/workbuddy.db
      activeStatus: working      # sessions.status == 它
      activeWithinMs: 120000     # 且 last_activity_at 在 2 分钟内 —— 两个条件缺一不可
      requireProcess:            # 可选闸门：进程不在 -> unknown（隐藏该行）
        - processNames: [WorkBuddy.exe]
      notifyOnDone: true
```

**要点**

- **`activeStatus` 与 `activeWithinMs` 缺一不可**：实测真库里有 `status='working'` 但已静默
  20 小时的**遗留记录**（异常退出没回写），只看 status 会永远亮蓝。
- 该字段大小写不统一（同时存在 `terminated` / `Terminated`），比较已做归一化。
- 「刚完成」判定用 `updated_at` 而非 `last_activity_at` —— 完成时会额外刷一次 `updated_at`，
  它更接近"写完完成状态的那一刻"。

---

## 配置文件说明

**位置**：`%USERPROFILE%\.ai-task-indicator\config.yaml`

**路径优先级**（`--config` 最高）：

```
1. 命令行 --config <path>
2. %USERPROFILE%\.ai-task-indicator\config.yaml
3. <userData>/config.yaml
4. 都不存在 → 落盘一份模板到路径 2
```

**热重载**：保存配置文件即生效，无需重启。语法错误时**保留旧配置**并在托盘气泡提示，不会把应用搞挂。

**容错原则**：单个字段非法只丢弃该字段并记录警告，其余照常生效；非法的任务项被跳过，好任务不受影响。你会得到一份逐条说明的警告列表。

完整的字段说明与 process / log / webhook 三种示例见 [`config.example.yaml`](./config.example.yaml)；
dsh 与 sqlite 型的完整示例见 [`config.dsh.example.yaml`](./config.dsh.example.yaml)。

> **本地私有取值**：部分校验脚本（`sqlite-monitor-check` / `d5-tunnel-check` / `d5-ssh-probe`）
> 需要本机的真实 SSH 主机与数据库路径。仓库里**只保留占位符**，真实取值放在
> `config.local.yaml`（已在 `.gitignore` 中），脚本会经 `scripts/lib/local-config.mjs`
> 自动读取；也可用环境变量 `LAMP_SSH_HOST` / `LAMP_WORKBUDDY_DB` 覆盖。
> 优先级：命令行参数 > 环境变量 > `config.local.yaml` > 占位符。

---

## 状态与颜色

| 状态 | 颜色 | 含义 |
|------|------|------|
| `idle` | 灰 | 未开始 / 已清理 |
| `starting` | 青 | 刚发现进程或信号，正在启动 |
| `running` | 蓝（呼吸动画） | 正在执行 |
| `waiting` | 黄（快闪） | 等待你确认/授权—— **最容易卡住的态** |
| `success` | 绿 | 已完成（有未读标记） |
| `failed` | 红 | 失败或等待超时 |
| `unknown` | 深灰 | 信号超时，监控源可能失联 |

**托盘聚合优先级**：`failed > waiting > running > success > starting > idle > unknown`。任何一个任务失败，整个灯变红。

**关键行为约定**

- 任务失败后**不会自动变绿**，必须显式重置或等`dismiss_after` 清理。
- 信号静默超过 `staleTimeoutMs`（默认 60s）转 `unknown`，避免「灯一直绿但任务早死了」。
- `waiting` 悬挂超过 `waitingTimeoutMs`（默认 30min）转 `failed`，防悬挂。

---

## 浮窗的两个形态（含边缘停靠）

悬浮灯有两种常规形态，再叠加一种**贴边后自动切换的点阵形态**：

| 位置 | 形态 | 长什么样 |
|------|------|----------|
| 桌面任意处，可显示任务 ≥ 2 | 常规灯带 | 竖排：总灯在上，下面每行「小灯 + 短标签」 |
| 桌面任意处，可显示任务 < 2 | 单灯 | 一颗圆点，干扰最小 |
| **贴屏幕左 / 右边缘 24px 以内** | 竖排点阵 | 只剩一列圆点，**不带文字** |
| **贴屏幕顶部 24px 以内** | 横排点阵 | 只剩一排圆点，**不带文字** |

「可显示任务」= 已排除失联（`unknown`）/ 失败（`failed`）的行 ——
浮窗里出现的默认就该是活着的（口径见 `src/shared/visibility.ts`）。

| 贴侧边：竖排点阵 | 贴顶部：横排点阵 |
|---|---|
| ![竖排点阵](./deliverables/dock-vertical.png) | ![横排点阵](./deliverables/dock-horizontal.png) |
| 36×79（该时刻 2 个任务） | 75×40（该时刻 2 个任务） |

> 两张图是**真实截图**（CDP 直接抓的 overlay 画布，未经修图），
> 所以尺寸就是窗口实际像素 —— 底板的半透明在深色桌面上会更沉一些。

**怎么用**：把灯拖到屏幕的左 / 右 / 上边缘松手，约 0.2 秒后它自己收敛成点阵；
拖回桌面中间，又自动展开回带标签的灯带。**不需要任何配置**。

### 这几条取舍都是实测出来的

- **阈值 24px**：太小很难对准，太大则会把"只是放在旁边"误触发。
- **顶部优先**：左上角同时贴两条边时按横排处理（横排更好认）。
- **贴底部不变形态** —— 只做侧边与顶部。
- **"越过"屏幕边不算贴边**：窗口跨屏摆放（一半在主屏、一半在副屏）不会被误判成停靠。
  这个 bug **只有真机跑起来才暴露** —— 详见 [`docs/design-decisions.md`](./docs/design-decisions.md) 的 D90。
- **贴着的那条边钉住不动**：右停靠缩小时窗口往左收，不会越缩越离屏幕边远。
- 点阵形态**连数量徽标一起藏掉** —— 它的定位就是"只剩一排灯"，需要数字时点开面板。

---

## ⚠️ 已知限制：跳转能做到什么程度

这一节请务必读完，它决定了你该怎么配置 `jump`。

### 结论

| 目标 | 能否 | 靠什么 |
|---|---|---|
| 把终端**窗口**带到前台 | ✅ | Win32：先最小化 → 恢复 → `SetForegroundWindow` |
| 切到**浏览器里已打开的那个标签页** | ✅ | 附带的 Chrome 扩展（见下一节） |
| 切到 Windows Terminal 的**某个历史标签页** | ❌ | OS 层面无 API |

两点值得展开：

1. **窗口级聚焦必须走「最小化 → 恢复」这个往返**，否则抢不到前台。实测在"窗口正常显示、
   只是不在前台"时：直接 `SetForegroundWindow` 返回 False；`AppActivate` **返回 True 却什么都没做**。
   所以本项目的成功判据是 `GetForegroundWindow()` 的**真实结果**，不是任何 API 的返回值。
2. **最后一条是 Windows Terminal 的限制**：它的命令行只有 `focus-tab`（当前页）和 `new-tab`，
   没有 `activate tab N`。浏览器那边不同 —— 可以用扩展做到（下一节）。

### 降级链

点击灯带某一行时的尝试顺序如下，任何一级失败都自动降级，**永不抛异常**
（点一下通知按钮不该让主进程崩）：

配了 `openUrl` 时（Web 界面类任务）：

```
① 浏览器扩展精确切标签 → ② CDP（可选，需专用调试实例）→ ③ 按窗口标题聚焦 → ④ 新开标签页
```

没配 `openUrl` 时（终端类任务）：

```
L1  spawn 型：直接执行你配的命令（如 wt.exe new-tab -d <cwd>）   ← 首选，最可靠
L2  窗口级聚焦：先最小化 → 恢复 → SetForegroundWindow            ← 异步，不阻塞
L3  目录兜底：explorer.exe <cwd>                                 ← 实测最可靠
L4  日志兜底：用 notepad（或你指定的程序）打开日志
L5  全部失败：返回失败，只记日志
```

### 怎么配才对

想要**打开终端并跳到指定目录**，用 spawn 型而不是 windowTitle 型：

```yaml
jump:
  terminal:
    type: spawn
    cmd: wt.exe
    args: ["new-tab", "-d", "D:/your/project"]   # 新开标签页并定位到目录
  cwd: "D:/your/project"      # L3 兜底用
```

注意：**本机若没装 Windows Terminal，`wt.exe` 不存在**，此时 L1 会被跳过（应用启动时探测一次并缓存）。托盘菜单里有「重新探测终端」，装了之后点一下即可刷新。

### 其他实测结论

- 窗口标题**只能作兜底**：实测发现重名窗口（如两个「计算器」），且任何程序都能改自己的标题。
- 无原生模块依赖：全部 Win32 操作通过 PowerShell/COM 完成，因此**不需要 C++ 工具链**，打包失败风险低。

---

## 浏览器扩展：精确切回已打开的标签页

点「dsh-web」这类 Web 界面任务时，如果只配 `openUrl`，语义就是"打开这个网址" ——
于是每点一次多一个标签页。想改成"切回已经开着的那个标签"，需要能操作浏览器标签的能力。

### 为什么不用 Chrome 调试端口

`--remote-debugging-port` + CDP 本来可以精确切标签，但 **Chrome 136 起，默认用户数据目录下
该端口被静默忽略**（实测 Chrome 139 直接报
`DevTools remote debugging requires a non-default data directory`）—— 也就是说它只能用在
"专用调试实例"上，**碰不到你的日常浏览器**。

所以本项目附了一个极小的 Chrome 扩展（[`extension/`](./extension/)），用
`chrome.tabs.update({active:true})` + `chrome.windows.update({focused:true})` 操作你日常浏览器里
的真实标签。

### 装一次（约 10 秒）

1. Chrome 地址栏输入 `chrome://extensions`
2. 右上角开启 **开发者模式**
3. 把 `extension/` **整个文件夹拖到页面上**（松手即装）；或点「加载已解压的扩展程序」选择该目录

> 拖文件夹与本项目的「加载已解压」等价，是最省事的方式。
> ⚠️ **拖文件夹、不要拖 `.crx`**：Chrome 要求扩展带 Web Store 来源证明，自打包的 `.crx` 会报
> `CRX_REQUIRED_PROOF_MISSING`。仓库**不附带** `.crx`；确实需要时用
> `node scripts/pack-extension.mjs` 自行生成（详见 [`extension/README.md`](./extension/README.md)）。

然后在任务里打开这个开关：

```yaml
jump:
  openUrl: http://127.0.0.1:13080
  openUrlViaExtension: true        # 经扩展切回已打开的标签，而不是新开
```

### 工作原理

指示灯主进程起一个小 HTTP 服务（只监听 `127.0.0.1:17891`），扩展**长轮询**它：

```
扩展 --GET /poll------------------> 指示灯     （挂起最多 20s，或直到有指令）
扩展 <-----------{command:{id,url}}
扩展  chrome.tabs.update(tabId,{active:true}) + chrome.windows.update({focused:true})
扩展 --POST /result {id, ok}------> 指示灯     （ok=false => 指示灯退回"新开标签"）
```

- **按同源匹配**：`http://127.0.0.1:13080/#/whatever` 算同一个页面，完整 URL 不会因路由变化而失配。
- **至少一次投递**：指令会一直留在待办槽里，直到扩展回报结果。扩展的 MV3 service worker 随时
  可能被回收 —— 若"投给一条已经断掉的连接就算送达"，这次点击会**静默丢失**（表现为
  "点了没切成、又新开一个"）。
- **安全**：只监听 loopback；请求必须带 `x-indicator-extension: 1`。网页想带自定义头会先触发
  预检，而该服务不返回任何 CORS 头 → 预检必然失败 → 普通网页伪造不了。
- **没装扩展也不会坏**：检测不到扩展轮询时，点击直接走"新开标签页"，不会白等。

详见 [`extension/README.md`](./extension/README.md)。

---

## 开发与打包

```bash
npm run dev            # 编译 + 启动开发模式
npm run start:demo     # 用演示配置启动（自动处理 GPU / 环境变量）
npm start              # 用默认配置启动
npm run typecheck      # 三份 tsconfig 类型检查（main + renderer + test）
npm test               # 单元测试（vitest）
npm run smoke          # 端到端冒烟（不开窗口，真实 IO，~2秒）
npm run dist           # 打包 Windows NSIS 安装包
```

**技术栈**：Electron + TypeScript，**零UI 框架、零打包器**（渲染层用原生 DOM，构建用 tsc）。生产依赖仅 `electron` + `yaml` 两个。

**目录结构**

```
src/
  shared/       类型契约、IPC 契约、常量（主进程与渲染层共用）
  main/         主进程：托盘、悬浮窗、面板、状态仓库、通知、跳转
    monitors/   三种监控器 + 规则引擎
  preload/      contextBridge 白名单
  renderer/     悬浮灯 + 任务面板（classic script，无 import）
test/           单元测试
poc/            Windows API 实测脚本（POC 报告的证据）
docs/           PRD、架构设计、POC 报告
```

---

## 验证步骤

想确认它真的在工作，按这个顺序试：

1. **看灯变色**：跑一个会输出日志的任务（方式二），日志里出现 `error` 字样时，灯应变红。
2. **看通知**：任务失败时应弹窗 + 响提示音。可在配置里关掉其中之一：`notify.popup: false` / `notify.sound: false`。
3. **测 webhook**（最容易验证）：启用示例三的 `remote-agent` 任务，用上面的 curl 发 `running` 再发 `failed`，观察灯和通知。
4. **故意让进程崩溃**：配一个 process 型任务指向临时进程（如 `ping -t`），然后关掉它，灯应在 `graceMs` 后变红。
5. **验证去重**：让日志高频输出 `error`，同一任务 30s 内只应通知一次，通知里显示 `×N` 累计次数。

---

## 设计出处

本项目**未fork 任何外部项目**。GitHub 上检索到的 26 个候选项目经 `api.github.com` 实时核验后确认无一同时满足「Windows + 托盘 + 悬浮灯 + 多任务 + 三类监控」，故从零实现，托盘/置顶/通知直接使用 Electron 官方 API。

以下三个 MIT 项目的设计思路被借鉴（详见 `docs/01-PRD.md` 第 8 节）：

- [`accessd/tmux-agent-indicator`](https://github.com/accessd/tmux-agent-indicator) —— hook 驱动的事件→状态映射
- [`ru-gong/agent-beacon`](https://github.com/ru-gong/agent-beacon) —— 状态 JSON 文件协议
- [`carlbuu/ai-status-light-esp32`](https://github.com/carlbuu/ai-status-light-esp32) —— 状态优先级与多任务表达

---

## 文档

| 文件 | 内容 |
|------|------|
| **[`docs/design-decisions.md`](./docs/design-decisions.md)** | **决策台账（87 条，推荐先读这份）** —— 每条记了"发现了什么、为什么这么选、踩了什么坑" |
| **[`docs/04-SPEC.md`](./docs/04-SPEC.md)** | **需求规格说明** —— 功能需求、状态机规格、当前状态、下一步 |
| [`docs/05-NEXT-PROMPT.md`](./docs/05-NEXT-PROMPT.md) | 下一步开发提示词，可直接复制给 AI 执行 |
| [`docs/01-PRD.md`](./docs/01-PRD.md) | 产品需求、竞品选型结论、配置 schema |
| [`docs/02-ARCHITECTURE.md`](./docs/02-ARCHITECTURE.md) | 架构设计、任务分解、类型契约 |
| [`docs/03-POC-REPORT.md`](./docs/03-POC-REPORT.md) | Windows API 实测报告（含本 README「已知限制」的证据） |
| [`docs/round*.md`](./docs/) | 逐轮开发记录（21 篇）：每轮修了什么真实缺陷、实测拿到了什么结论 |

> **这些文档是一份副本。** 在本机的原始工作区里，它们的编辑位置在仓库之外（工作区根 `docs/`），
> 同步进仓库靠 `node scripts/sync-docs.mjs` —— 它会顺带做**自动脱敏**、**台账编号校验**
> （1..N 无缺号/重复）与**个人信息残留扫描**（有残留即非零退出）；`--check` 只比对不写文件，可挂 CI。
> 若你只是读这个仓库，直接用仓库里这份即可。

## License

MIT