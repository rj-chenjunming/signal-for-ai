# sqlite 型监控：让 WorkBuddy 的表达也统一成「有任务在跑才算活着」（round 13）

> 你定的语义：**蓝色就应该表示有任务在跑；进程在但没任务跑就灰色；
> 进程没在就直接隐藏。**
> 日期：2026-10-14 · 结论：**507 测试全绿，五条实测链全通，三态在真实应用里逐一验证**

---

## 一、为什么 `process` 型做不到，而信号其实一直都在

`process` 型的语义是**进程生命周期**（`匹配到进程 -> 持续存活 -> running`）。
WorkBuddy 是常驻 Electron 应用，所以只要窗口开着就永远蓝灯 ——
它回答的是"崩了没"，回答不了"在不在干活"。

我把 WorkBuddy 的信号源翻了一遍：

| 信号源 | 结论 |
|---|---|
| `~/.workbuddy/logs/automation.log` | ❌ 一个月只有 **1 次** `run start`，且只覆盖"定时任务" |
| `D:\projects\.workbuddy\logs\main.log` | ❌ 全是 `HeapTrim`/`PerfMetrics` 噪声，无任务级事件 |
| **`workbuddy.db` → `sessions` 表** | ✅ **有 `status` + `last_activity_at`** |
| `workbuddy.db` → `automation_runtime_state` | ✅ `running=0/1`（但只覆盖定时任务） |

数据库那份是权威的：
```
completed   52
working      2   ← 但静默 1199/1201 分钟
terminated   1
Terminated   1   ← 连大小写都不统一，说明这字段不受纪律
```

### ★ 必须记住的坑：只看 `status` 会永远亮蓝

那 **2 个 `working` 是遗留状态**（应用异常退出/会话被弃置时没回写）。
所以判据必须是**两个条件同时成立**：

```
status = activeStatus  AND  (now - last_activity_at) <= activeWithinMs
```

实测证明这条必要：真库当前 `activeCount=2, freshActiveCount=0`
→ 正确地判成**灰**（若只看 status 就会是蓝）。

---

## 二、先撞上的硬阻塞：Electron 读不了 SQLite

```
electron      33.0.0
node          20.18.0      ← Electron 33 内置
sqliteModule  FAILED: No such built-in module: node:sqlite
```

`node:sqlite` 是 **Node 22.5+** 才有的。主进程里直接 `require('node:sqlite')`
**不存在** —— 方案必须改道。

我顺手排除了两条替代路，都没有硬赌：

- WorkBuddy 的本地 IPC（命名管道 `\\.\pipe\wbipc-…` + ticket）：**协议未知**
- 本地 HTTP 端口 18488 / 50304 / 50305：**有服务但一律 404，API 未知**

最终走 **spawn 系统 `node.exe`**（你机器上 v24.14.0，支持 `node:sqlite`）。
这不是新范式 —— `process` 型的进程枚举本来就是 spawn PowerShell 长驻子进程。

代价是引入"系统装了 Node"这个外部依赖，已在配置注释里写明，
未装时**优雅降级**（连续失败转 `unknown` = 隐藏该行），不会让应用崩。

---

## 三、实现

### 3.1 新增 `SqliteMonitorConfig`

```yaml
- id: workbuddy
  monitor:
    type: sqlite
    database: D:/your-appdata/.workbuddy/workbuddy.db
    activeStatus: working        # 哪个 status 代表"正在跑"（大小写不敏感）
    activeWithinMs: 120000       # 多久内有活动才算"还在跑"
    intervalMs: 5000
    requireProcess:              # ★ 进程闸门 —— "进程不在"那一档的唯一来源
      - processNames: [WorkBuddy.exe]
      - processNames: [node.exe]
        cmdlineContains: [.workbuddy]
    maxFailures: 3
```

### 3.2 判定逻辑抽成纯函数（可穷举测试）

```ts
export function deriveSqliteVerdict(row, processAlive) {
  if (processAlive === false) return { hidden: true, ... };      // 隐藏
  if (row.freshActiveCount > 0) return { status: 'running', ... }; // 蓝
  return { status: 'idle', ... };                                  // 灰
}
```

并且**区分两种"灰"**并写进 message：

- `进程在，2 个会话状态陈旧（未在执行）` ← 有残留 working，值得你注意
- `进程在，当前没有任务在执行` ← 常态

不区分的话，将来出问题会很难诊断。

### 3.3 顺带消掉一处重复

`process` 型的 `match` 和 `sqlite` 型的 `requireProcess` 语义完全一样
（组间**或**，组内 `processNames` 与 `cmdlineContains` **与**），
所以抽出 `readProcessMatchRules()` 共用，免得两处口径日后漂移。

### 3.4 安全：SQL 与状态值都走 `JSON.stringify`

状态值和路径都是配置里的字符串，直接拼进要执行的 JS 会造出语法错误甚至注入。
有专门测试验证：含引号/反斜杠的值拼出来的脚本能被 `new Function` 解析通过。
另外查询用 `readOnly: true` 打开 —— **绝不写用户的库**。

---

## 四、实测：三态在真实应用里逐一验证

### 灰灯（进程在、没任务在跑）
```
workbuddy  状态=idle  bg=rgb(107,114,128)
  悬停：WorkBuddy · 空闲 · 进程在，2 个会话状态陈旧（未在执行）
```

### 蓝灯（有任务在跑）
用一个**临时库**造出"新鲜 working"（不碰真库），加一个临时任务指向它：
```
workbuddy       空闲   进程在，2 个会话状态陈旧（未在执行）   ← 灰
wb-fresh-test   运行中      1 个任务在执行                   ← 蓝
```
同一个查询逻辑，**因为新鲜度不同而给出相反的结论** —— 这正是关键。

### 隐藏（进程不在）
把临时任务的闸门改成一个**不存在的进程名**（不必真去杀 WorkBuddy）：
```
wb-fresh-test 从灯带消失 ✅
```
说明 `unknown`（被隐藏状态）与闸门联动正确。

验证完临时任务、临时库、临时脚本全部删除。

---

## 五、质量关卡

| 关卡 | 结果 |
|---|---|
| `tsc` × 3 份配置 | **全部 exit 0** |
| `vitest run` | **507 passed**（483 → 507，+24） |
| `scripts/sqlite-monitor-check.mjs`（新增） | **10/10** |
| `scripts/d2-arbitration-check.mjs` | **10/10** |
| `scripts/d5-tunnel-check.mjs` | **7/7** |
| `scripts/live-dsh-check.mjs` | **打通** |
| `scripts/verify-strip-visual.mjs` | **17/17** |
| `scripts/smoke-e2e.js` | **全部通过** |
| `scripts/check-dsh-config.mjs` | **0 警告** |

### ★ 新脚本 `sqlite-monitor-check.mjs` 的价值

它用**真实的 buildQueryScript + 系统 node** 去查**真实的 workbuddy.db**。
为什么必须有它：**SQL 是字符串拼出来的，类型检查完全不能证明它在真库上能跑**
（列名拼错、SQLite 函数用错都只在运行时才炸）。
类型检查说"这段代码自洽"，这个脚本说"这段 SQL 在你机器上是对的"。

### 校验器抓到的真回归

把 workbuddy 从 `process` 改成 `sqlite` 后，`check-dsh-config.mjs` 立刻报：
```
❌ 每种监控类型都有示例（dsh / webhook / process）  (dsh, webhook, sqlite)
```
示例配置**丢掉了 `process` 型的示例**。已补一个 `enabled: false` 的
`process-demo`（顺便演示两种匹配规则 + fallbackLog），
并把断言升级为「四种类型都有示例」+「workbuddy 的 sqlite 配置（含闸门）被保留」。

---

## 六、复现

```powershell
cd D:\Projects\lamp\ai-task-indicator

node node_modules/typescript/bin/tsc -p tsconfig.json          --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.test.json     --noEmit
node node_modules/vitest/vitest.mjs run

# 只跑本轮新增
node node_modules/vitest/vitest.mjs run test/sqlite-monitor.test.ts

# ★ 拿真库验证 SQL（必须先 build）
node node_modules/typescript/bin/tsc -p tsconfig.json
node scripts/sqlite-monitor-check.mjs

node scripts/start.mjs -- --config ./config.dsh.example.yaml --remote-debugging-port=9222
node scripts/inspect-live-lamp.mjs   # workbuddy 应显示"进程在，N 个会话状态陈旧"
```

---

## 七、运维注意

- **依赖系统 Node.js ≥ 22.5**。没装 → 这一行会转 `unknown` 并被隐藏
  （日志里有 `无法启动 ... 需要系统安装 Node.js 22.5+`）。
  可用环境变量 `NODE_BINARY` 指定解释器路径。
- **`activeWithinMs` 是唯一的灵敏度旋钮**：调大 → 任务停顿较久也不熄灯；
  调小 → 更灵敏但可能闪。默认 120000（2 分钟）。
- 若某天 WorkBuddy 改了 `sessions` 表结构，`scripts/sqlite-monitor-check.mjs`
  会先报错 —— 它是这个耦合的**哨兵**。
