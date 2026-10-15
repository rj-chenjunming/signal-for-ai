# 切到已有窗口 + 一个必须说清的边界（round 20）

> 你报的问题：「虽然点击有效 但是不是跳转页面 而是新增页面」
> 你补充的信息：两个 dsh 页面标题分别叫
> `Initial hello to coding...` 和 `参考STA表新增...`
> 日期：2026-10-14 · 结论：**545 测试全绿，"切到已有窗口"已在真实应用验证**

---

## 一、你的补充信息很关键 —— 那是**会话标题**，不能用来匹配

你给的两个标题是**会话标题**（每次对话都不同），不是稳定的页面标题。
所以 `openUrlTitleMatch` **不能填会话标题** —— 那样换个会话就匹配不到了。

我改用**稳定出现在每个 dsh 页面标题里的品牌名**，并在真实应用里验证了整条路径。

---

## 二、侦察：其实只有 1 个 Chrome 窗口

我枚举了 Chrome 进程的**全部顶层窗口**（`Get-Process | Select MainWindowTitle`
只给一个标题，会漏）：

```
[pid 15932] Chrome_WidgetWin_1 | Initial hello to coding assistant — DeepSeek Harness - Google Chrome
```

**只有一个 Chrome 窗口**，你看到的另一个 dsh 页面是**同一个窗口里的后台标签**。

原因是 Chrome 的 `MainWindowTitle` **只反映当前激活的标签** ——
这既是"读不到 13080 标签标题"的原因，也是下面那个边界的原因。

---

## 三、实测：切换确实生效了

临时把 `openUrlTitleMatch` 配成 `DeepSeek Harness` 后点 dsh-3080：

```
聚焦请求：任务 dsh-3080
页面已开着，切到前台「Initial hello to coding assistant — DeepSeek Harness - Google Chrome」
  （任务 dsh-3080，未新开标签页）
已通过 AppActivate(pid=15932) 激活窗口
```

**关键证据：日志里没有 `已打开 http://…`，也没有 spawn `rundll32`** ——
确认走的是"切换"路径，**没有新增标签页**。

> 中途我一度以为失败（没看到日志），原因是**我自己把输出截断了**
> （`Select-Object -First 4`）。重跑完整输出就看到了。教训：排查时别截断证据。

---

## 四、★ 必须说清的边界：能切到**窗口**，不能切到**标签**

Chrome 的窗口标题**只反映当前激活的标签**。所以：

| 场景 | 结果 |
|---|---|
| Chrome 窗口里激活的正好是 dsh 标签 | ✅ 切到窗口 = 看到 dsh |
| Chrome 窗口里激活的是**别的**标签 | ⚠️ 窗口到前台了，但停在那个标签上 |

**这不是实现缺陷，是 Chrome 窗口标题机制的限制** ——
要精确切到某个标签，只有两条路，都需要额外代价：

| 方案 | 代价 |
|---|---|
| Chrome 开 `--remote-debugging-port` + CDP `Target.activateTarget` | 需**重启 Chrome** 带参数；且开放本地调试端口（任何本地进程可控制浏览器） |
| 写一个 Chrome 扩展用 `chrome.tabs.update` | 要装扩展、维护清单 |

两者都超出"一个指示灯挂件"的合理范围，所以本轮**没做**，
而是把边界写进配置注释，避免你以为它能切标签。

---

## 五、当前配置

```yaml
  - id: dsh-3080
    jump:
      cwd: D:/your-project
      openUrl: http://127.0.0.1:3080
      openUrlTitleMatch: DeepSeek Harness   # ★ 切到已有窗口，不新开
```

`dsh-13080` 暂时**没配** titleMatch —— 因为它的标签是后台标签，
我读不到它的标题（而且它和 3080 在同一个 Chrome 窗口里，
就算配上 `DeepSeek Harness` 也只是切到同一个窗口）。
它现在仍是"点击新开"的行为。

---

## 六、两个相关改动（本轮之前就做了）

### 6.1 「非终端窗口被过滤」—— 第二次踩同一个坑

`toTerminalWindow` 的 `looksTerminal` 过滤会把 Chrome 窗口丢掉
（它不含任何"终端"特征）→ titleMatch 永远匹配不到 → 退化成"每次新开"，
**功能看起来完全没生效**。

修法同 round 15（WorkBuddy 被丢）：把配置里显式声明的片段一并放行。
`acceptedTitlePatterns()` 现在收集两个来源：

| 来源 | 用途 |
|---|---|
| `jump.terminal.match` | 桌面程序（WorkBuddy） |
| `jump.openUrlTitleMatch` | 已打开的网页（dsh） |

**规律：每引入一类"非终端"跳转目标，都要记得同步放行。**

### 6.2 我自己引入的点击延迟

第一版在判断前**无条件** `refreshWindows()` —— spawn PowerShell 并编译内联 C#
（实测 1~3 秒），每次点击都卡。改成两级：

```
① 先用已有快照匹配（命中就直接切，零开销）   ← 常态
② 只有未命中才刷新一次                       ← 快照可能过时
```

实测时间戳：收到请求 `17:15:51.507` → 判定完毕 `.520`，**13 毫秒**。

---

## 七、验证

| 关卡 | 结果 |
|---|---|
| `tsc` × 3 份配置 | **全部 exit 0** |
| `vitest run` | **545 passed** |
| `test/focus.test.ts` | **24 项**（+5 项 titleMatch：命中/未命中/未配置/刷新/非终端窗口） |
| `test/config-jump-url.test.ts` | **11 项** |
| `scripts/sqlite-monitor-check.mjs` | **16/16** |
| `scripts/d2-arbitration-check.mjs` | **10/10** |
| `scripts/d5-tunnel-check.mjs` | **7/7（exit 0）** |
| `scripts/live-dsh-check.mjs` | **打通** |
| `scripts/verify-strip-visual.mjs` | **17/17** |
| `scripts/smoke-e2e.js` | **全部通过** |
| `scripts/check-dsh-config.mjs` | **0 警告** |

---

## 八、复现

```powershell
cd D:\Projects\lamp\ai-task-indicator

node node_modules/typescript/bin/tsc -p tsconfig.json
node scripts/start.mjs -- --config ./config.dsh.example.yaml --remote-debugging-port=9222

# 点 dsh-3080，看日志是哪一条：
#   已切到已打开的页面「…」   <- 切换（不新增）  ✅ 当前行为
#   已打开 http://…            <- 新增
node scripts/probe-row-jump.mjs dsh-3080
```

### 排查跳转问题用哪个脚本

| 脚本 | 验什么 | 能重复跑 |
|---|---|---|
| `verify-ack-click.mjs` | 完成提醒的**确认水位** | ❌ 跑一次后水位记下，要重启应用 |
| `probe-row-jump.mjs` | 点击**跳转**（任何状态） | ✅ 可重复 |
