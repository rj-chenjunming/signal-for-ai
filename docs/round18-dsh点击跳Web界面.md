# 新增：点击跳转到 dsh 的 Web 界面（round 18）

> 你报的问题：「workbuddy 可以点击切换了 dsh端口好像不行」
> 日期：2026-10-14 · 结论：**540 测试全绿，全部实测链通过，两个 dsh 端口点击都实测打通**

---

## 一、根因：`JumpConfig` 根本没有「打开 URL」这个能力

探针实测，点击 dsh-3080 那一行的日志只有：

```
L1 跳过：wt.exe 不存在（POC 实测本机未安装 WT）
（然后走 L3 打开目录 D:/your-project）
```

**没有报错，但也没跳到 dsh 界面** —— 因为这两个任务的 `jump` 只配了：

```yaml
jump:
  cwd: D:/your-project
```

而 `cwd` 的降级兜底是 `explorer.exe <cwd>` —— **弹资源管理器**。
dsh 是 Web 服务，「界面」是 `http://127.0.0.1:3080`，
所以配 `cwd` 从原理上就到不了。

**能配的只有三种**：`terminal`（聚焦窗口 / spawn 命令）、`cwd`（开目录）、
`logFile`（开日志）。**没有一个能表达"打开这个网址"。**

> 顺带说明：这也解释了为什么 workbuddy 能跳 —— 它是**桌面程序**，
> 有窗口可聚焦（`terminal.type: windowTitle`）。dsh 没有窗口。

---

## 二、实现：新增 `jump.openUrl`

```yaml
  - id: dsh-3080
    jump:
      openUrl: http://127.0.0.1:3080   # ★ 点击直接开 dsh 的 Web UI
      cwd: D:/your-project              # 仍保留作兜底

  - id: dsh-13080
    jump:
      openUrl: http://127.0.0.1:13080  # 隧道端口也有自己的 Web UI
      cwd: D:/your-project
```

### 优先级排在最前（新的一级 L0）

```
L0  openUrl          ← 新增：显式网址，最明确的意图
L1  spawn 型终端 / wt.exe
L2  窗口标题聚焦
L3  目录兜底
```

配了网址就是用户直接说了"我要去这个地址"，没有任何理由再去试窗口聚焦或开目录。

### 用 `rundll32 url.dll,FileProtocolHandler` 而不是 `explorer.exe <url>`

两者都能开 URL，但前者是 Windows 上更稳定的做法。更重要的是
**URL 作为独立 argv 元素传入、不过 shell** —— 所以不存在引号/命令注入问题。
有专门测试验证 URL 里带 `&` 和引号时依然原样传递。

---

## 三、★ 安全：协议必须白名单

这个值最终会交给系统去"打开"。若不限协议，配置就能写成：

```yaml
openUrl: file:///C:/Windows/System32/calc.exe   # 打开任意本地可执行文件
openUrl: ms-settings:                            # 触发任意协议处理程序
```

**任务配置不是可信输入**（可能来自别人分享的示例文件），
所以只接受 `http:` / `https:`，其余一律丢弃并告警。

### 一个我写错的断言（值得记）

我原本把 `http:/broken` 也列为"应拒绝"。实测：

```js
new URL('http:/broken')   // → 成功！protocol 是 'http:'
```

WHATWG 规范把单斜杠当路径分隔**容错**，规范化为 `http://broken/`。
所以它是一个**合法的 http URL**，接受它是对的。

我把断言改成了记录这个事实，而**没有改代码去迎合错断言** ——
那是把 bug 固化进预期行为。

### 顺带修掉一个噪声

空字符串原本会告警。但 YAML 里留个空 key 很常见（把内容注释掉但保留 key），
为它刷警告只会让"警告"这个信号变廉价。改成和其它字段一样**静默跳过**。

---

## 四、★ 顺带解决「点击跳错行」的疑虑

之前我在日志里看到一条可疑记录：点 dsh 行却触发了
`已通过 Win32 激活窗口「WorkBuddy」`。当时无法判断是
点击带错了 taskId，还是更早的遗留日志。

**新增一行明确的日志把它钉死了**（`index.ts` 的 `focus_terminal` 分支）：

```
聚焦请求：任务 dsh-3080
已打开 http://127.0.0.1:3080（任务 dsh-3080）
```

实测三个行各自带了**正确**的 taskId：

| 点击 | 日志 |
|---|---|
| dsh-3080 | `聚焦请求：任务 dsh-3080` → `已打开 http://127.0.0.1:3080（任务 dsh-3080）` |
| dsh-13080 | `聚焦请求：任务 dsh-13080` → `已打开 http://127.0.0.1:13080（任务 dsh-13080）` |
| workbuddy | 走 Win32 窗口激活（桌面程序，无 URL） |

那条 WorkBuddy 记录是**更早的遗留**，点击本身没问题。

> 这行日志的价值：下次再出"点了没反应/点错"的问题，
> **第一手证据就在日志第一行**，不用靠猜。

---

## 五、验证

| 关卡 | 结果 |
|---|---|
| `tsc` × 3 份配置 | **全部 exit 0** |
| `vitest run` | **540 passed**（525 → 540，+15） |
| `test/config-jump-url.test.ts`（新增） | **11 项**（含 5 类危险协议拒绝） |
| `test/focus.test.ts` | **19 项**（+4 项 L0 优先级/降级/防注入） |
| `scripts/check-dsh-config.mjs` | **0 警告**（+3 项 openUrl 断言） |
| `scripts/sqlite-monitor-check.mjs` | **16/16** |
| `scripts/d2-arbitration-check.mjs` | **10/10** |
| `scripts/d5-tunnel-check.mjs` | **7/7（exit 0）** |
| `scripts/live-dsh-check.mjs` | **打通** |
| `scripts/verify-strip-visual.mjs` | **17/17** |
| `scripts/inspect-live-lamp.mjs` | **全部正确** |
| `scripts/smoke-e2e.js` | **全部通过** |

---

## 六、复现

```powershell
cd D:\Projects\lamp\ai-task-indicator

node node_modules/typescript/bin/tsc -p tsconfig.json
node scripts/start.mjs -- --config ./config.dsh.example.yaml --remote-debugging-port=9222

# 点 dsh 那一行，然后看日志里应有：
#   聚焦请求：任务 dsh-3080
#   已打开 http://127.0.0.1:3080（任务 dsh-3080）
```

---

## 七、三类任务现在各自的点击行为

| 任务类型 | 点击行为 | 靠什么 |
|---|---|---|
| **dsh 端口** | 浏览器打开它的 Web UI | `jump.openUrl` |
| **WorkBuddy** | 把 WorkBuddy 窗口切到前台 | `jump.terminal.type: windowTitle` |
| 终端类任务 | 聚焦终端窗口 / 新建 WT 标签页 | `terminal` 或 `cwd` |

### 一个可以顺手加的改进（未做）

dsh 的 Web UI 支持深链接到具体会话吗？如果支持（形如
`http://127.0.0.1:3080/#/session/<id>`），就能做到**点击直接跳到出事的那个会话**
—— 那比只开首页有用得多。这次没做，因为不确定 dsh 的路由格式。
若你知道，告诉我可以接上。
