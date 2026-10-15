# 新增：切换而非新增页面（round 19）

> 你报的问题：「虽然点击有效 但是不是跳转页面 而是新增页面」
> 日期：2026-10-14 · 结论：**545 测试全绿，全部实测链通过，切换机制已在真实应用验证**

---

## 一、问题本质

round 18 加的 `openUrl` 用 `rundll32 url.dll,FileProtocolHandler <url>` 打开网址。
这个动作**语义上就是"打开"** —— 于是每点一次就多一个标签页，
点几次浏览器里就堆一排相同的 dsh 页面。

你要的是**「跳到那个已经开着的页面」**。

---

## 二、实现：新增 `jump.openUrlTitleMatch`

```yaml
    jump:
      openUrl: http://127.0.0.1:3080
      openUrlTitleMatch: <dsh 页面标题里的片段>   # ★ 有它才会"切换"而不是"新增"
      cwd: D:/your-project
```

### 语义（这点很关键，我一开始写反了）

> **URL 总是要打开的**；`openUrlTitleMatch` 只是让我们在"它已经开着"时
> **不重复开**，改为把那个窗口切到前台。

我第一版写成"先按标题找，找不到就不开" —— 那是错的：
若目标页没开，我们**必须**开它，否则点击等于没有效果。
所以正确顺序是：

```
① 按 openUrlTitleMatch 找已开着的窗口
   ├─ 找到 -> 切前台，**不新开**  ← 你要的行为
   └─ 没找到 -> 用 openUrl 新开
```

### 为什么按窗口标题能匹配到

Chrome / Edge 的窗口标题格式是 `<页面标题> - Google Chrome`，
所以**页面标题的子串**就能匹配上那个窗口。

---

## 三、★ 又一个"非终端窗口被过滤"的坑

`toTerminalWindow()` 有个 `looksTerminal` 过滤（round 15 踩过同样的坑，
当时是 WorkBuddy 被丢掉）。Chrome 窗口**不含任何"终端"特征**，
不放行就永远匹配不到 —— 于是每次都退化成"新开标签页"，
**功能看起来完全没生效**。

修法同 round 15：把**配置里显式声明的匹配片段**一并放行。
`acceptedTitlePatterns()` 现在收集两个来源：

| 来源 | 用途 |
|---|---|
| `jump.terminal.match` | 桌面程序（WorkBuddy） |
| `jump.openUrlTitleMatch` | 已打开的网页（dsh） |

> 这已经是**第二次**因为这条白名单丢掉窗口了。
> 规律：**每引入一类"非终端"的跳转目标，都要记得同步放行**。

---

## 四、★ 实测（用一个必然命中的模式验证整条路径）

我临时把 `openUrlTitleMatch` 配成 `Google Chrome`（必然命中），
点 dsh-3080，日志：

```
聚焦请求：任务 dsh-3080
页面已开着，切到前台「Initial hello to coding assistant — DeepSeek Harness - Google Chrome」
  （任务 dsh-3080，未新开标签页）
已通过 AppActivate(pid=15932) 激活窗口
```

**关键：没有出现 `已打开 http://...`，也没有 spawn rundll32** ——
确认走的是"切换"而不是"新增"。验证完已把配置还原。

### 顺带修掉一个我自己引入的延迟

第一版在判断前**无条件**调用 `refreshWindows()` —— 那要 spawn 一次 PowerShell
（编译内联 C#，实测 1~3 秒），于是**每次点击都卡几秒**。

改成两级：

```
① 先用已有快照匹配（命中就直接切，零开销）   ← 常态走这条
② 只有快照没命中才刷新一次                   ← 快照可能过时
```

从上面的日志时间戳能看到：`17:08:26.781` 收到请求 → `.793` 就判定完毕，
**12 毫秒**，完全没有卡顿。

---

## 五、待你提供一样东西

我拿不到 dsh 页面的真实标题 —— 已开的那个标签是**后台标签**，
而 Chrome 的窗口标题**只反映当前激活的标签页**
（我枚举了所有顶层窗口，没有一个含 dsh），
直接抓页面也被 **401（需要认证）** 挡住了。

所以 `openUrlTitleMatch` 需要你帮我填一次：

1. 切到浏览器里那个 dsh 标签页
2. 看标签上显示什么标题
3. 把里面**稳定、独有**的一段告诉我（例如 `dsh` / `DSH 控制台`）

两个端口要不同的片段（3080 和 13080 的页面标题必须能区分开）。

> 在那之前，当前配置只有 `openUrl`，行为是**每次新开**（round 18 的行为）。
> 这不是坏了，只是还没启用"切换"。

---

## 六、验证

| 关卡 | 结果 |
|---|---|
| `tsc` × 3 份配置 | **全部 exit 0** |
| `vitest run` | **545 passed**（540 → 545，+5） |
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

## 七、复现

```powershell
cd D:\Projects\lamp\ai-task-indicator

node node_modules/typescript/bin/tsc -p tsconfig.json
node scripts/start.mjs -- --config ./config.dsh.example.yaml --remote-debugging-port=9222

# 点某一行，看日志里是哪一条：
#   已切到已打开的页面「…」        <- 切换（不新增）
#   已打开 http://…                <- 新增
node scripts/probe-row-jump.mjs dsh-3080
```

### 附：`probe-row-jump.mjs` 与 `verify-ack-click.mjs` 的分工

| 脚本 | 验什么 | 能重复跑吗 |
|---|---|---|
| `verify-ack-click.mjs` | 完成提醒的**确认水位** | ❌ 需那一行是绿灯，且跑一次后水位记下 → 要重启应用 |
| `probe-row-jump.mjs` | 点击**跳转**（任何状态） | ✅ 可重复跑 |

排查"跳错/没跳/重复开页面"用后者更顺手。
