# 进展报告：D5 远端密钥全链路打通（goal round 7）

> 上一轮把 D5 列为「唯一外部阻塞：SSH 非交互探测挂起未验证」。
> 本轮查明**挂起不是 SSH 的问题，是 PowerShell 捕获 stdout 的问题**，
> 用 Node 硬超时后一次成功，并把整条链路实现+实测打通。
> 日期：2026-10-13 · 结论：**D5 全链路 7/7，407 测试全绿，11 项决策全部完成**

---

## 一、上一轮的"阻塞"其实是个假阻塞

上一轮我用 PowerShell 直接跑：

```powershell
ssh -o BatchMode=yes user@your-host "echo OK"
```

**挂起超过 5 分钟无返回**，只能中止，于是记成"外部阻塞"。

本轮先做基础排查：

```
=== 主机 your-host:22 可达性 ===  TCP 22 可达: True
=== 现有 ssh 隧道进程 ===          仍在运行（PID 19432）
=== 隧道端口 ===                   13080 / 3080 均返回 401（服务活着）
```

**网络与 SSH 都是好的** —— 挂起出在 PowerShell 的调用方式上。
换成 `node:child_process` + 硬 timeout 后：

```
--- 裸 ssh + BatchMode ... ✅ 通（11389ms）
    D5_OK | sdk-System | /home/your-user/.dsh/.credentials.yaml
```

首次握手约 11.4 秒（偏慢，但正常），脚本用 20s 硬超时兜住。

**教训**：跑外部进程一定要能**真正杀掉它**。PowerShell 的调用方式会让
一次网络抖动冻结整个应用；`execFile` 的 `timeout` + `killed` 标志才是可靠做法。

---

## 二、实测确认的关键事实

远端 credentials 是 **293 字节**，本机是 **363 字节** —— **密钥不同**，
证实了「隧道实例用的是它自己那套密钥」。

并且用远端密钥成功认证：

```
=== 用通的那条路取远端 credentials ===
✅ 取回 293 字节
✅ 远端密钥解析成功：32 字节
   GET http://127.0.0.1:13080/ -> HTTP 200
```

---

## 三、实现：`SshCredentialsSource`

`src/main/monitors/dsh-remote-auth.ts`（新增）

| 设计点 | 理由 |
|---|---|
| **缓存 30 分钟** | 若不缓存就是「每实例每 5 秒一次 SSH 握手」——完全不可接受 |
| **失败不写缓存** | 一次网络抖动不该锁死 30 分钟 |
| **硬超时 + 区分 `killed`** | 要能把"超时"与"连接被拒"分开报，否则排查时看不出所以然 |
| **复用本机同一个 `parseSigningSecret`** | 远端文件与本机同格式（实测确认），不需要第二套解析逻辑 |
| **任何失败都不抛** | 收敛成 `{ok:false, reason}`，由调用方计入失败计数并转 unknown |
| `extraArgs` 支持 `-F` / `-p` | 适配非标准端口与现成的 ssh_config |

---

## 四、★ 一个真实的设计 bug（本轮最重要的发现）

第一版接线后实测：**第一轮 401，第二轮仍然 401，而且从来没有跑过 SSH。**

日志说"将尝试从 … 取密钥"，但**永远不尝试**。

### 根因

我最初的兜底只挂在**读取本机文件失败**的分支上：

```ts
try {
  const secret = readSigningSecret(this.dshHome);   // ← 这里成功了
  return secret;
} catch (err) {
  return await this.fetchRemoteSecret();            // ← 只有读文件失败才到这里
}
```

但真实情况是：本机文件**读得到**（32 字节，完全合法），
只是**服务端不认**（401）—— 隧道那头的 dsh 用的是它自己的密钥。

于是 `invalidate()` 清掉缓存后，下一轮又老老实实把**同一把本机密钥**读回来，
永远走不到远端。

### 修法：把两件事分开

「文件读不到」与「密钥被服务端拒绝」是**两件不同的事**：

```ts
private localRejected = false;   // 新增：本机密钥是否已被服务端拒绝过

async get() {
  if (this.cached) return this.cached;
  // ① 本机密钥已被拒 -> 直接走远端，不再重复读本机文件
  if (this.localRejected && this.fetchRemoteSecret) {
    return this.cached = await this.fetchRemoteSecret();
  }
  // ② 常规：读本机密钥
  try { return this.cached = readSigningSecret(this.dshHome); }
  // ③ 文件读不到 -> 也走远端
  catch (err) {
    if (this.fetchRemoteSecret) return this.cached = await this.fetchRemoteSecret();
    throw err;
  }
}

invalidate() {          // 服务端 401 后调用
  this.cached = null;
  this.localRejected = true;   // ← 关键
}
```

已加**回归测试**（`test/dsh-monitor.test.ts` 里的
`★ 回归：本机密钥被服务端拒绝后，下一次必须走远端兜底`），
注释里写明了这个 bug 的来龙去脉，防止以后被"简化"掉。

---

## 五、全链路实测（7/7）

`scripts/d5-tunnel-check.mjs` —— 真 DshMonitor → 真本机密钥（必然 401）
→ 真 ssh 子进程 → 真远端密钥 → 真 HTTP 打到隧道端口：

```
=== 第一轮：本机密钥必然 401，应触发远端兜底 ===
  第一轮结果：ok=false code=auth/unauthorized
  ✅ 第一轮确实以认证失败告终（本机密钥对隧道不适用）
  ✅ 失败类型是 auth/unauthorized（不是网络/协议错）

=== 第二轮：应已换成远端密钥并成功 ===
  第二轮结果：ok=true status=running 会话数=63
  ✅ 第二轮成功（远端密钥生效）
  ✅ 拿到了会话数  (63)
  ✅ 聚合态是合法七态之一  (running)

=== 第三轮：缓存生效，不该再跑 ssh ===
  ✅ 第三轮仍然成功（用的是缓存的密钥）
  ✅ 缓存生效：没有第二次 SSH 取密钥  (取密钥日志次数 1 -> 1)
```

上报状态序列：

```
status=failed   轮询失败（auth/unauthorized）：401 —— 密钥与该实例不匹配
status=running  dsh 127.0.0.1:13080：63 会话，3 个活跃
status=running  dsh 127.0.0.1:13080：63 会话，3 个活跃
```

**63 个会话**来自远端主机 —— 这是"多端口监控能真的用起来"的直接证据。

---

## 六、质量关卡

| 关卡 | 结果 |
|---|---|
| `tsc` × 3 份配置 | **全部 exit 0** |
| `vitest run` | **407 passed × 2 次连续** |
| `scripts/d5-tunnel-check.mjs` | **7/7（真 SSH + 真远端）** |
| `scripts/d2-arbitration-check.mjs` | **10/10** |
| `scripts/live-dsh-check.mjs` | **真实 dsh 打通** |
| `scripts/verify-strip-visual.mjs` | **17/17** |
| `scripts/smoke-e2e.js` | **全部通过** |
| `scripts/check-dsh-config.mjs` | **0 警告** |
| `lamp/probe/integration-test.mjs` | **22/22** |

测试数字对账：`387（上轮）+ 17（remote-auth）+ 3（回归等）= 407` ✅

---

## 七、完成度：11 项设计决策全部完成

| 决策 | 状态 |
|---|---|
| D1 置顶浮窗 | ✅ |
| D2 状态采集（含混合仲裁） | ✅ |
| D3 扩展项目 | ✅ |
| D4 端口发现 | ✅ |
| **D5 远端鉴权** | ✅ **本轮完成** —— SSH 取远端密钥 + 401 自动降级 + 全链路实测 |
| D6 聚合粒度 | ✅ |
| D7 插件 | ✅ |
| D8 采集方式 | ✅（`session/follow` 订阅流未试，属可选优化） |
| D9 灯排布 | ✅ 视觉验收 17/17 |
| D10 浮窗交互 | ✅ |
| D11 通知策略 | ✅ |

**唯一剩下的"活"是上线动作，不是功能缺口**：
把 `lamp/plugin` 装进真实 dsh web 并重启 3080（需你同意，会把你踢下线几秒）。

---

## 八、配置示例已更新

`config.dsh.example.yaml` 的示例 B 从"默认关（因为拿不到状态）"改为
**默认开**，并写明 D5 的三轮流程：

```yaml
  - id: dsh-13080
    name: dsh @ 13080（SSH 隧道）
    enabled: true
    monitor:
      type: dsh
      authority: "127.0.0.1:13080"          # 本地隧道端口，不是远端的 3080
      sshHost: "user@your-host"    # 配了它就会自动去远端取密钥
```

并说明：**不配 sshHost 时**本机密钥会一直 401、灯先 failed 再转 unknown ——
那是**有意的诚实行为**，而不是假装它不存在或错误显示成绿色。

---

## 九、复现

```powershell
cd D:\Projects\lamp\ai-task-indicator

# 类型检查（三份都应 exit 0）
node node_modules/typescript/bin/tsc -p tsconfig.json          --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.test.json     --noEmit

# 全量测试（应 407 passed）
node node_modules/vitest/vitest.mjs run

# 先 build 再跑各条实测链
node node_modules/typescript/bin/tsc -p tsconfig.json
node scripts/d5-ssh-probe.mjs        # 纯 SSH 通路探测（硬超时）
node scripts/d5-tunnel-check.mjs     # D5 全链路（401 -> SSH -> 200）
node scripts/d2-arbitration-check.mjs
node scripts/live-dsh-check.mjs
node scripts/verify-strip-visual.mjs
node scripts/smoke-e2e.js
node scripts/check-dsh-config.mjs
```
