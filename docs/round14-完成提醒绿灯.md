# 修：任务执行完直接变灰，丢掉提醒效果（round 14）

> 你报的问题：「执行完了任务似乎直接变灰色了，这样就失去的提醒的效果」
> 日期：2026-10-14 · 结论：**512 测试全绿，五条实测链全通，绿灯已在真实应用里冒出来**

---

## 一、你说得对，而且这是设计缺口不是小瑕疵

原来的判定只有三档：

```
有新鲜活跃会话 -> running（蓝）
其余           -> idle（灰）
进程不在       -> 隐藏
```

问题在于**灰色同时表示两件事**：

- 「进程在，但没任务在干活」
- 「刚做完一件事」

这两件事混在一起，**"刚做完"这个信息就没了** —— 而它恰恰是你最想看到的。
任务跑完那一刻从蓝直接跳灰，等于什么提示都没给。

---

## 二、修法：给"刚完成"单独一档，绿灯保持一段时间

```
有新鲜活跃会话      -> running（蓝）
★ 刚刚有会话完成    -> success（绿）   ← 新增
其余                -> idle（灰）
进程不在            -> 隐藏
```

### 2.1 判"刚完成"用 `updated_at` 而不是 `last_activity_at`

实测发现一个有用的细节 —— **完成时会额外刷一次 `updated_at`**，它比
`last_activity_at` 晚：

```
completed   updated-lastActivity = 3965 ms   ← 写完完成状态的时刻
completed   updated-lastActivity = 278 ms
completed   updated-lastActivity = 263 ms
```

所以 `updated_at` 更能代表"完成发生的那一刻"，判据用它。

### 2.2 `running` 必须优先于 `success`

否则你连着跑两个任务时，灯会一直停在上一个的绿上，看不出**当前**在干活。

### 2.3 保持时长可配，也能关掉

```yaml
holdSuccessMs: 600000    # 10 分钟（默认），与 store 的 dismissAfterMs 默认值一致
```

设 `0` 就是关掉完成提醒（完成即回灰）。

---

## 三、★ 连带发现：状态机会把这功能静默打掉

实现完先跑，发现绿灯**根本不亮** —— 因为 `ALLOWED_TRANSITIONS` 里：

```ts
idle: ['starting', 'running', 'waiting', 'failed'],   // ← 没有 success
```

sqlite 型在两次任务之间**一直上报 `idle`**，所以"刚完成"那一刻的前一个状态
**必然是 `idle`**。`idle -> success` 被拒 → `apply` 返回 `null` → 灯不变。

**这已经是同一类缺口第三次出现了**（前两次是 `idle -> waiting`、
`failed -> running`）。规律很清楚：**转移表是按"轮询型"监控的路径写的，
每加一种新范式的监控，就会撞上一条本不该限制它的边。**

### 3.1 有两条测试**刻意**断言它必须被禁止

```
✗ 不变量：idle -> success 仍被禁止（没干活就变绿）
✗ 反向约束：idle -> success 仍为 false（必须先真正跑过）
```

我没有直接把断言翻过来 —— 它们的担忧（**假绿灯**）是真问题。我重新想了
这条保证**应该由谁承担**：

**原先的设计**：靠转移表兜住 —— "没经过 running 就不许 success"。

**问题**：sqlite 型在两次轮询之间（默认 5s）任务可能就跑完了，
前一个状态就是 `idle`。用转移表兜，等于**逼着监控去编造一个 running**
才能让绿灯亮 —— 那是把架构的方便凌驾于事实之上。

**现在的设计**：保证改由**信号源本身**承担。看 SQL：

```sql
SUM(CASE WHEN lower(status) <> lower(?)      -- 不是 working
         AND updated_at IS NOT NULL
         AND (? - updated_at) <= ?           -- 且真的刚更新过
    THEN 1 ELSE 0 END) AS recentlyDoneCount
```

**一个从没跑过的任务，结构上不可能让这个数 > 0** ——
它要求数据库里有一条"刚更新过、且状态已不是 working"的记录，
那只能是**真的完成过**。所以"假绿灯"在源头就被堵死了，而且堵得比转移表更准。

于是放开 `idle -> success`，并把两条测试的**理由改写成上面这段**
（而不是悄悄删掉或翻转）。

**保留的约束**：`failed -> success` 和 `unknown -> success` 仍然禁止
（PRD §4.2 硬不变量，未受影响）；而且"允许这条边" ≠ "会自动变绿" ——
它只由监控的真实完成信号驱动，store 自身不会凭空走到 success。

---

## 四、实测

### 4.1 真库上正好有个 6 分钟前完成的会话

```
workbuddy  状态=success  bg=rgb(34,197,94)
  悬停：WorkBuddy · 已完成 · 1 个任务刚完成
  动画=strip-dot anim-flash-once      ← 闪一次，抓注意力
总灯       状态=success  标签="已完成"
```

注意它还带 `anim-flash-once` —— 绿灯会**闪一下**，比常亮更容易被注意到。

### 4.2 保持窗口真的会过期（同一份真实脚本）

```
holdSuccessMs= 600000（10 分钟）-> recentlyDoneCount=1   ← 算到 6 分钟前那次
holdSuccessMs=  60000（ 1 分钟）-> recentlyDoneCount=0   ← 过期了
holdSuccessMs=      0（关掉）  -> recentlyDoneCount=0
```

### 4.3 优先级正确

喂"有 1 个新鲜活跃 + 5 个刚完成" → 判成 **running**（蓝），
不会被完成档抢走。

---

## 五、质量关卡

| 关卡 | 结果 |
|---|---|
| `tsc` × 3 份配置 | **全部 exit 0** |
| `vitest run` | **512 passed**（507 → 512，+5 完成档测试） |
| `scripts/sqlite-monitor-check.mjs` | **13/13**（原 10 项 + 完成档 3 项） |
| `scripts/d2-arbitration-check.mjs` | **10/10** |
| `scripts/d5-tunnel-check.mjs` | **7/7** |
| `scripts/live-dsh-check.mjs` | **打通** |
| `scripts/verify-strip-visual.mjs` | **17/17** |
| `scripts/smoke-e2e.js` | **全部通过** |
| `scripts/check-dsh-config.mjs` | **0 警告** |

启动日志里**没有**「非法状态转移被拒绝」—— 转移表改动生效。

---

## 六、复现

```powershell
cd D:\Projects\lamp\ai-task-indicator

node node_modules/typescript/bin/tsc -p tsconfig.json          --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.test.json     --noEmit
node node_modules/vitest/vitest.mjs run

# 只跑本轮相关
node node_modules/vitest/vitest.mjs run test/sqlite-monitor.test.ts test/store-waiting.test.ts

# ★ 真库哨兵（必须先 build）
node node_modules/typescript/bin/tsc -p tsconfig.json
node scripts/sqlite-monitor-check.mjs

node scripts/start.mjs -- --config ./config.dsh.example.yaml --remote-debugging-port=9222
node scripts/inspect-live-lamp.mjs   # 刚跑完任务时应看到 success 绿灯
```

---

## 七、旋钮

| 配置 | 作用 |
|---|---|
| `activeWithinMs` | 多久内有活动才算"在跑"（默认 2 分钟）。调大→停顿久也不熄灯 |
| `holdSuccessMs` | 「刚完成」绿灯保持多久（默认 10 分钟）。**设 0 关掉完成提醒** |

如果觉得绿灯留太久碍事，调小 `holdSuccessMs`；觉得漏掉了完成，调大。
