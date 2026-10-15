# 用 dsh 本地客户端解决切换问题（round 22）

> 你的信息：「我现在本地运行了三个ai工具 dsh（本地客户端）workbuddy dsh（web 13083）」
> 日期：2026-10-14 · 结论：**556 测试全绿，全部实测链通过，三个点击逐一实测正确**

---

## 一、回答你最初那个问题：**会好得多，而且你已经在跑了**

> 你问过：「如果我在本地用 dsh 客户端打开会好切换吗」

**会。** 而且我找到了它 —— 你的"dsh 本地客户端"是：

```
pid 22980  DeepSeek Harness.exe   窗口标题 = "Initial hello to coding assistant — DeepSeek Harness"
```

这是个 **Electron 桌面应用**（`DeepSeekHarnessLauncher`），**有真实窗口**，
和 WorkBuddy 同类 —— 不受"浏览器窗口标题只反映激活标签"的限制。

实测（从"锐捷云桌面"手里抢焦点）：

```
焦点被抢到「飞书」  →  点 dsh 那一行  →  前台 = 'Initial hello to coding assistant — DeepSeek Harness'
                                        proc = DeepSeek Harness    ✅
```

---

## 二、★ 之前一直切错窗口的真正原因

本机**同时**存在两个标题几乎一样的窗口：

| 进程 | 窗口标题 |
|---|---|
| `DeepSeek Harness.exe` | `… — DeepSeek Harness` ← **原生客户端** |
| `chrome` | `… — DeepSeek Harness - Google Chrome` ← 浏览器里的 dsh |

我上一轮配的 `openUrlTitleMatch: DeepSeek Harness` **两边都命中**，
而代码返回枚举到的第一个 —— **恰好是 Chrome**。所以每次点击都切到浏览器，
而你真正想要的原生窗口从来没被选中过。

### 修法：新增 `processNames` 过滤

```yaml
    jump:
      terminal:
        type: windowTitle
        match: DeepSeek Harness
        processNames:
          - DeepSeek Harness        # ★ 只匹配原生窗口，排除 Chrome
```

进程名比较**容忍 `.exe` 后缀与大小写**（枚举给的是不带 `.exe` 的 `ProcessName`）。

---

## 三、★ 顺带挖出一个"乱抢窗口"的严重 bug

配好 `processNames` 后测 workbuddy，日志暴露了：

```
聚焦请求：任务 workbuddy
L2 未找到标题匹配「WorkBuddy」的窗口
已通过 Win32 激活窗口「… - Google Chrome」        ← 切到了 Chrome！
```

**原因**：WorkBuddy 窗口当时**缩在托盘、不可见**，标题匹配失败后落到了
`L2-b：盲聚焦第一个候选窗口` —— 于是它**随便抢了一个窗口**。

这比"什么都不做"糟糕得多：**夺走你当前的焦点，还给出错误暗示**
（你以为跳成功了，其实到了一个完全无关的窗口）。

**修法**：只在**没有**指定窗口标题时才允许盲聚焦。
显式指定了标题却没找到 → 老实降级到"打开目录/日志"（至少和任务相关）。

修完复测：

| 点击 | 前台结果 |
|---|---|
| `本地客户端` | `DeepSeek Harness` ✅ |
| `workbuddy` | 仍是 `飞书` ✅ **没有乱抢**（窗口在托盘，找不到就老实不动）|
| `web 13080` | `… - Google Chrome` ✅ |

---

## 四、顺带修的另外两个问题

### 4.1 `windowTitle` 只查启动时的窗口快照

如果你**先开灯、后开 dsh 客户端**，快照里没有那个窗口 → 每次点击都找不到、
一路降级。现在未命中会**刷新一次**再试。快路径（窗口已在快照里）不受影响。

### 4.2 灯带标签是端口号，对人不直观

dsh 行原先显示 `19387` / `13080`。新增可选 `shortLabel`：

```yaml
  - id: dsh-local
    shortLabel: 本地客户端      # 不配则退回端口号
  - id: dsh-web
    shortLabel: web 13080
```

灯带现在是可读的：**`本地客户端` / `workbuddy` / `web 13080`**。

---

## 五、★ 修掉两条"因端口变化而失效"的实测链

`d2-arbitration-check` 与 `live-dsh-check` 都把 authority **写死**成
`127.0.0.1:3080`，而本机 dsh 已经从 3080 挪到了 **19387**：

```
❌ D2: 基线 failed -> 推入后 failed
❌ live: 轮询失败（transport/unreachable）：fetch failed
```

**代码没坏，是脚本在敲一个不开的门。** 这种假警报既浪费时间、又会掩盖真回归。

修法：新增 `scripts/lib/live-dsh.mjs`，**从真实配置里读 dsh 任务并逐个探测**，
取第一个能通的（只探测本机实例，远端/隧道要 SSH 太慢）：

```
（自动发现活跃 dsh：127.0.0.1:19387，17 会话）
✅ D2 全链路打通（10 项）
✅ 真实 dsh 端到端打通
```

找不到时**退出码 2**（前置不满足），与"验证失败（1）"区分。

---

## 六、你的三个工具现在的映射

| 灯带行 | 工具 | 监控 | 点击 |
|---|---|---|---|
| **本地客户端** | dsh 桌面客户端 | `127.0.0.1:19387`（本机密钥直连，实测 17 会话）| 聚焦原生窗口 ✅ |
| **web 13080** | dsh web（远端，经 ssh 隧道）| `127.0.0.1:13080` + `sshHost`（本机密钥会 401）| 浏览器打开 |
| **workbuddy** | WorkBuddy | `workbuddy.db` 的 `sessions` 表 | 聚焦原生窗口 ✅ |

> 「13083」确认为笔误，按 **13080** 配（隧道由 dsh 桌面客户端自己建立：
> `-L 127.0.0.1:13080:127.0.0.1:3080 user@your-host`）。

### 仍存在的限制

`web 13080` 那一行走**浏览器**，所以只能"切到 Chrome 窗口"，
不能保证切到窗口里的某个标签 —— 这是 Chrome 的限制。
但你的另外两个工具都是**原生窗口**，切换完全可靠。

---

## 七、验证

| 关卡 | 结果 |
|---|---|
| `tsc` × 3 份配置 | **全部 exit 0** |
| `vitest run` | **556 passed**（545 → 556，+11） |
| `test/focus.test.ts` | **31 项**（+7：processNames 过滤 5 项、盲抢防护 2 项）|
| `test/store-strip.test.ts` | **15 项**（+4：shortLabel）|
| `scripts/check-dsh-config.mjs` | **0 警告**（+4 项新断言）|
| `scripts/sqlite-monitor-check.mjs` | **16/16** |
| `scripts/d2-arbitration-check.mjs` | **10/10（已改为自动发现）** |
| `scripts/live-dsh-check.mjs` | **打通（已改为自动发现）** |
| `scripts/d5-tunnel-check.mjs` | **7/7（exit 0）** |
| `scripts/verify-strip-visual.mjs` | **17/17** |
| `scripts/inspect-live-lamp.mjs` | **全部正确** |
| `scripts/smoke-e2e.js` | **全部通过** |

---

## 八、复现 / 排查工具

```powershell
cd D:\Projects\lamp\ai-task-indicator

node node_modules/typescript/bin/tsc -p tsconfig.json
node scripts/start.mjs -- --config ./config.dsh.example.yaml --remote-debugging-port=9222

# 点某一行（任何状态都能跑、可重复）
node scripts/probe-row-jump.mjs dsh-local

# 窗口与前台排查（本轮两次关键定位都靠它们）
powershell -File scripts/diag-windows.ps1              # 列出所有窗口 + 进程名 + 前台
powershell -File scripts/diag-fg.ps1 -StealTo '飞书'    # 把焦点抢到别处（制造切换场景）
powershell -File scripts/diag-fg.ps1 -CheckOnly        # 只看当前前台
```

**保留的诊断脚本**（本轮新加，实测有效）：

| 脚本 | 用途 |
|---|---|
| `diag-windows.ps1` | 列出所有可见窗口 + 所属进程 + 哪个是前台 |
| `diag-fg.ps1` | 抢占/查询前台，用于验证"能不能真的切过去" |
| `scripts/lib/live-dsh.mjs` | 自动发现活跃 dsh（供实测链复用）|
