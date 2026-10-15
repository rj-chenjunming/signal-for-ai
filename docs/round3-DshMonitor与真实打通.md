# 进展报告：DshMonitor 适配器 + 真实 dsh 端到端打通（goal round 3）

> 本轮把采集层接进项目框架，并**第一次真正监控到运行中的 dsh web**。
> 过程中抓到一个"格式全对但一律 401"的隐蔽密码学 bug。
> 日期：2026-10-13 · 结论：**真实链路打通（17 会话 / 1 活跃），318 测试全绿**

---

## 一、本轮产出

| 文件 | 说明 |
|---|---|
| `src/main/monitors/dsh.ts`（新） | `DshMonitor` 适配器 + `SecretSource` 抽象 + `aggregate()` |
| `src/main/monitors/dsh-instance.ts`（改） | **修正 cookie 签名的致命 bug**；cookie 寿命 7天 → 1天 |
| `src/main/monitors/host.ts`（改） | 接入 `case 'dsh'`，构造密钥来源链；新增 `pluginStateFor` 注入点 |
| `src/main/config.ts`（改） | 新增 `validateDshMonitor`，`app.dshHome` 解析；合法 type 增加 `dsh` |
| `src/shared/types.ts`（改） | `DshMonitorConfig` + `isDshMonitor`；`AppSettings.dshHome` |
| `test/dsh-monitor.test.ts`（新） | 27 个用例 |
| `test/config-dsh.test.ts`（新） | 16 个用例 |
| `config.dsh.example.yaml`（新） | 三示例：本机型 / 隧道型 / 插件精确型 |
| `scripts/live-dsh-check.mjs`（新） | **真实环境端到端**验证 |
| `scripts/check-dsh-config.mjs`（新） | 用项目自己的校验器验证示例配置 |

---

## 二、最重要的发现：一个"格式全对但一律 401"的密码学 bug

### 现象

`DshClient` 对 `127.0.0.1:3080` **一律 401**，而同一台机器上
手写的探针（`lamp/probe/auth-probe.mjs`）却能拿到 **200**。

cookie 的**名字对、格式对（`v1.<body>.<sig>`）、长度对（224）**，
密钥也确认是同一份（32 字节，逐字节相等）。

### 定位过程

写了一个并排对比脚本（`scripts/compare-dsh-auth.mjs`），
打印两条路径的 cookie 并在**同一个 body** 上复算 HMAC：

```
同一 body 下，两种 HMAC 写法是否一致: false
```

### 真因

dsh 服务端（及我的探针）用的是：

```js
createHmac('sha256', secret)              // secret 是 Buffer —— 原始字节
```

而我的实现写成了：

```js
createHmac('sha256', secret.toString('base64'))   // ← 错！把 base64 文本的 ASCII 当密钥
```

**这是我早先"修一个 TS 类型错误"时引入的。** 当时的报错是：

```
Argument of type 'string' is not assignable to parameter of type 'Buffer<ArrayBufferLike>'
```

我为了绕开 `@types/node` 22 里 `Buffer<T>` 的不变性，把它改成了
`secret.toString('base64')` —— **类型检查过了，但密码学语义被悄悄改掉**。
用一个完全不同的密钥去签，服务端当然验不过。

### 修法

```js
createHmac('sha256', secret as unknown as string).update(body, 'utf8')
```

`as unknown as string` 只骗过类型检查，运行时拿到的仍是 **Buffer 本身**，
字节完全正确。并加了**防回归测试**，锁死这条契约：

```ts
expect(withRawBytes).not.toBe(withBase64Text);   // 两种写法必须不同
expect(sigFromImpl).toBe(expectedSig);           // 实现必须走"原始字节"
expect(sigFromImpl).not.toBe(wrongSig);          // 且绝不能等于"base64 文本"那种
```

### 教训

> **类型错误不要用"改语义"的方式绕过。**
> 这个 bug 的可怕之处在于它完全不违反类型、不违反格式、
> 不违反任何长度检查 —— 唯一的表现是远端回 401。

---

## 三、第二个发现：cookie 寿命也有服务端约束

改成原始字节后仍然是 401。继续对比发现 payload 不同：

| | `expiresAt - issuedAt` |
|---|---|
| 能通的探针 | `86,400,000`（1 天） |
| 我的实现 | `604,800,000`（7 天） |

dsh 服务端有一条校验（`dsh-client-connection/lib/index.js:442`）：

```js
return payload.issuedAt <= now && payload.expiresAt > now
    && payload.expiresAt > payload.issuedAt
    && payload.expiresAt - payload.issuedAt <= this.maxAgeMilliseconds;   // ← 这条
```

即**服务端会拒绝"寿命超过它自己 `cookieMaxAgeDays` 上限"的 cookie**。
本机该实例的上限明显短于 7 天。

由于 `DshClient` **每次请求都重新签一枚 cookie**，长寿命毫无收益，
改为 **1 天**（已验证可通）。代码里写明了原委，并留了警告不要调大。

---

## 四、真实环境端到端打通

`scripts/live-dsh-check.mjs` —— 真配置 + 真 `MonitorHost` + 真 `TaskStore`
去监控**真正在跑的 dsh web**：

```
启动 MonitorHost，监控 1 个任务...

=== 日志 ===
  [info] [dsh-3080] 已启动 dsh 监控 authority=127.0.0.1:3080 interval=1500ms
  [info] 任务 dsh-3080 监控已启动（dsh）

=== store 快照 ===
  dsh-3080     status=running  message=dsh 127.0.0.1:3080：17 会话，1 个活跃

=== 断言 ===
  ✅ 拿到了非 idle 的真实状态（证明真的读到了 dsh）  (status=running)
  ✅ message 里带上了 authority（证明是我们的适配器写的）
  ✅ message 里带上了会话数（证明真的解析了 session/list）

✅ 真实 dsh 端到端打通
```

链路完整走通：读 `~/.dsh/.credentials.yaml` → 自签 cookie →
真 `POST /api/session/list` → 解析 17 个真会话 → 逐会话判定 → 聚合 → 写进 store。

---

## 五、质量关卡

| 关卡 | 结果 |
|---|---|
| `tsc -p tsconfig.json --noEmit` | **exit 0** |
| `tsc -p tsconfig.electron.json --noEmit` | **exit 0** |
| `tsc -p tsconfig.test.json --noEmit` | **exit 0** |
| `vitest run` | **318 passed × 2 次连续**（原 224 + 新增 94） |
| `node scripts/smoke-e2e.js` | **全部通过** |
| `scripts/live-dsh-check.mjs` | **真实 dsh 打通** |
| `scripts/check-dsh-config.mjs` | **示例配置 0 警告通过** |

测试数字对账：`224（原）+ 38 + 11 + 27 + 16 + 3（防回归等）= 318` ✅

### 修掉一个自己造的 flaky 测试

`stop() 之后不再轮询` 起初用 `await sleep(120)` 等"第一轮落地"，
在负载高时偶发失败（3 次跑里 1 次红）。改为**确定性地先跑一轮再 stop**，
不再依赖时序。之后连续 3 次全绿。

---

## 六、顺带发现的一个既有隐患（未改动，仅记录）

`config.example.yaml` 里有：

```yaml
cwd: "%USERPROFILE%"
```

`validateConfig` 的展开顺序是 **先 parse YAML，再 expandDeep**，
所以这样写其实**是安全的**（YAML 看到的是字面量 `%USERPROFILE%`）。
但如果是"先展开再 parse"就会炸（`C:\Users\...` 的反斜杠在双引号里是非法转义）。

我在自己的 `check-dsh-config.mjs` 第一版就把顺序搞反了，撞上了这个坑，
已改正并在测试里记录了两种顺序的差别。

---

## 七、完成度

| 决策 | 状态 |
|---|---|
| D2 状态采集 | ✅ (a) 主动采集**真实打通**；✅ (b) 插件端到端验证；⏳ 二者合并仲裁 |
| D3 扩展项目 | ✅ 采集层全部落进项目，质量关卡全绿 |
| D4 端口发现 | ✅ 完成并实测 |
| D5 远端鉴权 | ⏳ SSH 路径仍未验证（SSH 挂起）；字段已预留 |
| D6 聚合粒度 | ✅ 会话级 + 端口级聚合完成（`17 会话，1 个活跃` 即证据） |
| D7 插件 | ✅ 完成且契约对齐 |
| D8 采集方式 | ✅ 事件驱动 + 轮询就绪；⏳ `session/follow` 未试 |
| **D1/D9/D10 浮窗 UI** | ⏳ **未开始 —— 现在只剩这块和通知了** |
| D11 通知 | ⏳ 未开始 |

---

## 八、复现

```powershell
cd D:\Projects\lamp\ai-task-indicator

# 类型检查（三份都应 exit 0）
node node_modules/typescript/bin/tsc -p tsconfig.json          --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.test.json     --noEmit

# 全量测试（应 318 passed）
node node_modules/vitest/vitest.mjs run

# 真实 dsh 端到端（需要本机 3080 有 dsh web 在跑）
node node_modules/typescript/bin/tsc -p tsconfig.json
node scripts/live-dsh-check.mjs

# 示例配置校验
node scripts/check-dsh-config.mjs

# 端到端冒烟
node scripts/smoke-e2e.js
```
