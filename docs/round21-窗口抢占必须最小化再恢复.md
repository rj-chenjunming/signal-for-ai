# 修：窗口抢占失败 —— 必须走「先最小化再恢复」（round 21）

> 你报的问题：「还是不行点击3080没反应 点击13080则是新建一个窗口」
> 日期：2026-10-14 · 结论：**545 测试全绿，两个端口都实测确认能切到 Chrome 前台并保持**

---

## 一、你的两个现象各自指向不同的问题

| 现象 | 原因 |
|---|---|
| 点 3080 **没反应** | 找到了窗口、也"激活"了，但**前台根本没被抢过来** |
| 点 13080 **新建窗口** | 它当时没配 `openUrlTitleMatch` → 走"新开"路径 |

第一个是本轮的主线，第二个是配置遗漏。

---

## 二、★ 定位过程：两处 API 撒谎

### 2.1 第一处：我自己的成功判据不可靠

日志一直说 `已通过 Win32 激活窗口「…」`，而你看不到变化。
我的判据是 `GetForegroundWindow() == 目标` —— 看起来挺硬。

### 2.2 用一个**独立于应用**的实验复现了失败

我写了个脱离应用的脚本：先把别的窗口刻意置前，再用和应用**完全相同**的手法激活 Chrome，然后读真实前台。结果：

```
[start]             foreground = '锐捷云桌面'
[after other]       foreground = '锐捷云桌面'   ← 连我主动置前别的窗口都失败
SetForegroundWindow returned : False
GetForegroundWindow == Chrome: False
```

**连主动置前都失败** —— 说明触发条件是「**前台被别的应用占着**」，
而不是窗口句柄或权限问题。我之前测 WorkBuddy 时成功，是因为当时前台恰好就是 Chrome。

### 2.3 ★★ 逐方法对照，拿到决定性结论

在同一条件下把几种手法依次试一遍：

| 方法 | API 返回值 | **前台真的变了吗** |
|---|---|---|
| A 直接 `SetForegroundWindow` | False | ❌ |
| B `AttachThreadInput` + `SetForegroundWindow` | False | ❌ |
| C `AppActivate(pid)` | **True** | ❌ |
| D `AppActivate(标题)` | **True** | ❌ |
| **E 先最小化 → 恢复 → `SetForegroundWindow`** | True | **✅ 变了** |

两个必须记住的结论：

1. **`AppActivate` 的返回值完全不可信** —— 它返回 `True` 却什么都没做。
   这正是"日志说成功、你看不到变化"的根源。
   → 所以成功判据必须是 `GetForegroundWindow()` 的**真实结果**，
   不能信任何 API 的返回值。

2. **只有「先最小化再恢复」这一个往返能拿到前台权限。**
   它让 Windows 把这个窗口当作"刚被用户恢复的窗口"，
   从而授予前台权限 —— 这是绕开前台锁的关键。

### 2.4 顺带修掉我之前实现里的一个缺陷

原实现的恢复那一步是**有条件**的：

```ts
'$wasMin = [LampFocus]::IsIconic($h)',
'if ($wasMin) { [void][LampFocus]::ShowWindow($h, 9) }',   // 只在已最小化时才恢复
```

而"窗口正常显示但不在前台"这个**最常见**的情况，`IsIconic()` 返回 false，
于是 restore 从未被触发，前台自然抢不过来。

**这正是"点了没反应"的直接原因。**

---

## 三、修法

```ts
// ★ 无论当前是否最小化，都先最小化再恢复。
//   这个往返让 Windows 授予前台权限（实测唯一有效的路径）。
'[void][LampFocus]::ShowWindow($h, 6)',   // SW_MINIMIZE
'Start-Sleep -Milliseconds 120',
'[void][LampFocus]::ShowWindow($h, 9)',   // SW_RESTORE
'[void][LampFocus]::BringWindowToTop($h)',
'[void][LampFocus]::SetForegroundWindow($h)',
```

同时把 `AttachThreadInput` 那一套去掉（实测无效，而且在窗口非最小化时反而干扰）。

---

## 四、实测验证

### 4.1 点 3080（修之前"没反应"）

```
=== 点击前 ===
current foreground: '锐捷云桌面'
isChrome          : False

=== 点击后 ===
current foreground: 'Initial hello to coding assistant — DeepSeek Harness - Google Chrome'
isChrome          : True
```

并且**持续稳定**（连续观察到 13 秒仍是 Chrome，没有被抢回）。

### 4.2 点 13080

补上 `openUrlTitleMatch` 后同样验证：点击后 Chrome 持续在前台 **18 秒**
（用后台采样每 0.9 秒打一次，全程都是 Chrome）。

```
17:26:30 * Initial hello to coding assistant — DeepSeek Harness - Google Chrome
17:26:31 * Initial hello to coding assistant — DeepSeek Harness - Google Chrome
...（18 秒内一直保持）
17:26:47 * Initial hello to coding assistant — DeepSeek Harness - Google Chrome
```

---

## 五、配置改动

`dsh-13080` 也配上 `openUrlTitleMatch`：

```yaml
  - id: dsh-13080
    jump:
      openUrl: http://127.0.0.1:13080
      # 实测两个 dsh 端口在**同一个** Chrome 窗口里，
      # 所以用同一个片段 —— 点哪个都切到那个窗口（不新开）。
      openUrlTitleMatch: DeepSeek Harness
```

---

## 六、一个过程中的自我提醒

我一度以为 13080 的激活"成功后又失效了"，差点去查是不是有东西抢焦点。
实际上那是**我自己的检查命令**（启动 PowerShell 读前台）抢了焦点造成的干扰。
用后台采样重测后，全程稳定。

> 教训：**观测行为本身会干扰被测对象。** 验证"窗口是否在前台"时，
> 任何会创建窗口的操作（启动 PowerShell）都可能改变前台 ——
> 所以要用采样而不是"查一次"。

---

## 七、验证

| 关卡 | 结果 |
|---|---|
| `tsc` × 3 份配置 | **全部 exit 0** |
| `vitest run` | **545 passed** |
| `scripts/sqlite-monitor-check.mjs` | **16/16** |
| `scripts/d2-arbitration-check.mjs` | **10/10** |
| `scripts/d5-tunnel-check.mjs` | **7/7（exit 0）** |
| `scripts/live-dsh-check.mjs` | **打通** |
| `scripts/verify-strip-visual.mjs` | **17/17** |
| `scripts/inspect-live-lamp.mjs` | **全部正确** |
| `scripts/smoke-e2e.js` | **全部通过** |
| `scripts/check-dsh-config.mjs` | **0 警告** |
| **实测点击 3080 / 13080** | **都切到 Chrome 前台并保持**（13s / 18s 采样） |

---

## 八、复现

```powershell
cd D:\Projects\lamp\ai-task-indicator

node node_modules/typescript/bin/tsc -p tsconfig.json
node scripts/start.mjs -- --config ./config.dsh.example.yaml --remote-debugging-port=9222

# 点某一行；日志应有：
#   聚焦请求：任务 dsh-3080
#   页面已开着，切到前台「…」（未新开标签页）
#   已通过 Win32 激活窗口「…」        ← 这次是真的切过去了
node scripts/probe-row-jump.mjs dsh-3080
```
