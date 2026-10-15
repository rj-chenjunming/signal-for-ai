# 完成提醒闭环：亮到点击 + 点击跳转 + 熄灭（round 15）

> 你要的形态：「执行完 亮绿灯保持不动 然后可以点击 点击完后进行跳转
> 跳转到相应的界面 同时熄灭绿灯」
> 日期：2026-10-14 · 结论：**525 测试全绿，五条实测链全通，
> 点击闭环在真实应用里 4/4 通过并抓到 3 个真 bug**

---

## 一、最终形态

| 情形 | 灯 | 点击后 |
|---|---|---|
| 有任务在跑 | 蓝 | 跳到该任务界面 |
| **任务刚完成** | **绿（一直亮到点击）** | **跳转 + 熄灭，且不会自己复亮** |
| 进程在但没事干 | 灰 | 跳到该任务界面 |
| 进程不在 | 隐藏 | — |

---

## 二、核心难点：「点掉之后立刻复亮」

这是整个功能成败所在。sqlite 型是**轮询**的（默认 5 秒一轮）：
点掉之后下一轮又会从数据库读到"有会话完成了"，于是绿灯**立刻复亮**，
点击等于没点。

### 解法：把"完成"建模成**单调水位**

```
监控每轮上报 lastDoneAt（非 working 会话里最大的 updated_at）
store 记住用户点掉时的水位 ackedCompletionAt
→ 只有 lastDoneAt > ackedCompletionAt 才算「新完成」，才亮绿灯
```

- 同一个完成事件 → 只提醒一次
- **新任务完成（水位变大）→ 再次点亮**

水位是**稳定的事实**，所以"该不该亮"由 store 的确认水位决定，
而不是让时间窗口把还等着你点击的信号冲掉（这正是上一版的问题）。

### 一个关键的顺序要求

`markRead()` 必须在把状态打回 `idle` **之前**记下水位。
顺序反了的话，监控下一轮读到同一个完成、水位却没更新 → 绿灯复亮。
有专门测试锁死这一点。

---

## 三、★ 实测抓到 3 个真 bug

我用 `scripts/verify-ack-click.mjs` 在真实应用里派发点击并跨轮观察 ——
第一轮就报 **2 项失败**，挖出三个问题：

### bug 1：`windowTitle` 跳转对非终端窗口**永远不可能成功**

```
L2 未找到标题匹配「WorkBuddy」的窗口
已枚举 0 个候选终端窗口     ← ★ 根因
```

`toTerminalWindow()` 有个 `looksTerminal` 过滤，只保留
WindowsTerminal / conhost / MobaXterm 这类进程：

```ts
// 只保留「像终端」的窗口；其余（Chrome/VSCode 等）不作为 L2 候选
const looksTerminal = isWindowsTerminal || TERMINAL_PROCESS_NAMES.some(...)
```

但 WorkBuddy 窗口**明明被枚举到了**（实测
`Id=15860 Title='WorkBuddy' Handle=722520`），只是被这个过滤器丢掉。

修法：把**配置里显式声明的 `windowTitle`** 一并放行 ——
你既然在配置里写了标题，就是明确要求按标题找，这条白名单不该拦它。
（`FocusService` 新增 `tasks` 回调以读取配置，保证热重载后立即生效。）

### bug 2：跳转失败时绿灯**永远不熄**

我最初把两件事串起来写："等 focus 成功后再 mark_read"：

```ts
void api.sendTaskAction({taskId, action:'focus_terminal'})
  .then(() => api.sendTaskAction({taskId, action:'mark_read'}))
```

跳转一旦失败（窗口标题变了 / 没配 jump / 非终端窗口…），
`mark_read` 就**根本不发出去**，绿灯一直绿。

修法：两条动作**各自独立发出**。"点击"这个动作本身必须总能让提醒消失，
不管跳转成没成功。

### bug 3：`wasDone` 被捕获成首帧的值（**我自己的 bug**）

```ts
// 错的：行节点会被 stripRowCache 复用，这个闭包只在**首次创建**时求值
const wasDone = task.status === 'success' || task.status === 'failed';
```

workbuddy 那一行第一次出现时是 `idle`，于是 `wasDone` **永远是 false** ——
无论怎么点都不会发 `mark_read`。

修法：在**点击那一刻**从 DOM 读 `row.dataset['status']`
（`renderStripMode` 每轮都会同步它，所以总是最新值）。

> 这个 bug 纯靠实测抓出来：逻辑读起来完全合理，类型检查也毫无问题。

---

## 四、★ 顺带修好：窗口根本激活不了

修完 bug 1 后，窗口**找到了**，但报 `AppActivate 未生效`。
我逐条实测激活方式，拿到决定性结论：

```
WorkBuddy: hwnd=722520   最小化? True      ← ★ 窗口是最小化的
AppActivate('WorkBuddy') 返回: False       ← 方法 A 失败
AppActivate(15860)       返回: False       ← 方法 B 也失败
ShowWindow(SW_RESTORE)+BringWindowToTop+SetForegroundWindow 返回: True
  → 前台 = 'WorkBuddy'                      ← ★ 成功了
```

**`WScript.Shell.AppActivate` 无法恢复最小化的窗口。** 而 `focus.ts`
原本只走这条路。

另外还撞上 Windows 的**前台锁**：后台进程直接 `SetForegroundWindow`
会返回 False（实测前台仍停在别的窗口）。用 `AttachThreadInput`
把本线程挂到当前前台线程上，这次切换就被视作"前台线程自己发起的"，从而被允许。

改后的降级链（`focusExistingWindow`）：

1. **Win32**（主）：`ShowWindow(SW_RESTORE)` → `AttachThreadInput` →
   `BringWindowToTop` → `SetForegroundWindow`
2. **AppActivate**（兜底）：不依赖 `Add-Type`，供内联编译被安全策略拦的环境

⚠️ 判定依据用 **`GetForegroundWindow()` 的真实结果**，不是
`SetForegroundWindow` 的返回值 —— 后者在前台锁场景下会返回 False，
但窗口其实已经到前台了，用它当判据会**误报失败**。

> POC §1 记过"沙箱里 Add-Type 被禁"。实测在 Electron 主进程 spawn 的
> PowerShell 里**可用**（`setOk=True`），所以主方案可用，兜底仍保留。

---

## 五、实测证据

```
=== 点击前 ===
workbuddy  状态=success  bg=rgb(34,197,94)
  悬停：WorkBuddy · 已完成 · 任务已完成，点击查看

=== 派发 click ===
✅ 渲染层能拿到 sendTaskAction（preload 白名单正常）

=== 点击后 ===
workbuddy  状态=idle  bg=rgb(107,114,128)     ← 熄灭
日志：已通过 Win32 激活窗口「WorkBuddy」        ← 跳转成功

=== 等 16 秒（跨过 3 轮轮询）===
workbuddy  状态=idle  bg=rgb(107,114,128)     ← ★ 没有复亮
```

`verify-ack-click.mjs`：**4/4 通过**。

---

## 六、质量关卡

| 关卡 | 结果 |
|---|---|
| `tsc` × 3 份配置 | **全部 exit 0** |
| `vitest run` | **525 passed**（512 → 525，+13） |
| `scripts/verify-ack-click.mjs`（新增） | **4/4** |
| `scripts/sqlite-monitor-check.mjs` | **16/16** |
| `scripts/d2-arbitration-check.mjs` | **10/10** |
| `scripts/d5-tunnel-check.mjs` | **7/7（exit 0）** |
| `scripts/live-dsh-check.mjs` | **打通** |
| `scripts/verify-strip-visual.mjs` | **17/17** |
| `scripts/smoke-e2e.js` | **全部通过** |
| `scripts/check-dsh-config.mjs` | **0 警告** |

启动日志无「非法状态转移被拒绝」。

### 顺带保留的一个好测试

`verify-ack-click.mjs` 留在仓库里 —— 它是唯一能发现
「逻辑读起来对、但实际点不动」这类问题的东西。**bug 3 就是它抓的。**

---

## 七、复现

```powershell
cd D:\Projects\lamp\ai-task-indicator

node node_modules/typescript/bin/tsc -p tsconfig.json          --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.test.json     --noEmit
node node_modules/vitest/vitest.mjs run

# 只跑本轮新增
node node_modules/vitest/vitest.mjs run test/store-ack-completion.test.ts

node node_modules/typescript/bin/tsc -p tsconfig.json
node scripts/sqlite-monitor-check.mjs

# ★ 点击闭环（需应用带调试端口启动）
node scripts/start.mjs -- --config ./config.dsh.example.yaml --remote-debugging-port=9222
node scripts/verify-ack-click.mjs workbuddy
```

---

## 八、配置

```yaml
  - id: workbuddy
    monitor:
      type: sqlite
      database: D:/your-appdata/.workbuddy/workbuddy.db
      activeStatus: working
      activeWithinMs: 120000     # 多久内有活动才算"在跑"
      notifyOnDone: true         # 完成提醒开关（绿灯时长不再由时间决定）
      requireProcess: [...]      # 进程闸门（不在就隐藏）
    jump:
      cwd: D:/workbuddy          # 跳转兜底：打开目录
      terminal:
        type: windowTitle
        match: WorkBuddy         # 首选：把窗口切到前台
```

### 两个已知边界

1. **点击跳转需要浮窗能接收鼠标。** 若开了「锁定浮窗（鼠标穿透）」，
   点击会穿过去。要在灯带行上点击，请确保穿透是关的。
2. **跳不到 WorkBuddy 里的具体会话。** 没有已知的深度链接协议
   （本地 IPC 是命名管道 + ticket，协议未公开；HTTP 端口有服务但 API 未知），
   所以做的是"把 WorkBuddy 窗口切到前台"。
   > 已排查：`\\.\pipe\wbipc-…` + ticket（协议未知）；
   > HTTP 18488/50304/50305 有服务但一律 404（API 未知）。
