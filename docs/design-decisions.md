# 多端口 dsh 指示灯 · 设计决策（全部确认）

> 来源需求：`04-SPEC.md`（AI 任务状态指示灯 · 需求规格说明，sha256 `9FE8971B…EFCCB`）
> 参考同项目：`05-NEXT-PROMPT.md`、`01-PRD.md`、`02-ARCHITECTURE.md`
> 决策日期：2026-10-13 · 状态：**11 项决策全部确认，等待开工指令**

---

## 一、本次需求相对旧文档的变化

旧文档假设：*在 `ai-task-indicator` 新增 `type: http` 轮询监控，url 指向
`http://127.0.0.1:13080/api/sessions`，动手前要先问用户拿 token 和状态字段。*

本次实际需求：**置顶浮窗，监控多个 dsh web 进程端口**（不是浏览器内嵌插件）。

| 旧文档的阻塞点 | 现状 |
|---|---|
| 要问用户拿启动 token | **已不需要** —— 密钥明文存盘，可离线自签 cookie（实测 200） |
| 要问哪个接口有状态 | **已找到并跑通** —— `POST /api/session/list` |
| 单实例 | **多端口**，含 SSH 隧道到远端 |
| `13080` 当成本机第二个实例 | 实为 **SSH 隧道** → `user@your-host` 的 dsh web |
| 以为 `pendingInteraction` 能轮询到 | **拿不到**（关键词扫描 0 命中）→ 必须 dsh 侧插件补 |

---

## 二、11 项决策

### D1 · 交付形态 = 置顶浮窗，监控多个 dsh web 端口
**不是** dsh 客户端插件：浏览器插件只能看见自己那个页面，物理上无法监控另一个 dsh web 进程。

### D2 · 状态采集 = 混合
- **(a) 外部轮询打底，零侵入 dsh**
  认证：`~/.dsh/.credentials.yaml` 的
  `records["client-connection/browser-session"].payload.secret` 是**明文 32 字节密钥**，
  可离线自签 `dsh-auth-<sha256(authority)>` cookie —— **实测 3080 返回 200**。
  接口：`POST /api/session/list`（`args = { "_request": {} }`）
- **(b) dsh 侧插件增强** —— 补 `pendingInteraction`（等待批准/回答/审计划）真值。
- **降级铁律**：(b) 不可用或超时 → 该实例自动退回 (a)，绝不因为缺精确信号就停灯。

### D3 · 代码落点 = 扩展现有 `ai-task-indicator`
路径：`D:/Projects/lamp/ai-task-indicator`
复用：七态状态机 + 转移表 + 三条不变量、`monitors/base.ts` 抽象与错误隔离契约、
webhook 型监控、托盘、置顶悬浮窗（`overlay.ts`）、任务面板（`panel.ts`）、通知、跳转降级链。
新增：**「dsh 多端口」型监控器** + 多实例聚合。
不重踩 `04-SPEC.md` §六 已修的坑（`as never` / `(?i)` / YAML 跨行 `match` / 只 mock 不真实 IO / 改完不验 dist）。

### D4 · 端口发现 = 自动发现 + 手动覆盖
枚举 `127.0.0.1` 监听端口 → 探测是否 dsh web（`GET /` 返回 dsh 的 index.html）→ 入列表；
配置可追加显式条目（带稳定 `id`/`name`）与 `exclude`，手动条目优先。

### D5 · 远端实例鉴权 = 自动 SSH 取远端 secret
本机实例读本机 `.credentials.yaml`；隧道实例走 SSH（已具备 `BatchMode=yes` + `id_rsa` 条件）
取远端 `~/.dsh/.credentials.yaml`，在**本地**为 `127.0.0.1:<隧道端口>` 签 cookie。
配置形如 `sshHost: user@your-host`。secret 持久化 → 跨重启有效。
**实测反例**：用本机 secret 签 13080 必然 401 —— 这是识别"远端实例"的可靠信号。

### D6 · 聚合粒度 = 每端口一盏灯并列 + 一盏总灯
```
◆ 总灯
● 3080
● 13080
   …
```
悬停/点击展开：逐端口 → 逐会话 → 子代理明细（沿用 `panel.ts` 行模型）。

### D7 · 插件回传通道 = 复用现有 webhook 服务 ✅ **已验证成立**
插件在 **host 侧监听 cordis 事件** → POST 到浮窗已有的 webhook 服务
（`127.0.0.1:17890`，401/400/404 与 loopback 安全均已实测）。
**零新传输代码、零新端口**，天然支持每实例一个 hook path。

> ⚠️ 原先的表述"插件进程内读 `uiSession.sessionStatus`" **是错的**（我已更正）：
> `uiSession` 是**客户端**服务。正确做法见 `probe-report-host侧等待态.md`：
> 三个等待类型在 **host 侧都有真实事件**，插件直接 `ctx.on` 即可，
> **且不依赖浏览器页面开着**。

host 侧可用事件（全部取自官方"转发白名单"与 typert 生成签名）：

| 事件 | 签名 | 用途 |
|---|---|---|
| `approval/request` | waterfall，带 `agent` | ★ 等待批准（begin/resolve 两个时刻） |
| `user-questions/request` | waterfall，带 `agent` | ★ 等待回答；`intent.kind==='plan-review'` 即等待审计划 |
| `api-session/status` | `(sessionId, running: boolean)` | ★ `running` 由 host 主动推送 |
| `api-session/activity` | `(sessionId, updatedAt: number)` | 精确最后活动时刻 |
| `api-session/added/removed` | `(summary)` / `(sessionId)` | 会话增删 |
| `api-session/error` | `(sessionId, message: string)` | ★ 直接对应 `failed`，不必再靠静默推导 |
| `goal/activation-changed` | — | goal 状态变化 |

### D8 · 采集方式 = 事件驱动优先，订阅流次之，轮询兜底
1. **host 插件事件推送**（装了的实例走这条，最实时）
2. `session/follow` 订阅流（插件没装时）
3. 轮询 `session/list`（兜底对账），接旧项目退避序列 `1s/2s/4s/8s/16s`，
   连续失败 5 次 → 该实例 `unknown`

### D9 · 灯排布 = 紧凑竖排，14px 小灯 + 端口号标签
每行 `●3080`（灯 + 等宽字体端口号），行距紧凑；总灯最大、置顶分组。整窗约 **70×120**。
配色沿用既有语义：蓝=运行中（呼吸）、黄=等待授权（快闪）、绿=完成、红=失败、
青=启动中、灰=空闲、深灰=失联。

### D10 · 浮窗交互 = 可点击 + 可切换「锁定/穿透」
默认可点击（展开明细 / 跳转）；托盘菜单提供"锁定/穿透"开关，锁上后完全不吃鼠标。
沿用旧项目 `focusable:false` 免激活特性，点击不抢焦点。

### D11 · 通知 = 只通知三个关键态，文案带端口
只在进入 `waiting` / `failed` / `success` 时弹窗 + 提示音（可分别静音）；
文案带端口号与实例名。`running`/`idle` 等高频态**不通知**，从根上避开多端口刷屏。
沿用旧项目 30s 同任务去重（显示 `×N`），去重键 = `<实例id>:<状态>`。

---

## 三、沿用旧项目的状态语义（不改）

七态：`idle` `starting` `running` `waiting` `success` `failed` `unknown`
聚合优先级：`failed > waiting > running > success > starting > idle > unknown`

三条不变量（`04-SPEC.md` §4.2，**不许破坏**）：
1. `failed → success` 禁止
2. `unknown → success` 禁止
3. 非法转移记日志但拒绝

两处已放宽（§4.3，改动前先读代码注释）：`waiting → success`、`failed → running/waiting`。
跨行判定优先级（§4.4）：`failed` 一票否决；非 failed 之间看最后一条。

---

## 四、状态判定输入（外部可观测 → 七态）

| dsh 外部可观测信号 | 判定 |
|---|---|
| `running === true` | `running` |
| `running === false && agentAvailable === true` | `idle` |
| `plan.pending === true` | `waiting`（近似） |
| **插件上报 `pendingInteraction`** | `waiting`（**真值**，D2b/D7） |
| `inbox["next-turn"] / ["next-step"]` 非空 | `starting` |
| `subagentCatalog` 有条目 / `subagentTiming` | 计入 `running` 明细 |
| 401 / 拒绝连接 / 连续失败 5 次 | `unknown` |
| `permissions.currentValue` | 明细展示（如 `danger-full-access`） |
| `contextPressure` / `tokenUsage` | 明细展示 |
| 完成 / 失败 | 结合 `sessionStats`、`turnOutline` 尾部、`updatedAt` 静默时长推导 |

`session/list` 单个 item 实测字段（本会话）：
`sessionId, updatedAt, agentAvailable, running, blank, cwd, parentSessionId, origin, projections.values{title, goal, tokenUsage, contextPressure, contextBreakdown, inbox, sessionStats, turnOutline, permissions, todos, plan, subagentCatalog, subagentTiming, subagent, modelSelection, sessionListMetadata, agentPreset, imageLimits}`

---

## 五、证据与探针

| 产物 | 路径 |
|---|---|
| 实测报告（认证 / 协议 / 端点 / 字段） | `lamp/docs/probe-report-外部监控可行性.md` |
| 自签 cookie 绕过 401 | `lamp/probe/auth-probe.mjs` |
| 129 个 RPC 端点提取 | `lamp/probe/extract-endpoints.mjs` |
| 实时状态实测 | `lamp/probe/status-probe.mjs` |
| 等待态信号搜索（0 命中，关键负面结论） | `lamp/probe/interaction-probe.mjs` |
| projections 参数形状 | `lamp/probe/waiting-probe.mjs` |
| 端点 invocation/参数提取 | `lamp/probe/describe2.mjs` |

---

## 六、风险点与验证状态

| # | 风险 | 状态 |
|---|---|---|
| 1 | `session/follow` 能否用外部 cookie 走通 | ⏳ 未验；不行则直接退化轮询（D8 已兜底） |
| 2 | host 侧能否拿到 `pendingInteraction` 真值 | ✅ **已验证成立** → `probe-report-host侧等待态.md` |
| 3 | 多实例 webhook 端口冲突 | ⏳ 未验。webhook 服务只监听一个端口，多实例推不同 hook path，需确认不互相顶掉 |
| 4 | 自动发现误判 | ⏳ 未验。需用 index.html 特征串区分"是 dsh web"和"别的 HTTP 服务" |
| 5 | 第三方 host 插件能否在 scoped 事件上注册 | ✅ **已验证成立** → `probe-report-scoped事件可观察性.md`。用 `ctx.on(ev, fn, { global: true })`，官方范式（`dsh-hook-protocol`），无需逐 Agent 取作用域 |
| 5b | **waterfall 短路导致观察者被 veto** | ✅ **已发现并修正** → `probe-report-host插件实测.md`。**必须 `prepend: true`**，否则真实 dsh 下插件静默失效（应答者先注册且直接返回，后续监听器全被 veto）。修法 5/5 实测通过 |
| 6 | `ApprovalService` 是否有 pending 查询面 | ⚠️ 无。插件自维护 pending 集合 + 启动快照对账 + 轮询兜底（已验证的负面结论，方案已定） |
| 7 | waterfall 里 `next().finally()` 时序 | ✅ **已解除**。用 `Promise.resolve().then(() => next()).finally(...)`，实测结果与错误均原样透传，begin/end 双时刻均拿到（`waitedMs=[83,82,61,62]`） |
| 8 | `plan-review` 的 `intent` 确切形状 | ✅ **已钉死**。`intent` 在 `questions[].intent` 上，**不在请求顶层**；判别已实测正确识别，取不到时降级为 `question` |
| 9 | 插件本体端到端可用性 | ✅ **16/16 事件到达 hub**，13 项断言全绿 → `probe-report-host插件实测.md` |
| 10 | 装进真实 dsh web | ⏳ **待你同意**。需重启 3080（会被你正在用的实例感知到） |
| 11 | **cookie HMAC 必须用原始字节** | ✅ **已发现并修正**。曾误写成 `secret.toString('base64')`（为绕 TS 类型错误），导致"名字/格式/长度全对但一律 401"。已加防回归测试 → `round3-DshMonitor与真实打通.md` |
| 12 | **cookie 寿命受服务端上限约束** | ✅ **已修正**。服务端校验 `expiresAt - issuedAt <= cookieMaxAgeDays`；7 天对本机 3080 得 401，**1 天可通**。因每请求重签，长寿命无收益 |
| 13 | 主动采集真实端到端 | ✅ **已打通**。真 MonitorHost 监控真 dsh：`status=running`，`17 会话，1 个活跃` |
| 14 | D9 灯排布视觉呈现 | ✅ **已程序化验收 17/17**（无头 Chrome 读计算样式）：七态色值全对、竖排、总灯在上、14px 小灯、整窗 64px 宽 → `round4-多端口灯带UI.md` |
| 15 | D10 浮窗交互 | ✅ **已完成**。可点击 + `focusable:false` + **托盘「锁定浮窗（鼠标穿透）」开关**（三处同步：store/overlay/配置）。顺手修掉"切开关会重建窗口"的性能问题 → `round5-通知与锁定穿透.md` |
| 16 | D11 通知策略 | ✅ **已完成**。默认白名单本就恰好是 waiting/success/failed；补齐**文案带端口**（正文最前），文案逻辑与 electron 解耦以便单测（19 用例）→ `round5-通知与锁定穿透.md` |
| 17 | D2 混合仲裁（插件↔轮询） | ✅ **已完成**。`dsh-arbiter.ts`：按 sessionId 归位 + TTL 过期自动退回轮询近似 + `mergeExactIntoPolled` 含「failed 一票否决」保护。**全链路实测 10/10**（真 HTTP → 真 HookServer → 真 MonitorHost → 真 dsh）→ `round6-D2混合仲裁.md` |
| 18 | 纯推送型任务首条 waiting 被转移表拒绝 | ✅ **已修正（round 8），且比原先判断严重得多**。原先记为"不影响 D2 功能"是**错的**：实测证明 D2 全链路每环都对，最后 `apply` 因 `idle → waiting` 非法返回 null，**灯永远不变黄** —— 核心功能被静默打掉。之前没暴露只因碰巧有会话在 running。已放开 `idle → waiting`。**同时自我纠正**：一度也放开 `unknown → waiting`，被两个既有测试挡回（失联≠空闲，失联期间可能已崩），确认测试正确，保留原设计 → `round8-三个真实缺陷修复.md` |
| 21 | 灯带被 `.lamp-drag` 裁切 + 拖不动 | ✅ **已修**。`.lamp-drag` 按单灯算尺寸（44×44），灯带 118.5×93 塞进去被居中溢出裁掉，且只有中间能拖。加 `body.strip-mode` 覆盖为 100%×100% |
| 22 | 画布尺寸小于内容 | ✅ **已修（两轮）**。第一轮：实测灯带自然 118.48×93，窗口只有 88 → 上下各裁 3.5px；把公式抽成 `overlay-layout.ts` 纯函数并**用实测反推常量**。第二轮（用户仍看到不完整）：真正原因是 **`box-shadow` 画在 border box 之外** —— 窗口底边距只有 2px 而投影向下 5px，且 `.strip-rows` 是 `overflow-y:auto` 滚动容器会裁掉子元素阴影。修法：`.strip-rows` 加 `padding: 6px 0` + `STRIP_SHADOW_PAD_Y: 8→12`。**并给验收脚本补上"投影是否被裁"这一维度**（原来只检查边界框，所以漏了） |
| 27 | 验收脚本自身的盲区 | ✅ **已修**。`measure-live-lamp.mjs` 原先只检查 `getBoundingClientRect` 在窗口内 —— 元素都在窗口内，但**投影被切**，于是它报"✅ 布局无问题"而你仍看到缺陷。现解析每条 `box-shadow` 的偏移/模糊/扩散，算出含投影的实际占位并计入失败 |
| 28 | 测试里的 CSS 解析器两个盲区 | ✅ **已修**。①注释里的 `}` 让"截到第一个 `}`"提前截断（给 `.strip-rows` 加注释后 padding 读不出来）；②`padding: 6px 0` 第二个值不带 `px`，正则太严。两次都是**解析器的错、不是被测代码的错** —— 这类"测试基础设施自己有 bug"极易被误读成产品缺陷 |
| 29 | ★ 圆点**左侧**被割掉（横向裁剪） | ✅ **已修**。同一个机制（overflow 容器的 box-shadow 裁剪）我在 round 8 修了垂直、漏了水平：`.strip-rows` 写的是 `padding: 6px 0`，左右为 0 → 圆点距裁剪边 0，而阴影向左外扩 4px 必然被切。实测铁证：`strip-dot 距左=0，阴影超出左 4px`。修法：`padding: 6px`（四向）+ `STRIP_ROWS_PAD_X` 计入画布宽度。**教训：「检查了四个方向」≠「检查了所有裁剪源」—— 窗口视口与滚动容器是两层独立边界，必须分别验证** → `round9-圆点左侧被裁.md` |
| 30 | ★「监控不到 13080」实为**看不出来** | ✅ **已修（可观测性缺陷，非监控故障）**。D5 全链路重跑 7/7、远端 64 会话，证明 13080 一直在被正常监控。但监控器已产出的证据（`message` 里的 `64 会话`）在灯上**完全不可见**：行悬停只显示 `name`，tooltip 只有聚合计数。于是"连上了但空闲"与"根本没连上"长得一模一样 —— 这类"故障与正常无法区分"比真故障更消耗信任。修法：行悬停改为 `名称 · 状态 · 消息`，tooltip 增加「各端口」段 → `round10-13080可观测性.md` |
| 31 | tooltip 过滤口径与灯带不一致 | ✅ **已修**。我本想按"只列启用任务"过滤，写成 `t.enabled !== false` —— 但 `TaskState` 没有 `enabled`（只有任务级 `paused`；配置的 `enabled` 不保留在运行时状态上）。改为 `t.paused !== true`，与灯带显示口径一致 |
| 32 | ★ 进程枚举脚本**从来没成功运行过** | ✅ **已修（潜伏已久，本轮接 workbuddy 才暴露）**。两个叠加的 PowerShell 语法坑：①`buildCimScript()` 用**空格**拼多行 → 赋值与 `while` 之间无语句终结符 → `UnexpectedToken`；②改成换行后**管道跨行** → 以 `|` 开头的续行在 `-Command` 下不被当续行 → `EmptyPipeElement`（`-EncodedCommand` 同样失败，故与转义无关）。修法：**每条语句一行 + 整条管道写在一行内**。后果：长驻子进程一启动就 exit 1，重启 5 次后判"监控源失联"，灯永远不反映真实进程 |
| 33 | ★ 诊断信息被丢弃（bug 难查的根因） | ✅ **已修**。长驻子进程**只读 stdout、从不读 stderr**，退出时仅记 `exit code=1` —— PowerShell 的 `UnexpectedToken` / `EmptyPipeElement` 这些一眼能定位的信息全被扔掉，只能靠手工复现才看到真相。现在收集 stderr 尾部 500 字，退出日志带上第一行非空内容 |
| 34 | `process-enum.ts` 零测试覆盖 | ✅ **已补 19 条**（该文件此前 0 条）。含**真正拿 `powershell.exe` 解析一遍**的权威断言（文本匹配只能防已知的两种写法）。另：写测试时我自己踩了两个坑 —— 用 `\s+` 断言"不能空格粘连"时 `\s` 包含换行，把**正确**的换行拼接也判成 bug（改 `[^\S\n]+`）；以及误判 `parseTasklistPayload` 不处理多行，其实是它**正确地**过滤了 `pid<=0` 的伪进程 |
| 35 | 我自己的脆弱断言（写死任务数） | ✅ **已修**。`inspect-live-lamp.mjs` 与 `check-dsh-config.mjs` 里写死"应有 3 个任务/3 行"，加一个任务就报红 —— 那是噪声不是信号。改为动态断言，并新增"每种监控类型都有示例"的检查 |
| 23 | 窗口不随任务数增长 | ✅ **已修**。窗口在 create() 时定死，热重载加端口后不跟着变。改为 `setState()` 内调用 `fitToTaskCount()` 自校正 |
| 24 | ★ 静默判定排在 running 之后导致灯永远蓝 | ✅ **已修**。`runningSubagentCount>0` / `running===true` 先返回，于是陈旧的 running 标志或永不写 `settledAt` 的子代理条目会让灯**永远蓝色**。实测：静默 726 秒仍判 running。把静默判定提到前面，但**不盖过 waiting** |
| 25 | 两个"靠 bug 才通过"的断言 | ✅ **已修正**。`live-dsh-check` 的"非 idle"与 `d2-arbitration` 的"基线非 idle"只在旧 bug 下成立 —— 这类断言把 bug 固化成预期行为，比没有断言更危险 |
| 26 | SSH 超时 20s 偏紧 | ✅ **已放宽到 45s**。实测单次握手波动极大（~11s 到 >4min），20s 经常超时导致灯先变红再恢复 |
| 19 | D5 远端鉴权（SSH 取密钥） | ✅ **已完成**。上一轮记的"SSH 挂起阻塞"**是假阻塞** —— 问题在 PowerShell 捕获 stdout，换 Node 硬超时后首次即通（11.4s）。`SshCredentialsSource`：缓存 30 分钟、失败不缓存、硬超时可杀、复用同一解析器。**全链路实测 7/7**（401 → 自动 SSH 取远端密钥 → 200，拿到远端 **63 个会话**）→ `round7-D5远端密钥打通.md` |
| 20 | ★ 401 后兜底未触发的设计 bug | ✅ **已发现并修正**。兜底原只挂在「读本机文件失败」分支，但真实情况是本机文件**读得到**、仅**服务端不认**（401），于是永远走不到远端。修法：新增 `localRejected` 标志，把「文件读不到」与「密钥被拒」分开。已加回归测试 |
| 36 | WorkBuddy 没任务却亮蓝灯 | ℹ️ **非 bug，是 `process` 型的语义**。`process.ts` 的设计是「匹配到进程 -> 持续存活 -> running」，即**进程生命周期**而非**任务执行**。只要 WorkBuddy 开着（Electron 常驻）就报 running —— 蓝灯表示"活着"，不是"在干活"。**换 `log` 型可拿到任务语义**：`%USERPROFILE%/.workbuddy/logs/automation.log` 里有成对的 `run start:` / `run finished: …success=true\|false`，配合 `idleAfterSilenceMs` 静默转 idle（logfile.ts 已支持）。代价：失去「进程崩溃 -> unknown」的监测（常驻应用崩溃时曾报过 unknown，是有用信号）。**待用户选择换/并存** |
| 37 | ★ 浮窗只显示"活着的" | ✅ **已实现**。产品原则（用户提出）：「如果没活着就没必要显示在浮窗里面了，既然能存在浮窗里面，那么就应该是活着的」。规则：隐藏 `unknown`/`failed`，保留其余五态（**含 `idle`** —— dsh 端口空闲时仍要能看到"它在"）；可显示行数 < 2 时缩成单灯；所有监控型统一。新增 `shared/visibility.ts` 作单一来源；`Snapshot` 增 `displayTasks`（主进程过滤好，因渲染层是 classic script 无法 import）与 `hiddenCount`。**不变量：隐藏 ≠ 掩盖** —— 被隐藏的行仍参与总灯聚合 → `round12-只显示活着的.md` |
| 38 | ★ `[hidden]` 属性被 CSS 覆盖，根本不起作用 | ✅ **已修（潜伏已久，本轮首次暴露）**。浏览器默认 `[hidden]{display:none}` 优先级极低，被 `.lamp-strip{display:flex}` 覆盖 → `lampStrip.hidden=true` 藏不住灯带。以往只有"≥2 任务→显示灯带"一条路径故未暴露；首次需要隐藏灯带时立刻显形（窗口已缩成 52x52，里面还画着灯带）。修法：`[hidden]{display:none !important}` |
| 39 | ★ 热重载同步不到 `enabled` | ✅ **已修**。`syncTasks` 把 `existing.paused = !cfg.enabled` 写在 `if (nameChanged)` 分支里 → 「名字没变、只把 yaml 的 enabled 改成 false」这个最常见操作同步不到 store → 配置禁用了但浮窗那行还在。改为两条独立判断 |
| 40 | ★ `task.paused` 被当成两个意思用 | ✅ **已修**。它同时表示「运行时暂停」（托盘）与「配置 enabled」——语义完全不同，是 bug 39 的深层原因。给 `TaskState` 加独立 `enabled` 字段；顺带修正一个既有测试（它断言 `paused === true`，把错误设计固化成了预期行为） |
| 41 | 我自己的两个诊断错误 | ✅ 已修。①inspect 脚本把单灯容器写成 `lamp-single`，实际 id 是 `lamp-core` → `singleVisible` 恒 false，一度误判成"单灯也没显示"；②用 `\s+` 断言"不能空格粘连"时 `\s` 包含换行，把正确的换行拼接也判成 bug |
| 42 | ★ WorkBuddy 语义统一（用户最终定义） | ✅ **已实现**。语义：**蓝 = 有任务在跑；灰 = 进程在但没任务；隐藏 = 进程没在**。信号源确定为 `workbuddy.db` 的 `sessions` 表（`status` + `last_activity_at`）—— 日志路线已排除（`automation.log` 一个月只 1 次 `run start`；`main.log` 全是 HeapTrim/PerfMetrics 噪声） |
| 43 | ★★ 只看 `sessions.status` 会永远亮蓝 | ✅ **已在判据中规避**。真库里有 `status='working'` 但 `last_activity_at` 已静默 **20 小时**的**遗留记录**（异常退出没回写）。故判据必须**两条件同时成立**：`status=activeStatus` **且** `now-last_activity_at <= activeWithinMs`。实测 `activeCount=2, freshActiveCount=0` → 正确判灰。另：该字段**大小写不统一**（同时有 `terminated`/`Terminated`），比较必须 `lower()` 归一化 |
| 44 | ★ Electron 内置 Node 没有 `node:sqlite` | ✅ **已绕开**。实测 Electron 33.0.0 内置 **Node 20.18**，`require('node:sqlite')` 直接 `No such built-in module`（该模块要 Node 22.5+）。改为 **spawn 系统 `node.exe`** 读库（与 `process` 型 spawn PowerShell 长驻枚举器同范式）。代价：依赖系统装 Node ≥22.5，可用 `NODE_BINARY` 覆盖；未装时优雅降级（连续失败转 unknown = 隐藏该行），不崩 |
| 45 | 排除的两条替代路（都没有硬赌） | ℹ️ 已排查。①WorkBuddy 本地 IPC = 命名管道 `\\.\pipe\wbipc-…` + ticket（**协议未知**）；②本地 HTTP 端口 18488/50304/50305 **有服务但一律 404（API 未知）**。都不适合赌，故选数据库路线 |
| 46 | ★ 示例配置丢掉 `process` 型示例（真回归） | ✅ **校验器抓到并已修**。把 workbuddy 从 process 改成 sqlite 后，`check-dsh-config.mjs` 立即报「每种监控类型都有示例（dsh/webhook/process）→ 实际 (dsh, webhook, sqlite)」。已补 `enabled:false` 的 `process-demo` 示例（演示两种匹配规则 + fallbackLog），断言升级为「四种类型都有示例」+「workbuddy 的 sqlite 配置（含闸门）被保留」+「process 示例仍在」 |
| 47 | ★ SQL 是字符串拼的，类型检查证明不了它能跑 | ✅ **已加真库哨兵** `scripts/sqlite-monitor-check.mjs`：用真实 `buildQueryScript` + 系统 node 查**真实 workbuddy.db**，13/13。类型检查只说"代码自洽"，它说"这段 SQL 在你机器上是对的"。顺带防注入：状态值与路径都走 `JSON.stringify`（有测试验证含引号的值拼出的脚本仍能被 `new Function` 解析）；查询用 `readOnly: true`，绝不写用户的库 |
| 48 | ★ 任务执行完直接变灰，丢掉提醒效果（用户报告） | ✅ **已修**。原判定只有三档，而**灰色同时表示两件事**：「进程在但没干活」与「刚做完一件事」—— 于是"刚做完"这个你最想看到的信息被吞掉了。新增 `success`（绿）档：有新鲜活跃 → 蓝；**刚有会话完成 → 绿**（`holdSuccessMs` 默认保持 10 分钟，可设 0 关掉）；其余 → 灰。**`running` 必须优先于 `success`**（否则连跑两个任务时灯停在上一个的绿上，看不出当前在干活）。实测绿灯还带 `anim-flash-once` 闪一下 → `round14-完成提醒绿灯.md` |
| 49 | 判"刚完成"用 `updated_at` 而非 `last_activity_at` | ✅ 实测发现完成时会**额外刷一次 `updated_at`**，它比 `last_activity_at` 晚（实测 278ms / 3965ms），更能代表"写完完成状态的那一刻"。详情见 round14 |
| 50 | ★★ `idle -> success` 被转移表拒绝，绿灯根本不亮 | ✅ **已修（同类缺口第三次出现）**。sqlite 型在两次任务之间**一直上报 `idle`**，故"刚完成"的前一个状态必然是 `idle`；`idle: ['starting','running','waiting','failed']` 不含 `success` → `apply` 返回 null → 灯不变。**规律：转移表是按"轮询型"监控的路径写的，每加一种新范式的监控就会撞上一条本不该限制它的边**（前两次是 `idle -> waiting`、`failed -> running`） |
| 51 | ★ 两条测试刻意断言 `idle -> success` 必须禁止 | ✅ **已改断言 + 改写理由（而非悄悄翻转）**。它们的担忧（**假绿灯**）是真问题，我重新想了这条保证该由谁承担：原先靠转移表兜住"没经过 running 就不许 success"，但 sqlite 型在两次轮询（默认 5s）之间任务可能就跑完了 —— 用转移表兜等于**逼监控编造一个 running**，把架构的方便凌驾于事实之上。**改由信号源承担**：SQL 要求 `status <> working` **且** `updated_at` 刚更新过，**一个从没跑过的任务结构上不可能让 `recentlyDoneCount > 0`** —— 比转移表堵得更准。保留下来的约束：`failed -> success` / `unknown -> success` 仍禁止（PRD §4.2）；且"允许这条边"≠"会自动变绿" |
| 52 | ★★ 完成提醒改为「亮到点击」的确认水位模型 | ✅ **已实现**。用户要的形态：**执行完亮绿灯保持不动 → 点击跳转 → 熄灭**。难点是 sqlite 型**轮询**：点掉后下一轮又读到"有会话完成"，绿灯**立刻复亮**，点击等于没点。解法把"完成"建模为**单调水位**：监控报 `lastDoneAt`（非 working 会话最大的 `updated_at`），store 记 `ackedCompletionAt`，只有 `lastDoneAt > ackedCompletionAt` 才算新完成。`holdSuccessMs` 废弃（绿灯时长不再由时间决定）。**顺序要求**：`markRead` 必须在状态打回 idle **之前**记水位，否则复亮 |
| 53 | ★★ `windowTitle` 跳转对非终端窗口永远不可能成功 | ✅ **已修（潜伏已久）**。`toTerminalWindow` 的 `looksTerminal` 过滤只保留 WindowsTerminal/conhost/MobaXterm 等 —— 于是任何非终端窗口都被丢掉。实测 WorkBuddy 窗口**已被枚举到**（`Id=15860 Title='WorkBuddy' Handle=722520`）却被过滤，报"已枚举 0 个候选终端窗口"。修法：把**配置里显式声明的 windowTitle** 一并放行（用户写了标题就是明确要求按标题找）。`FocusService` 新增 `tasks` 回调读配置，热重载立即生效 |
| 54 | ★ 跳转失败时绿灯永远不熄 | ✅ **已修（我自己引入的）**。最初写成"等 focus 成功后再 mark_read"，跳转一旦失败（窗口标题变了/没配 jump/非终端窗口）`mark_read` 根本不发出去。修法：两条动作**各自独立发出** —— "点击"本身必须总能让提醒消失，不管跳转成没成功 |
| 55 | ★ `wasDone` 被捕获成首帧的值（**我自己的 bug**） | ✅ **已修**，且**纯靠实测抓出来**（逻辑读起来完全合理、类型检查毫无问题）。`stripRowCache` 会复用行节点，所以 `const wasDone = task.status === 'success'` 只在**首次创建**时求值 —— workbuddy 那行首见是 idle，于是 `wasDone` 永远是 false，怎么点都不发 `mark_read`。修法：点击那一刻从 `row.dataset['status']` 读（每轮 render 都会同步）。**教训：留在仓库里的 `verify-ack-click.mjs` 是唯一能发现这类问题的手段** |
| 56 | ★★ `AppActivate` 无法恢复最小化的窗口 | ✅ **已修（实测拿到决定性结论）**。`WorkBuddy hwnd=722520 IsIconic=True`（最小化）→ `AppActivate('WorkBuddy')` 与 `AppActivate(15860)` **都返回 False**；而 `ShowWindow(SW_RESTORE)+BringWindowToTop+SetForegroundWindow` **返回 True 且前台真的变成 WorkBuddy**。另外撞上 Windows **前台锁**：后台进程直接 `SetForegroundWindow` 返回 False，需 `AttachThreadInput` 挂到当前前台线程绕开。改后降级链：Win32 主 + `AppActivate` 兜底（供 `Add-Type` 被安全策略拦的环境）。⚠️ **判定依据必须用 `GetForegroundWindow()` 的真实结果**，不能用 `SetForegroundWindow` 返回值（前台锁下会误报失败） |
| 57 | POC 记的"沙箱里 Add-Type 被禁"是否适用于本项目 | ✅ **实测不适用**。在 Electron 主进程 spawn 的 PowerShell 里 `Add-Type` 内联编译**可用**（`setOk=True`，前台确实切换）。所以 Win32 可作主方案；但仍保留 `AppActivate` 兜底以防别的环境被拦 |
| 58 | ★★ 灯带行**点不动**（用户报告） | ✅ **已修**。根因：`.lamp-drag` 覆盖整窗且是 `-webkit-app-region: drag`（整块当标题栏拖窗口），**在 drag 区域里鼠标事件被 OS 用于拖窗、不派发给子元素** → 行上的 click 监听永远收不到事件。`.lamp-core` 当初**专门**用 `no-drag` 挖出来过（注释就写着"否则点击会被 drag 吃掉"），**灯带行漏了这一步**（`cursor: pointer` 是从没兑现的承诺，代码里还留着"后续接点击跳转"的注释）。修法：`.strip-row { -webkit-app-region: no-drag }` —— **只挖行本身、不挖容器**，行间距与内边距仍属 drag 区，窗口照样能拖 |
| 59 | ★★ 我的验证脚本为何没抓到 bug 58 | ✅ **已修验证方法，这是本轮最值得记的一点**。`verify-ack-click.mjs` 之前报 4/4 全绿，但它用 `element.click()` 派发**合成事件** —— **合成事件绕过命中测试**，完全不经过 `app-region` 判定，所以行被 drag 覆盖时它依然"点得动"。修法：①新增 `getComputedStyle(row).webkitAppRegion === 'no-drag'` 断言；②新增 `document.elementFromPoint(中心点)` 断言命中自己；③点击改用 CDP `Input.dispatchMouseEvent` 真实鼠标事件。**教训：合成事件不能用来验证"用户能不能点到"；逻辑对 ≠ 用户能用** —— 上一轮 bug 55（闭包捕获首帧值）是同一类问题的近亲 |
| 60 | ★★ 悬停文字提示太乱（用户报告） | ✅ **已移除**。提示有**两个来源，缺一不可**：①`entry.row.title = describeTask(...)`（系统小黄条）；②**CSS `:hover` 规则** `.lamp-stage:hover + .lamp-tooltip { opacity: 1 }` —— **只看 JS 发现不了后者**（JS 只写 textContent）。若只删 JS，tooltip 会变成空白块仍照弹。已删 `describeTask`/`applyTooltip`/title 赋值/hover 规则。元素改名 `.lamp-tooltip` → **`.lamp-toast`** 保留（`onToast` 还用），改单行截断。**明细没丢**：`message`（含会话数）在面板里显示。`inspect-live-lamp.mjs` 断言**反向**写（悬停必须为空）以锁住别加回来 |
| 61 | ★ `d5-tunnel-check.mjs` 间歇性崩溃（退出码错但断言全绿） | ✅ **已修**。现象：`✅ 7 项` 先打印，随后 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c`，exit `-1073740791`（0xC0000409）。连跑三次 = **崩、过、过**；崩的是**退出那一步**（`process.exit()` 把还在关句柄的 SSH 子进程强杀）。修法：改 `process.exitCode` 让 Node 自然排空 + `unref()` 兜底定时器强制收尾 → **连跑 4 次全 exit=0**。⚠️ 危害：CI 里用 `$LASTEXITCODE` 判成败会**误报失败**，且间歇性出现容易被当成"环境抖动"忽略 |
| 62 | `verify-ack-click.mjs` 不可重复运行 | ✅ **已修（明确检测 + 礼貌报错，不自动改配置）**。第二次跑必然失败，因为点击成功后确认水位已记下、同一个完成不会再亮 —— 是**设计使然**不是回归。我一开始想让它自动造状态（写临时库+改配置），但动配置文件的风险大于收益。改为检测到非绿灯时打印原因与重启命令，**退出码 2** 专表"前置不满足"，与"验证失败（1）"区分，CI 里能一眼分辨环境问题与真失败 |
| 63 | ★★ dsh 端口点击"不行"（用户报告） | ✅ **已修 —— 原因是能力缺失，不是 bug**。`JumpConfig` 只有 `terminal`/`cwd`/`logFile`，**没有一个能表达"打开这个网址"**。dsh 是 Web 服务、界面是 `http://127.0.0.1:3080`，而只配 `cwd` 时降级兜底是 `explorer.exe <cwd>`（弹资源管理器）→ 点了到不了界面，看起来像"点不动"。而 workbuddy 能跳是因为它是**桌面程序、有窗口可聚焦**。**新增 `jump.openUrl`（新的一级 L0，优先级最高）**：显式网址就是最明确的意图，不必再试聚焦/开目录。用 `rundll32 url.dll,FileProtocolHandler`，URL 作为**独立 argv 元素**传入（不过 shell），有防注入测试 |
| 64 | ★ `openUrl` 必须限协议（安全边界） | ✅ **已实现白名单：只接受 http/https**。该值最终交给系统"打开"，不限协议就能写 `file:///C:/…/calc.exe` 或 `ms-settings:` 触发任意协议处理程序 —— **任务配置不是可信输入**（可能来自别人分享的示例文件）。另修一处噪声：空字符串原本会告警，但 YAML 里留空 key 很常见，为它刷警告会让"警告"信号变廉价 → 改为静默跳过 |
| 65 | ★ 我写错的一条断言（`http:/broken`） | ✅ **改断言而非改代码**。我原以为 `http:/broken` 是非法 URL 应拒绝；实测 `new URL('http:/broken')` **成功**，protocol 为 `http:`（WHATWG 把单斜杠当路径分隔容错，规范化为 `http://broken/`）。所以接受它是对的 —— 我把断言改成记录这个事实，**没有改代码去迎合错断言**（那是把 bug 固化进预期行为） |
| 66 | ★ 点击到底带了哪个 taskId（可观测性） | ✅ **已加明确日志钉死**。之前日志里出现"点 dsh 行却激活 WorkBuddy"的可疑记录，无法判断是点击带错 taskId 还是更早的遗留。现在 `focus_terminal` 分支会打印 `聚焦请求：任务 <id>`，实测三行各自带**正确** taskId（那条是遗留日志）。**下次再出"点了没反应/点错"，第一手证据就在日志第一行** |
| 67 | ★★ 点击是"新增页面"而非"跳转页面"（用户报告） | ✅ **已实现 `jump.openUrlTitleMatch`**。`openUrl` 的语义本就是"打开"，于是每点一次多一个标签页。新增可选字段：点击时先按它找**已开着的浏览器窗口**（Chrome 标题是 `<页面标题> - Google Chrome`，页面标题子串即可匹配）→ 找到就切前台**不新开**；找不到才用 `openUrl` 新开 |
| 68 | ★ 语义顺序我一开始写反了 | ✅ **已纠正**。第一版写成"先按标题找，找不到就不开" —— 那是错的：若目标页没开，我们**必须**开它，否则点击等于没有效果。正确语义是「**URL 总是要打开的**；titleMatch 只是让我们在"它已经开着"时不重复开」→ `round19-切换而非新增页面.md` |
| 69 | ★「非终端窗口被过滤」第二次踩坑 | ✅ **已修**。`toTerminalWindow` 的 `looksTerminal` 过滤会把 Chrome 窗口丢掉（它不含任何"终端"特征）→ titleMatch 永远匹配不到 → 退化成"每次新开"，**功能看起来完全没生效**。修法同 round 15（WorkBuddy）：把配置里显式声明的片段一并放行，`acceptedTitlePatterns()` 现在收集 `terminal.match` 与 `openUrlTitleMatch` 两个来源。**规律：每引入一类"非终端"跳转目标，都要记得同步放行** |
| 70 | ★ 我自己引入的点击延迟 | ✅ **已修**。第一版在判断前**无条件** `refreshWindows()` —— 要 spawn PowerShell 并编译内联 C#（实测 1~3 秒），于是每次点击都卡。改成两级：①先用已有快照匹配（常态走这条，零开销）②只有未命中才刷新一次。实测日志时间戳：收到请求 `.781` → 判定完毕 `.793`，**12 毫秒** |
| 71 | ★ 会话标题不能用来匹配（用户提供的关键信息） | ✅ **已按此调整**。用户报的两个 dsh 页面标题是 `Initial hello to coding...` / `参考STA表新增...` —— 那是**会话标题**（每次对话都不同），拿它做 `openUrlTitleMatch` 换个会话就失效。改用**稳定出现在 dsh 页面标题里的品牌名**（`DeepSeek Harness`）。**教训：匹配片段必须是"页面固有"的，不能是"当前会话"的** |
| 72 | ★★ 实测确认「切换」生效（含一次我自己的误判） | ✅ **已验证**。日志：`页面已开着，切到前台「…DeepSeek Harness - Google Chrome」（任务 dsh-3080，未新开标签页）`，且**没有** `已打开 http://…`、**没有** spawn rundll32 → 确认走切换路径。中途我一度以为失败，原因是**自己把输出截断了**（`Select-Object -First 4`）。**教训：排查时别截断证据** |
| 73 | ★★ 边界：能切到**窗口**，不能切到**标签** | ℹ️ **已确认并写进配置注释，未实现**。Chrome 窗口标题**只反映当前激活的标签**，所以 `openUrlTitleMatch` 只能保证"窗口到前台"，不能保证"切到窗口里某个标签"。精确切标签只有两条路，代价都超出"一个指示挂件"的合理范围：①Chrome 开 `--remote-debugging-port` + CDP `Target.activateTarget`（需重启 Chrome 且开放本地调试端口，任何本地进程可控浏览器）；②写 Chrome 扩展用 `chrome.tabs.update`（要装并维护扩展）。**明确告知而不是假装做到** |
| 74 | ★★ 窗口抢不到前台（用户报告"点3080没反应"） | ✅ **已修 —— 两处 API 在撒谎，必须靠对照实验才能定位**。日志一直说"已通过 Win32 激活窗口"，但用户看不到变化。做了**脱离应用**的对照实验，在"前台被别的应用占着"的条件下逐方法测：**A 直接 `SetForegroundWindow`(返回 False,前台没变,❌) / B `AttachThreadInput`+同上(False,❌) / C `AppActivate(pid)`(返回 True,前台没变,❌) / D `AppActivate(标题)`(返回 True,前台没变,❌) / E 先最小化→恢复→`SetForegroundWindow`(True,前台**变了**,✅ 唯一有效)**。两个结论：①**`AppActivate` 返回值完全不可信**（返回 True 却什么都没做）→ 成功判据必须是 `GetForegroundWindow()` 的**真实结果**；②只有「最小化→恢复」这个往返能拿到前台权限。另：触发条件是"**前台被别的应用占着**"，早先测 WorkBuddy 成功只是因为当时前台恰好是 Chrome |
| 75 | ★ 我原实现里的条件恢复缺陷（"没反应"的直接原因） | ✅ **已修**。原代码 `$wasMin = IsIconic($h); if ($wasMin) { ShowWindow($h, 9) }` —— restore **只在窗口已最小化时**触发。而"窗口正常显示但不在前台"这个**最常见**的情况 `IsIconic()` 返回 false，于是 restore 从未执行、前台抢不过来。改为**无条件**先 `SW_MINIMIZE` 再 `SW_RESTORE`，并去掉实测无效的 `AttachThreadInput` |
| 76 | ★ 观测行为本身干扰被测对象 | ✅ **已记入教训**。我一度以为 13080 的激活"成功后又失效"，差点去查是否有东西抢焦点；实际是**我自己的检查命令**（启动 PowerShell 读前台）抢了焦点。改用**后台采样**（每 0.9 秒一次）重测后，全程稳定 18 秒。**验证"窗口是否在前台"时，任何会创建窗口的操作都可能改变前台 → 要用采样而不是"查一次"** |
| 77 | dsh-13080 未配 titleMatch（"新建窗口"的原因） | ✅ **已补**。两个 dsh 端口实测在**同一个** Chrome 窗口里，所以两处用同一个 `openUrlTitleMatch` —— 点哪个都切到那个窗口、不新开 |
| 78 | ★★ 用 dsh 本地客户端彻底解决切换（用户提问引出的关键发现） | ✅ **已实现并实测**。用户问"用 dsh 客户端打开会好切换吗"—— 会，而且**本机早就在跑**：`DeepSeek Harness.exe`（pid 22980）是 Electron 桌面应用，**有真实窗口**，与 WorkBuddy 同类，不受"浏览器标题只反映激活标签"限制。实测从"锐捷云桌面"手里抢焦点成功 → `round22-用dsh本地客户端解决切换.md` |
| 79 | ★★ 一直切错窗口的根因：两个窗口标题几乎一样 | ✅ **已修（新增 `processNames` 过滤）**。本机同时存在 `DeepSeek Harness.exe`（标题 `… — DeepSeek Harness`）与 `chrome`（标题 `… — DeepSeek Harness - Google Chrome`），`openUrlTitleMatch: DeepSeek Harness` **两边都命中**，代码取枚举到的第一个（恰是 Chrome）→ 每次点击都切到浏览器。新增 `terminal.processNames`（容忍 `.exe` 后缀与大小写）精确锁定原生窗口 |
| 80 | ★★ L2-b"盲聚焦第一个候选窗口"会乱抢无关窗口 | ✅ **已修（实测抓到）**。WorkBuddy 窗口缩在托盘不可见 → 标题匹配失败 → 落到 L2-b → **把 Chrome 抢到前台**。用户看到的是"点 workbuddy 却切到浏览器"—— **夺走焦点 + 给出错误暗示，比什么都不做更糟**。修法：只在**没有**指定窗口标题时才允许盲聚焦；显式指定却找不到就老实降级到目录/日志 |
| 81 | ★ `windowTitle` 只查启动时的窗口快照 | ✅ **已修**。先开灯、后开目标程序时，快照里没有它 → 每次点击都找不到。现在未命中会刷新一次再试；快路径（已在快照里）零额外开销 |
| 82 | 灯带标签是端口号，对人不直观 | ✅ **已加 `shortLabel`**。dsh 行原先显示 `19387`/`13080`；现在可配 `shortLabel: 本地客户端` / `web 13080`。优先级：`shortLabel` > dsh 端口号 > taskId。空/空白值退回正常推导（不让灯带出现"只有圆点没有字"） |
| 83 | ★★ 两条实测链因**端口变化**而误报失败 | ✅ **已修（这是第二次同类问题）**。`d2-arbitration-check` 与 `live-dsh-check` 把 authority 写死成 `127.0.0.1:3080`，而本机 dsh 已从 3080 挪到 **19387** → 报 `transport/unreachable`。**代码没坏，是脚本在敲一个不开的门**；这种假警报浪费时间且会掩盖真回归。修法：新增 `scripts/lib/live-dsh.mjs`，从真实配置读 dsh 任务并逐个探测取第一个能通的（只探本机实例，远端/隧道要 SSH 太慢）；找不到时**退出码 2** 与"验证失败 1"区分 |
| 84 | 工作区路径合并到统一根 `D:\Projects\lamp` | ✅ **已完成（2026-10-15）**。原来分两处：dsh 侧工程在 `D:\your-project\lamp`（`src`/`hub`/`plugin`/`probe`/`docs`/`node_modules`，其中 `plugin` = `@your-scope/dsh-status-light`），桌面指示灯在 `D:\projects\ai-task-indicator`。合并后统一为 `D:\Projects\lamp\`：lamp 的 src/hub/plugin/probe/docs/node_modules 直接在根，`ai-task-indicator\` 作为子目录。**迁移要点**：①先停掉运行中的灯（4 个 electron 进程）；②同盘 Move-Item（重命名，瞬时完成，node_modules 原样跟随）；③`config.dsh.example.yaml` 里的 `cwd: D:/your-project` 与 `database: D:/your-appdata/.workbuddy/workbuddy.db` 都指向**外部**（agent 工作区 / WorkBuddy 数据库），不随迁移变动、保持不变；④迁移后在新位置复验：tsc×3 exit 0、556 测试全绿、smoke/check-config/sqlite/D2/live/D5 全通过、应用干净重启成功。⑤历史 round 文档与 probe 报告里的旧路径复现命令**已统一刷成新路径**（本行「原来分两处」里的旧路径是迁移记录本身，有意保留）|
| 85 | ★★ dsh-web 点击「新开标签」而非「切到原页面」（用户报告，D73 边界被跨过） | ✅ **已实现 CDP 精确切标签**（后被 D86 取代为扩展路线）。`openUrlTitleMatch` 只能切**窗口**（Chrome 窗口标题只反映激活标签，D73 已论证）。新增 `jump.openUrlDebugPort`（1..65535 整数，config.ts 校验）：点击时先 `GET http://127.0.0.1:<port>/json/list` 找同源 `page` target，再 `GET /json/activate/<id>` 把该标签切到前台（无论它是否激活标签）。降级链：**CDP → titleMatch → 新开**（任一步失败只降级、不抛异常）。注入式 `JsonFetcher` 使 CDP 逻辑可单测（+7 条 focus 测试、+5 条 config 测试）。**★ 补充实测（Chrome 139.0.7258.138）**：`--remote-debugging-port` 在**默认用户数据目录**下被静默忽略（stderr 报 `DevTools remote debugging requires a non-default data directory`），必须另带 `--user-data-dir=<非默认目录>`。落地 = 专用 Chrome 实例（**必须用 `Start-Process`/ShellExecute 拉起以脱离作业对象存活**，`Process.Start(UseShellExecute=false)` 会被随命令清理杀掉）；该路线只能切**专用实例**的标签，碰不到主浏览器 → 见 D86 |
| 86 | ★★ dsh-web 改用**本地 Chrome 扩展**精确切标签（用你的日常浏览器） | ✅ **已实现并真机验证**。用户明确要求"用主 Chrome 而不是独立窗口"，而 D85 的 CDP 路线被 Chrome 136+ 的硬限制堵死（只能专用实例）。改为 D73 路线②：灯侧新增 `ExtensionBridge`（`src/main/extension-bridge.ts`，固定端口 17891，长轮询）、扩展侧 `extension/`（MV3，`chrome.tabs.update`+`chrome.windows.update`，按**同源**匹配标签）。降级链：**扩展 → CDP → 标题匹配 → 新开**（只在 `openUrlViaExtension && 扩展在轮询` 时才走扩展，扩展没装则零开销直落后续）。安全：仅 loopback + 强制 `x-indicator-extension` 头（网页带自定义头会触发预检，而桥接不返回 CORS 头 → 被挡）。**投递语义踩坑（重要）**：最初"投给挂起的轮询即算送达"，但扩展 SW 随时被回收，"连接已断、服务端尚未处理到 close"的窗口里指令会**丢失**（表现为"点了没切成又新开"）；加 `canAccept` 也救不了（此时 `res.destroyed` 仍为 false）。最终改为**指令留在暂存槽直到扩展 `POST /result` 确认（至少一次投递）**——陈旧连接吞掉一次也无妨，下次轮询照样取到；代价仅是极端情况下重复执行，而切标签幂等。测试 +6（focus）+13（桥接真起 HTTP），共 590 全绿 |
| 87 | ★ 配置写回会**丢弃它不认识的字段**（版本偏斜时的坑） | ℹ️ **已确认机制，未改代码**。灯位置持久化时会把**内存里校验后的配置**重新序列化写回 YAML，于是"用户新增了一个当前版本不认识的字段"会在下一次写回时被静默抹掉。本轮实测踩到：编辑 `config.dsh.example.yaml` 加上 `openUrlViaExtension` 时，**旧构建的灯应用还活着**，它热重载后丢掉这个未知字段并在写回时一并抹除 → `check-dsh-config` 报 `openUrlViaExtension=undefined`（一度误以为是校验器或 YAML 的问题）。**规律：改配置前先确认运行中的应用与源码同版本（或先停应用）**。换成新构建后字段正常保留，已验证 |
