# 历史交接提示词存档（停止作为任务指令）

> 本文为引入 specTDD 前的原始交接快照，仅保留历史。HTTP 轮询建议、未接入 dsh 的状态及索取含 token URL 的步骤均不再执行。当前任务入口见 [05-NEXT-PROMPT](../05-NEXT-PROMPT.md)。

---

# 下一步开发提示词（可直接复制给 AI 执行）

> 用法：把下面`---` 之间的内容整段复制给 AI（Claude / Codex / DeepSeek / WorkBuddy 都行）。

---

## 任务：给 AI 任务状态指示灯新增「HTTP 轮询型」监控

### 项目背景

项目路径：`D:/projects/ai-task-indicator`

一个 Electron 桌面应用，用托盘图标 + 悬浮灯显示「AI 任务现在什么状态」。
**已完成**：进程型 / 日志型 / Webhook型 三种监控、完整状态机、UI。
**待做**：新增第四种监控方式，用于对接DeepSeek Harness(dsh) 的 Web 服务。

**动手前必读**（不要跳过，否则会重踩已修过的坑）：
1. `docs/04-SPEC.md` —— 完整规格说明，含**第六节「已踩过的坑」**
2. `docs/02-ARCHITECTURE.md` —— 架构与 ADR 决策
3. `src/main/monitors/webhook.ts` —— 你要参照的最近似实现
4. `src/main/monitors/base.ts` —— 监控器抽象契约

### 目标

新增 `type: http`（HTTP 轮询型）监控：每 N 秒请求一次外部 HTTP 接口，
从响应里按 `fieldMap` 提取状态字段，驱动灯变色。

**与现有 webhook 型的关键区别**：
- webhook 型是**被动接收**（外部推给我）
- http 型是**主动拉取**（我定时去问）

### 功能要求

#### 1. 配置格式

```yaml
monitor:
  type: http
  url: http://127.0.0.1:13080/api/sessions
  method: GET                      # 可选，默认 GET
  headers:                         # 可选，用于认证
    Authorization: "Bearer xxx"
    Cookie: "session=xxx"
  intervalMs: 5000                 # 轮询间隔，默认 5000
  fieldMap:                # 从响应 JSON 提取（复用 webhook 型的语法）
    state: $.status
    message: $.message
    progress: $.progress
  # 状态映射：外部字段值 → 本应用七态之一
  stateMap:
    "in_progress": running
    "awaiting_approval": waiting
    "done": success
    "error": failed
  heartbeatTimeoutMs: 120000
```

#### 2. 必须满足的行为

- **只允许 loopback 或显式配置的 host**：`url` 若是公网地址，启动时记warning（安全考虑，见架构 §4.4）
- **认证失败要能区分**：401/403 单独记日志（"token 可能过期"），不要和其他错误混为一谈
- **响应结构要容错**：`fieldMap` 取不到字段时**不崩、不改状态**，只记debug 日志
- **必须设超时**：单次请求超时（建议 5秒），不能因为对方挂起而卡死轮询循环
- **停止时要真正停止**：`stop()` 必须取消 in-flight 请求并清定时器（幂等）
- **错误退避**：连续失败时按 `1s/2s/4s/8s/16s` 退避，恢复后重置（参照 `src/main/monitors/process-enum.ts` 的 `RESTART_BACKOFF_MS`）
- **连续失败上限**：超过 5 次判监控源失联 → 任务转 `unknown` + 托盘气泡告警（同process 型的行为）

#### 3. 错误隔离（架构铁律，不可违反）

```
单个 HTTP 监控器的任何异常绝不能扩散到主进程。
- fetch 的 reject、超时、JSON 解析失败，全部要捕获
- emit() 已内置try/catch，但你这层也要自己兜住
```

### 实现约束

- **零新依赖**：只用 Node 内置 `fetch`（Node 18+ 自带）和现有工具函数
- **不要引入 UI 框架/打包器**：本项目刻意保持零 UI 依赖
- **中文注释要说清「为什么这样写」**，尤其是降级、退避、容错这些地方
- 类型用 `strict` 模式，不许用 `as never` 逃逸类型检查（这个项目曾因它掩盖过真实 bug）

### 必须新增的测试

参照 `test/webhook.test.ts` 的风格（它有 28 个用例），至少覆盖：

1. 正常轮询：mock 一个 HTTP 服务，按 `fieldMap` 判定状态
2. `stateMap` 映射正确（含外部状态值不在映射表里的情况）
3. 401/403 → 记日志、不改状态、不崩
4. 超时 → 不阻塞下一轮
5. 响应不是合法 JSON → 不崩、不改状态
6. `fieldMap` 路径取不到值 → 不崩
7. `stop()` 幂等，且真的取消 in-flight 请求
8. 连续失败 5 次 → 转 `unknown`
9. 退避序列生效（用 fake timers 或缩短间隔）

**另需补一条配置层测试**：环境变量展开（`%VAR%` / `${VAR}` / `$VAR`）对新字段同样生效，
且**正则里的 `$1` 反向引用不能被误当变量展开**。

### 质量关卡（必须全绿才能交付）

```bash
# 1. 三份 tsconfig 全部 0 诊断
"node" node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
"node" node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit
"node" node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit

# 2. 全部测试通过
"node" node_modules/vitest/vitest.mjs run

# 3. 端到端冒烟通过
"node" scripts/smoke-e2e.js
```

⚠️ **若 vitest 报文件数忽高忽低**（如 224 vs 211），是沙箱拦截 vitest 写临时缓存的
`EPERM` 抖动，不是文件丢失。用 `--reporter=verbose` 确认失败清单，
被跳过的文件单独补跑。

### 交付时必须说明

1. 实现了哪些文件（新增 + 修改）
2. 新增测试用例数、全量测试最终数字、类型检查结果
3. **降级链与容错策略**的说明（这是本项目最看重的部分）
4. 遇到的意外与解决方式

### 别踩这些坑（都是本项目已修过的）

| 坑 | 说明 |
|---|---|
| `as never` | 会让整个对象逃出类型检查，掩盖真实 bug |
| 正则写 `(?i)` | JS 不支持该语法，会被静默丢弃 |
| YAML 里`match:` 跨行 | 折叠标量吞掉空格，正则语法坏掉 |
| 只在单测里 mock | 本项目重视真实 IO，webhook 型的测试真起了 HTTP 服务 |
| 改完不验证 dist | 改了 main 进程代码要 `npm run build`，否则跑的还是旧代码 |

---

## 附：待用户确认的信息（对接 dsh 需要）

用户实际要对接的是 `http://127.0.0.1:13080/`（dsh web），实测**所有路径需认证**：
```
/              → 401 "dsh web authentication required; reopen the URL printed by dsh web."
/api/tasks     → 401 unauthorized
```

token 在 dsh web **启动时打印到终端**，不在配置文件里（已搜过 `~/.dsh` 全部配置）。

**所以实现前需要问用户**：
1. dsh web 启动时打印的完整 URL（含 token）
2. 哪个接口能反映任务状态、字段长什么样

拿到这两条后，把 `url` / `headers` / `fieldMap` / `stateMap` 填进
`config.demo.yaml`，就能真正对接上。

**备选更快方案**：如果用户跑任务时本来就有日志落到某个目录，
直接配成 `log` 型即可（已实测跑通），无需新增功能。

---