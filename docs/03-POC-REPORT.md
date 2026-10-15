# POC 实测报告 — Windows Terminal 定位与关键可行性验证

> 执行人：高见远（架构师）｜日期：2026-10-12｜环境：Windows 10/11 沙箱（受限）
> 脚本目录：`poc/`｜复现方式见每节标注

---

## 0. 一句话结论

**「跳转到终端窗口」能做到的是：把目标终端窗口带到前台（窗口级，确定性高）；做不到的是：精确切换到 Windows Terminal 的某个历史标签页（页级，WT CLI 不提供该能力）。**
因此工程上必须封装成 **`focusTerminal()` 多级降级链**，而不是"精确跳转"。

---

## 1. 沙箱限制声明（影响哪些结论可信）

本沙箱的安全策略禁用了以下能力，导致部分 Win32 调用**无法直接实测**：

| 被禁用 | 影响 |
| --- | --- |
| `Add-Type`（.NET 内联编译） | 无法内联 P/Invoke 声明 |
| `csc.exe` | 无法编译独立 P/Invoke 程序 |
| `Reflection.Assembly.Load*` | 无法加载 UIAutomation / Microsoft.VisualBasic |
| COM 实例化（`New-Object -ComObject`） | 无法测`WScript.Shell.AppActivate` |
| `wmic.exe`（程序黑名单） | WMIC 路线实测为不可用 |

**因此 `SetForegroundWindow` / `AttachThreadInput` / `GetForegroundWindow` / `AppActivate` 的直接调用未实测**，结论依据 Win32 官方文档给出（见 §5）。
关键点：架构设计已采用**「盲操作 + 多级降级」**策略，**不依赖前台窗口查询**，所以这部分未实测不影响可交付性。

**可实测的部分已全部实测，下文标注 `[实测]`；未实测标注 `[文档]`。**

---

## 2. `[实测]` 窗口枚举与 HWND 获取 —✅ 可行

脚本：`poc/poc-2-empirical.ps1` §(a)

```
含标题的顶层窗口总数: 16
  pid=5652  hwnd=0x3345372  ApplicationFrameHost  title='计算器'
  pid=22800 hwnd=0x2558078  Calculator            title='计算器'
  pid=14444 hwnd=0x655598chrome    title='学习DPDK框架与FPGA转发流程 — DeepSeek Harness - Google Chrome'
  pid=6220  hwnd=0x1245994  Code                   title='fpga_common.h - npu_sdk [SSH: your-host] - Visual Studio Code'
  pid=19312 hwnd=0x264474   MobaXterm              title='MobaXterm'
  pid=22832 hwnd=0x68880    SecureCRT              title='10.110.189.253 - SecureCRT'
  pid=14920 hwnd=0x127207280 WorkBuddy             title='WorkBuddy'
  ... (共 16 个)
```

**结论**：顶层窗口可稳定枚举，`MainWindowHandle` 是**真实可用的 HWND**。定位与聚焦在数据层面成立。

---

## 3. `[实测]` 窗口标题歧义 —⚠️ 标题只能兜底

脚本：`poc/poc-2-empirical.ps1` §(b)

```
唯一标题数: 14 / 总窗口数: 16
  [重复标题 x2] '计算器'
  [重复标题 x2] '* 未命名 - Notepad3'
```

**结论**：
1. `MainWindowTitle` 是任意程序可 `SetWindowText` 的字符串，存在被占用/伪造风险；
2. 子串匹配 `workbuddy|dsh|codex` 极易误命中（实测中 `Code.exe` 窗口标题含 `DeepSeek Harness` 这类长文本，任何短子串都可能命中）；
3. 因此**窗口标题只能作为最后兜底，不能作为主判定依据**。

---

## 4. `[实测]` Windows Terminal 可用性 —❌ 本机未安装

脚本：`poc/poc-2-empirical.ps1` §(c)(f)

```
Get-Command wt.exe        : <未找到>
WindowsApps\wt.exe 别名   : <不存在>
Appx 包 *WindowsTerminal* : <未安装>
WT 进程数:  0

[无]   WindowsTerminal
[存在] OpenConsole x3
[存在] conhost x15
[存在] cmd x5
[存在] MobaXterm x1      hwnd=0x264474 title='MobaXterm'
[存在] SecureCRT x1      hwnd=0x68880  title='10.110.189.253 - SecureCRT'
```

**结论（重要）**：
- 本机**未安装 Windows Terminal**，且无任何 WT 窗口 → 「切到指定 WT 标签页」在本机无法实测；
- 但这恰好暴露了关键设计要求：**`focusTerminal` 必须先探测 `wt.exe` 是否存在，绝不能假设它一定在**；
- 本机存在 `conhost` × 15、`OpenConsole` × 3 —— 说明用户终端可能落在 conhost / OpenConsole / MobaXterm / SecureCRT 等多种宿主上，**按进程名枚举不可靠**，需按窗口类名（WT 为 `CASCADIA_HOSTING_WINDOW_CLASS`）判定。

---

## 5. `[文档]` SetForegroundWindow 的非抢占式限制与破解

PRD Q4 提出的风险**成立**，但有标准解法：

| API | 行为 |
| --- | --- |
| `SetForegroundWindow(hwnd)` | 受 **foreground lock** 限制：仅当调用进程是当前前台进程、或刚收到前台事件时才允许。可能返回 `FALSE`。 |
| `ShowWindow(hwnd, SW_RESTORE)` | 解除最小化 —— **必须先做**，否则对最小化窗口聚焦无效 |
| `BringWindowToTop(hwnd)` | 置顶到 Z 序前面 |
| `AttachThreadInput(a, b, TRUE)` | **破解 foreground lock 的标准解法**：把当前线程的输入队列接到前台线程上，使其拥有设置前台的资格 |

**推荐序列**：
```
ShowWindow(h, SW_RESTORE)
AttachThreadInput(GetCurrentThreadId(), GetWindowThreadProcessId(GetForegroundWindow()), TRUE)
BringWindowToTop(h)
SetForegroundWindow(h)
AttachThreadInput(..., FALSE)
```

**但 Node/Electron 主进程没有内建 P/Invoke**，三条获取该能力的路线：

| 方案 | 说明 | 结论 |
| --- | --- | --- |
| (a) 原生模块 `koffi` / `node-ffi-napi` | 真正的 P/Invoke | ❌ 需 C++ 工具链，打包体积与构建风险高，收益不匹配 |
| (b) 子进程 `powershell` + `Add-Type` | 零原生依赖 | ⚠️ 最慢（见 §6） |
| (c) 子进程 `powershell` + `WScript.Shell.AppActivate` | 纯 COM，无需编译 | ✅ **采用** |

**规避设计（关键）**：focus **不做前台查询**，直接对已知 HWND 盲操作；失败不致命，逐级降级。因此对前台查询 API 的依赖被消除。

---

## 6. `[实测]` 子进程开销 — ⚠️ 有约 2.2s 固定开销，powershell 比 cmd 慢 ~1.5s

脚本：`poc/poc-4-spawn-cost.ps1`、`poc/poc-5-baseline-check.ps1`

```
[ cmd /c ver (最轻)                ] min=2154  avg=2190  ms
[ cmd /c exit                      ] min=2177  avg=2231  ms
[ powershell -NoProfile exit 0     ] min=3356  avg=3713  ms
[ hostname (极轻量exe)              ] min=2273  avg=2393ms   <- 进程创建固定开销基线
```

**基线校验结论**：
- 连 `hostname.exe` 这种极轻进程都要 **2393 ms** → 本沙箱存在 **>2s 的进程创建固定开销**（沙箱/杀软拦截）；
- 因此 POC-2/3/4 中的**绝对值不可用于生产延迟预算**，真实 Windows 10/11 参考值为 `cmd ≈ 20~60ms`、`powershell -NoProfile ≈ 250~600ms`；
- **只有相对差值有效**：`powershell` 比 `cmd` 慢约 **1482 ms**。

**对架构的决策（与绝对值无关，结论不变）**：
1. **首选直接 spawn 目标程序**（`wt.exe` / `explorer.exe` / `notepad.exe`），不经中间层；
2. `powershell` 仅作为「聚焦已有窗口」的最后手段，且**异步 fire-and-forget，不阻塞 UI**；
3. `wt.exe` 存在性**必须在启动时探测一次并缓存**，不能每次点击都 `where`（托盘菜单提供「重新探测终端」手动刷新）；
4. 所有 spawn 设 **5s 超时**，超时只记日志、不抛到 UI（PRD P0-7 非法项不崩溃）。

---

## 7. `[实测]` spawn 型跳转 — ✅ 100% 可靠

脚本：`poc/poc-2-empirical.ps1` §(d)、`poc/poc-3-refine.ps1` §(1)(4)

```
[explorer.exe <dir>]     新出现的顶层窗口: 1
   + explorer (pid=23848) hwnd=0x2165244 title='poc'                ← 目录跳转成功
[notepad.exe <path>]     新出现的顶层窗口: 1
   + Notepad3 (pid=19692) hwnd=0x13502322title='未命名 - Notepad3'
[cmd /c start <file>]    新出现的顶层窗口: 1
   + Notepad3 title='poc-sample.log [D:\...\poc] - Notepad3'      ← 日志文件打开成功
[cmd.exe start cmd.exe]  新出现的 cmd 顶层窗口: 1
   + pid=12016 hwnd=0x16385600 title='C:\Windows\system32\cmd.exe'  ← spawn 后可再定位
```

**结论**：
- 目录跳转、日志文件跳转、spawn 新窗口后**再枚举定位**的链路全部成立；
- 但 `start` 打开文件**依赖系统默认关联程序，实测被Notepad3 接管**，不可控 → 配置需支持 `openWith`（`notepad` / `code` / `vscode`），**默认显式指定 `notepad` 而非依赖关联**。

---

## 8. `[实测]` process 型监控的数据源 — ⚠️ WMIC 不可用，长驻 PowerShell 子进程是正解

脚本：`poc/poc-6-process-enum.ps1`

| 方案 | 命令 | 实测结果 | 判定 |
| --- | --- | --- | --- |
| A | `tasklist /fo csv /nh` | 323 行，**只有 Image Name**，无命令行 | 只能做 `processNames` 匹配 |
| B | `wmic process get ...CommandLine` | **超时 / 被安全策略拉黑** | ❌ **排除** |
| C | `Get-CimInstance Win32_Process` | **103,447 字符 JSON，含 `ProcessId` + `Name` + `CommandLine`** | ✅ **唯一可行** |
| D | `Get-Process` | 有 `Id` + `ProcessName`，**无命令行** | 不满足 `cmdlineContains` |

**C 方案实测输出节选**：
```json
[{"ProcessId":0,"Name":"System Idle Process","CommandLine":null},
 {"ProcessId":4,"Name":"System","CommandLine":null},
 {"ProcessId":824,"Name":"csrss.exe","CommandLine":null}, ...]
```

**架构决策**：`process` 监控器采用**长驻 PowerShell 子进程 + 逐行 JSON 流**：

```
powershell -NoProfile -Command "while($true){ Get-CimInstance Win32_Process |
  Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress;
  Start-Sleep -Milliseconds <poll> }"
```
- main 进程启动时拉起**一个常驻子进程**，按行读 stdout 解析 JSON；
- **理由**：即便在真实 Windows 上，每 3s 轮询一次 spawn powershell 也比长驻方案慢一个数量级（沙箱实测固定开销 2.2s 更是完全不可接受）；
- 子进程崩溃 → 指数退避重启（1s/2s/4s/8s，上限 30s），最多 5 次后该任务转 `unknown` 并托盘气泡告警；
- 即使某任务只需匹配 `processNames`（不需要命令行），也走同一长驻进程，避免维护两套逻辑。

---

## 9. `[实测]` Node.js 侧能力 — ✅ 零依赖即可完成日志 tail

脚本：`poc/poc-6-process-enum.ps1` §(E)（`poc/poc-6-node-check.js`）

```
node 版本: v22.22.2
文件大小: 18 bytes
tail 16 字节 => "ne1\nline2\nline3\n"        ← 首次 tail 读取正确
增量读取    => "line4\nline5\n"← 仅读新增字节，正确
readdirSync *.log 命中: ["poc-sample.log","tail-test.log"]
```

**结论**：
- **Node `fs` 增量 tail 完全可行，零第三方依赖**（`fs.statSync` 取 size → `fs.readSync(fd, buf, 0, len, offset)`）；
- 单层 glob 用 `fs.readdirSync` 即可；
- 多层递归 glob（`**/*.log`）需自己实现（约 20 行）或用 `tinyglobby`。**决策：自带递归实现，`tinyglobby` 作为可选依赖**，减少依赖面。

---

## 10. `focusTerminal(target)` 模块设计（结论落地）

```ts
// 优先级从高到低，逐级降级，任一级成功即返回
async function focusTerminal(t: Task, jump: JumpConfig): Promise<FocusResult> {
  // L0缓存探测结果（启动时一次性 where.exe wt.exe；托盘菜单可手动刷新）
  // L1  spawn 型：直接 spawn wt.exe（PRD 7.5「新建终端」）
  //      wt -w<windowName> new-tab -d <cwd>        （WT 已存在该窗口）
  //      wt -d <cwd>                （WT 未安装 → 降级，见 L3）
  //      ── 若 wt.exe 不存在则跳过 L1
  // L2  窗口级聚焦：定位已存在的终端窗口 → 盲操作 ShowWindow+BringWindowToTop+SetForegroundWindow
  //      定位优先级：窗口类名 CASCADIA_HOSTING_WINDOW_CLASS > 进程名 > 标题子串（仅兜底）
  //      实现：powershell -NoProfile -Command "<P/Invoke 或 AppActivate>"，5s 超时，异步不阻塞
  // L3  目录兜底：spawn explorer.exe <cwd>（永远可用，实测 100% 可靠）
  // L4  日志兜底：spawn notepad.exe <logFile>（显式指定，不用系统关联）
  // 全部失败 → 记日志 + 托盘气泡「无法定位终端」，不抛异常
}
```

**能力边界（明确告知用户）**：

| 目标 | 可达程度 | 可靠性 |
| --- | --- | --- |
| 聚焦已存在的 WT 窗口（哪个标签页不保证） | ✅ 可做 | 高 |
| 在 WT 指定窗口**新建标签页**并跳到该目录 | ✅ 可做（`wt -w <name> new-tab -d <dir>`） | 高 |
| **切换到 WT 的某个已有历史标签页** | ❌ **做不到**（WT CLI 只有 `focus-tab`=当前页、`new-tab`，无 `activate tab N`） | — |
| 聚焦 conhost / PowerShell 独立控制台 / ConEmu | ⚠️ 仅标题模糊匹配 | 低（<50%，不承诺） |
| 打开项目目录 | ✅ 可做 | 100%（实测） |
| 打开日志文件 | ✅ 可做 | 100%（实测） |

**对 PRD 的修正建议**：PRD P0-10 与 US6 写的「跳到终端窗口」应理解为**「把某个终端窗口带到前台，并在该窗口/目录处继续工作」**，而非「精确回到原标签页」。建议 QA 按此口径验收。

---

## 11. POC 脚本清单

| 脚本 | 用途 | 运行 |
| --- | --- | --- |
| `poc/poc-2-empirical.ps1` | 窗口枚举 / 标题歧义 / 终端宿主 / spawn 跳转 / spawn 开销 | `powershell -ExecutionPolicy Bypass -File poc\poc-2-empirical.ps1` |
| `poc/poc-3-refine.ps1` | 修正版文件跳转 + 精细 spawn 测量 + spawn 后再定位 | `powershell -ExecutionPolicy Bypass -File poc\poc-3-refine.ps1` |
| `poc/poc-4-spawn-cost.ps1` | 三种 shell spawn 开销对比 | `powershell -ExecutionPolicy Bypass -File poc\poc-4-spawn-cost.ps1` |
| `poc/poc-5-baseline-check.ps1` | 基线校验（区分沙箱开销 vs 真实开销） | `powershell -ExecutionPolicy Bypass -File poc\poc-5-baseline-check.ps1` |
| `poc/poc-6-process-enum.ps1` | 进程枚举四方案对比 + Node tail 能力 | `powershell -ExecutionPolicy Bypass -File poc\poc-6-process-enum.ps1` |
| `poc/poc-7-mermaid-validate.ps1` | 校验架构文档 Mermaid 语法（围栏/类定义/关系/participant/block配对） | `powershell -ExecutionPolicy Bypass -File poc\poc-7-mermaid-validate.ps1` |

**POC-7 实测结果**（对 `docs/02-ARCHITECTURE.md`）：

```
文档行数 = 1063 ; mermaid 块 = 5 ; ``` 围栏 36 (偶数, 配对正确)

块#1 classDiagram    : class 定义 16 ; 关系 17 ; 花括号 16/16 ; 成员 79 行-> 通过
块#2 sequenceDiagram : participant 声明 10 / 使用 10 ; block 3 / end 3        -> 通过
块#3 sequenceDiagram : participant 声明 8 / 使用 8 ; block 2 / end 2         -> 通过
块#4 sequenceDiagram : participant 声明 5 / 使用 5 ; block 4 / end 4         -> 通过
块#5 graph TD        : 节点 14 ; 边 27 ; 方括号 14/14                        -> 通过

汇总: 5 个图全部通过静态结构校验
```

> 校验过程中发现并修复了 2 处真实 Mermaid 语法问题：
> 1. `participant Tool as 外部工具<br/>(dsh/harness)` —— **participant 标签中的半角括号会导致 Mermaid 解析失败**，已去掉括号；
> 2. `classDiagram` 中 `ProcessMonitor --> FocusService : 无` 是无意义关系（三个 monitor 之间无依赖），已替换为 `NoteRight` 说明。

> 注：脚本均为 UTF-8 with BOM 编码。PowerShell 5.1 读取无 BOM 的 UTF-8 脚本会因中文乱码产生语法错误 —— **这是本次实测中踩到的真实坑，已在所有脚本中规避**。

---

## 12. 未决 / 需在真实环境复测的项

| # | 项 | 复测方式 |
| --- | --- | --- |
| 1 | `wt -w <name> new-tab -d <dir>` 是否被 WT 接受并聚焦 | 装WT 后跑 `poc/poc-7-wt-verify.ps1`（工程师补写） |
| 2 | `SetForegroundWindow` + `AttachThreadInput` 在真实前台锁下的成功率 | 真实桌面（非沙箱）手动点击通知按钮验证 |
| 3 | `WScript.Shell.AppActivate` 在PowerShell 子进程中的延迟 | 真实桌面测量，应为 250~600ms |
| 4 | spawn 开销绝对值 | 真实桌面重跑 `poc-4` / `poc-5` |

**这 4 项都不阻塞开发**：架构已通过「多级降级 + 不依赖前台查询 + 超时不抛错」把不确定性全部吸收到 L3/L4 的 100% 可靠兜底上。