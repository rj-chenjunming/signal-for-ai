# 进展报告：D2 混合仲裁全链路打通（goal round 6）

> 本轮完成 11 项设计决策里**最后一块功能性工作**：把 dsh 侧插件的精确信号
> 与主动轮询的兜底真正合并成一条降级链。
> 日期：2026-10-13 · 结论：**D2 全链路 10/10 打通，387 测试全绿**

---

## 一、为什么需要仲裁层

采集有两条路，各有硬伤，必须合并：

| | 主动轮询（DshMonitor） | 插件推送（dsh host 插件） |
|---|---|---|
| 拿到「等待授权」 | ❌ 拿不到 —— `pendingInteraction` 只在 dsh 客户端内存里 | ✅ **精确** |
| 需要装插件 | ✅ 不需要，零侵入 | ❌ 每个实例都要装 |
| 远端隧道实例 | ✅ 只要端口能连 | ❌ 远端往往不方便改 |
| 时效 | 受轮询间隔限制 | 事件驱动，准实时 |

D2 = **插件优先、轮询打底、插件失效自动退回**。
本轮把这条降级链落成 `src/main/monitors/dsh-arbiter.ts`。

---

## 二、本轮产出

| 文件 | 说明 |
|---|---|
| `src/main/monitors/dsh-arbiter.ts`（新） | `DshSignalArbiter` + `mergeExactIntoPolled` + `asWaitKind` |
| `src/main/monitors/dsh-instance.ts`（改） | `deriveFromListItem` 改为**只产出轮询侧**结论（签名变更） |
| `src/main/monitors/dsh.ts`（改） | 先算轮询态，再 `mergeExactIntoPolled` 叠加精确态 |
| `src/main/monitors/host.ts`（改） | 原始 webhook 载荷喂给仲裁器；`arbiter` 选项 |
| `src/main/index.ts`（改） | 构造仲裁器并注入 `MonitorHost` |
| `lamp/plugin/index.js`（改） | **上报 `authority`**（仲裁按实例归位的前提） |
| `test/dsh-arbiter.test.ts`（新） | 34 个用例 |
| `scripts/d2-arbitration-check.mjs`（新） | **全链路实测**（真 HTTP → 真 HookServer → 真 MonitorHost → 真 dsh） |
| `lamp/probe/integration-test.mjs`（改） | 新增 authority / sessionId 断言（20 → 22 项） |

---

## 三、关键设计决策（都有 PRD 依据）

### 3.1 按 `sessionId` 而非 `taskId` 索引

一个 dsh 实例（= 一个 authority = 一个 dsh 型任务）下会有**多个会话**，
等待授权可能发生在其中任意一个。按 session 粒度归位，
聚合才能真正反映「这个端口上有个会话卡住了」。taskId 粒度会把「哪个会话」抹掉。

### 3.2 TTL 是必需的 —— 这是「防灯一直是绿的」的镜像问题

插件可能已经挂了、或 dsh 被关掉了，而最后一条「等待授权」还挂在内存里。
若永不失效，灯会**永远停在黄色** —— 用户以为还要等授权，实际插件早死了。

所以 `exactStateFor()` 在超过 TTL（默认 180s）后**返回 undefined**，
DshMonitor 自然退回 `plan.pending` 近似判定。**这条降级是 D2 的核心，不是可选项。**

### 3.3 ★ `mergeExactIntoPolled` 里一个必须存在的保护

排序刻意如此：

```ts
export function mergeExactIntoPolled(polled, exact) {
  if (exact === undefined) return polled;
  if (polled === 'failed') return 'failed';        // ① PRD §4.4 failed 一票否决
  if (exact.errorMessage !== undefined) return 'failed';  // ② 插件报错
  if (exact.pendingInteraction !== undefined) return 'waiting'; // ③ 精确等待
  return polled;
}
```

**① 这条是我写测试时才发现的**：最初版本没有它，
于是 `mergeExactIntoPolled('failed', { pendingInteraction: 'approval' })`
返回 `'waiting'` —— 一个**已经崩掉的实例**会因为插件推来一条"在等授权"
而被粉饰成黄色，让人以为还在正常等。

这直接违反 PRD §4.4「failed 一票否决」。是测试断言把它逼出来的。

### 3.4 精确信号刻意**不在** `deriveFromListItem` 里合并

`deriveFromListItem` 现在只产出「轮询侧」结论（只用 `running` /
`agentAvailable` / `plan.pending` / `subagentCatalog`）。

若在那里就把精确值混进来，就会绕过 3.3 的 ① 号保护 ——
因为精确值一旦被当成"轮询输入"，`polled` 就永远不会是 `failed` 了。
**分层顺序本身就是正确性的一部分**，代码注释里写明了这一点。

---

## 四、全链路实测（10/10）

`scripts/d2-arbitration-check.mjs` —— 真 HTTP 请求 → 真 HookServer →
仲裁器 → 真 MonitorHost → 真在跑的 dsh web：

```
基线（仅轮询）dsh-3080 = running          ← 轮询拿不到"在等"，只能判 running
使用真实会话 id：session-26c9a3ad-…        ← 从真实 dsh 取的

=== 1. 推一条 approval 等待载荷 ===
  ✅ hub 接受了插件载荷（200）
  推入后 dsh-3080 = waiting
  ✅ ★ 仲裁器捕获到精确等待信号  (waitingCount=1)
  ✅ ★ 该会话的精确信号为 approval  ({"pendingInteraction":"approval"})
  ✅ ★ 端口灯变 waiting（精确信号压过轮询的近似）  (实际 waiting)

=== 2. 强行过期，验证自动退回轮询近似 ===
  ✅ ★ 精确信号已过期（不再返回）
  过期后 dsh-3080 = running
  ✅ ★ 灯不再卡在 waiting —— 退回轮询判定  (实际 running（基线 running）)

=== 3. 推 resumed，验证等待被清掉 ===
  ✅ waiting 载荷被记录为 question
  ✅ ★ resumed 后精确信号被清掉

=== 4. 畸形载荷不得影响 webhook 主流程 ===
  ✅ 畸形载荷被 hub 正常处理（不 500）  (状态码=400,400,400)

✅ D2 全链路打通（10 项）
```

第 1 段是 D2 价值的直接证据：**基线是 running（轮询猜的），
推入插件载荷后精确变成 waiting**；第 2 段证明它不会永远卡在黄色。

### 顺带修掉一个测试 flakiness

第一版用 `ttlMs: 2000` + `sleep(2200)` 去等过期，结果断言读到的是**已过期**的状态
（慢机器上"刚推入就过期"）。改为**确定性触发**：加了 `__expireAllForTest()`
测试钩子，TTL 放宽到 8s，过期由钩子驱动而非 sleep。
这与之前修 `stop()` 那个 flaky 测试是同一类问题：**不要用 sleep 测时间行为**。

---

## 五、质量关卡

| 关卡 | 结果 |
|---|---|
| `tsc -p tsconfig.json --noEmit` | **exit 0** |
| `tsc -p tsconfig.electron.json --noEmit` | **exit 0** |
| `tsc -p tsconfig.test.json --noEmit` | **exit 0** |
| `vitest run` | **387 passed × 2 次连续** |
| `scripts/d2-arbitration-check.mjs` | **10/10（全链路）** |
| `scripts/live-dsh-check.mjs` | **真实 dsh 打通** |
| `scripts/verify-strip-visual.mjs` | **17/17 视觉验收** |
| `scripts/smoke-e2e.js` | **全部通过** |
| `scripts/check-dsh-config.mjs` | **示例配置 0 警告** |
| `lamp/probe/integration-test.mjs` | **22/22 插件契约** |

测试数字对账：`354（上轮）+ 34（arbiter）− 1（deriveFromListItem 旧用例合并）= 387` ✅

---

## 六、发现的一个既有行为（未改动，仅记录）

实测日志里出现：

```
[warn] [store] 非法状态转移被拒绝: dsh-plugin-3080 idle -> waiting
```

这是 `TaskStore` 的转移表**不允许 `idle -> waiting`**。
对一个纯推送型的 webhook 任务，它在收到第一条推送前一直是 `idle`，
于是第一条 `waiting` 会被拒。

**但这不影响 D2 的功能** —— 仲裁器在 `HookServer` 层就拿到了原始载荷，
不依赖 webhook 任务自身能否完成状态转移。dsh 型任务的灯正确变黄了（断言通过）。

不过这是个真实的粗糙点：**纯推送型任务的第一次 waiting 会被丢掉**。
修它需要放宽转移表（`idle -> waiting` 是否合法），而那会触碰 PRD §4.2 的不变量区，
属于需要单独决策的改动，**本轮不擅自动**，仅记录。

---

## 七、完成度

| 决策 | 状态 |
|---|---|
| D1 置顶浮窗 | ✅ |
| **D2 状态采集（含混合仲裁）** | ✅ **本轮完成** —— 插件精确 + 轮询兜底 + TTL 自动退回，全链路实测 |
| D3 扩展项目 | ✅ |
| D4 端口发现 | ✅ |
| D5 远端鉴权 | ⏳ **SSH 路径未验证**（唯一外部阻塞） |
| D6 聚合粒度 | ✅ |
| D7 插件 | ✅ |
| D8 采集方式 | ✅ 轮询/事件就绪；⏳ `session/follow` 未试（可选优化） |
| D9 灯排布 | ✅ 视觉验收 17/17 |
| D10 浮窗交互 | ✅ |
| D11 通知策略 | ✅ |

**11 项决策里 10 项已完成。** 剩下：
- **D5 SSH 取远端密钥** —— 外部阻塞（SSH 非交互探测挂起，未验证）
- **D8 `session/follow` 订阅流** —— 可选优化，当前轮询已够用
- **插件装进真实 3080** —— 需要你同意重启（属上线动作，不影响代码完成度）

---

## 八、复现

```powershell
cd D:\Projects\lamp\ai-task-indicator

# 类型检查（三份都应 exit 0）
node node_modules/typescript/bin/tsc -p tsconfig.json          --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.test.json     --noEmit

# 全量测试（应 387 passed）
node node_modules/vitest/vitest.mjs run

# D2 全链路（真 HTTP → 真 HookServer → 真 MonitorHost → 真 dsh）
node node_modules/typescript/bin/tsc -p tsconfig.json
node scripts/d2-arbitration-check.mjs

# 其余关卡
node scripts/live-dsh-check.mjs
node scripts/verify-strip-visual.mjs
node scripts/smoke-e2e.js
node scripts/check-dsh-config.mjs
```
