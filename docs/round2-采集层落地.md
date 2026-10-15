# 进展报告：dsh 采集层落地 ai-task-indicator（goal round 2）

> 本轮把设计落成**项目内的真实代码**，并跑到项目自己的质量关卡全绿。
> 日期：2026-10-13 · 结论：**采集层完成，273 测试全绿，三份 tsconfig 0 诊断，冒烟通过**

---

## 一、本轮产出（都在 `D:\Projects\lamp\ai-task-indicator`）

### 1.1 新增源码

| 文件 | 行数级 | 职责 |
|---|---|---|
| `src/main/monitors/dsh-instance.ts` | ~475 | dsh 实例访问层：credentials 解析 → cookie 自签 → RPC 客户端 → 状态判定 |
| `src/main/monitors/dsh-discovery.ts` | ~370 | 端口自动发现：两条枚举降级链 → dsh 特征识别 → 本机/隧道分类 |
| `src/shared/types.ts`（改） | +60 | 新增 `DshMonitorConfig` 类型 + `isDshMonitor` 收窄守卫，并入 `MonitorConfig` 联合 |

**零新增依赖** —— 只用 `node:crypto` / `node:fs` / `node:path` + 全局 `fetch`。
沿用架构铁律（PRD §5.1：运行时仅 `electron` + `yaml`）。

### 1.2 新增测试

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `test/dsh-instance.test.ts` | 38 | 密钥解析容错、cookie 逐字节一致、RPC 线协议、失败分类、状态判定优先级 |
| `test/dsh-discovery.test.ts` | 11 | netstat 解析、候选合并去重、本机/隧道分类、错误隔离、**真实扫描本机** |

---

## 二、质量关卡（项目自己那三道，全绿）

```powershell
# 1. 三份 tsconfig 全部 0 诊断
tsc -p tsconfig.json          --noEmit   → exit 0
tsc -p tsconfig.electron.json --noEmit   → exit 0
tsc -p tsconfig.test.json     --noEmit   → exit 0

# 2. 全量测试
vitest run                                → 13 files / 273 tests passed

# 3. 端到端冒烟
node scripts/smoke-e2e.js                 → 全部通过（1023ms）
```

### 测试数字对得上账（不是"碰巧变多"）

| | 数量 |
|---|---|
| 原项目（04-SPEC.md §7.1 记载） | 224 |
| 本轮新增 | 38 + 11 = 49 |
| 现在 | **273** |

`224 + 49 = 273` —— 说明**没有丢失任何既有用例**，也没有靠改旧测试凑数。

---

## 三、关键技术细节

### 3.1 cookie 签名必须逐字节一致，所以测试用独立实现复算

`signCookie` 是整套方案的地基：差一个字节就是 401，而 401 在 fire-and-forget
的链路上表现为"灯不亮"，极难排查。所以测试**不复用被测代码**，
而是用独立写的 `expectedCookie()` 复算一遍再比对：

```ts
const expected = expectedCookie('127.0.0.1:3080', GOOD_SECRET, bodyJson);
expect(ck.name).toBe(expected.name);
expect(ck.value).toBe(expected.value);
```

同时断言了 cookie 名只绑定 authority、签名绑定 authority+secret 这两条性质。

### 3.2 状态判定的优先级照搬 dsh 自己，不自己发明

`deriveSessionStatus` 的顺序严格对齐
`dsh-client-ui-workspace/lib/client.js:1383-1432`：

```
pendingInteraction > runningSubagentCount > running > completed > idle
```

再叠加本项目的 `failed` / `starting`。其中一条刻意的取舍：

> **没有精确信号时，不凭空判 waiting。** 宁可报 running/idle，
> 也不要为了"看起来更准"而报假黄灯 —— 假黄灯会让人白等，比不报更糟。
> 未装插件的实例走 `deriveFromListItem` 的 `plan.pending` 近似路径，
> 由调用方**显式选择**，而不是默认打开。

### 3.3 发现层必须区分本机与隧道，因为实测二者行为不同

| 用本机密钥探 | 结果 | 判定 |
|---|---|---|
| `127.0.0.1:3080` | **200** | `kind: 'local'` |
| `127.0.0.1:13080`（SSH 隧道到 your-host） | **401** | `kind: 'remote'` |

401 不是失败，而是**有效分类信息** —— 它精确地告诉我们"这是 dsh web，
但密钥不匹配"，这正是 D5（SSH 取远端密钥）要处理的集合。

真实扫描还证明了特征识别的必要性：本机 60 个监听端口里，
**51 个是别的 HTTP 服务**，全部被正确排除，没有误判成 dsh。

### 3.4 错误隔离铁律在发现层也成立

单个候选探测抛异常绝不扩散，整体仍然完成。有专门用例覆盖：

```ts
probe: async (authority) => {
  if (authority.endsWith(':1111')) throw new Error('探针炸了');
  return { reachable: true, isDshWeb: true, status: 200, hint: 'ok' };
}
// 断言：1111 被兜住，2222 仍然正常返回
```

---

## 四、本轮遇到的坑（都修了）

### 4.1 测试写法错误：`cookieFor` 被调用了 54 次而不是 1 次

**现象**：断言 `expect(seen).toEqual(['cookie-for-127.0.0.1:3080'])` 失败，
实际收到 54 个 authority。

**真因**：不是代码 bug —— `discoverDshInstances` 会**自动枚举真实端口**，
所以 `cookieFor` 合理地会被每个候选各调一次。是我的**测试假设写错了**
（误以为只会探手动追加的那个）。

**修法**：断言改成检验真正该成立的性质 ——
"每个候选都拿到与自己 authority 对应的 cookie，一个都不是 undefined"，
并额外确认目标 authority 在列表里。**没有为了让测试变绿而改产品代码。**

### 4.2 TypeScript 类型摩擦：`Buffer` 泛型不变性

**现象**：`createHmac('sha256', secret)` 报
`Argument of type 'string' is not assignable to parameter of type 'Buffer<ArrayBufferLike>'`。

**真因**：`@types/node` 22 的 `Buffer<T>` 是不变的（invariant），
与 `BinaryLike` 的期望不完全匹配。

**修法**：以 base64 字符串形式传入密钥（`secret.toString('base64')`）——
字节完全一致，绕开泛型摩擦。同时把 `base64url()` 的入参放宽到 `Buffer | string`，
因为 `JSON.stringify()` 给的是 string。

### 4.3 D5（SSH 取远端密钥）**未能验证** —— 诚实记录

本轮尝试非交互 SSH 到 `your-host`：

```powershell
ssh -o BatchMode=yes -o ConnectTimeout=8 user@your-host "echo OK"
```

**挂起超过 5 分钟无返回**，只能中止。所以：

- ❌ 尚未确认远端 `~/.dsh/.credentials.yaml` 的读取是否可行
- ✅ 但 `DshMonitorConfig.sshHost` 字段已预留，且**远端实例只做可达性探测**
  这条降级路径已经工作（`kind: 'remote'` 分类正确）

**不把它当已完成的** —— 这是下一轮要么用带超时的调用重试、要么请你确认的点。

---

## 五、完成度对照 11 项决策

| 决策 | 状态 |
|---|---|
| D1 置顶浮窗 | ⏳ 未开始（浮窗交互 D10 同） |
| D2 状态采集 | ✅ (a) 主动采集：认证+RPC+判定全部落地并实测；✅ (b) 插件推送：已落地并端到端验证；⏳ 二者的**合并仲裁**未写 |
| D3 扩展 ai-task-indicator | ✅ 已在项目内落代码，质量关卡全绿 |
| D4 端口发现 | ✅ 自动发现 + 本机/隧道分类 + 排除，实测通过 |
| D5 远端鉴权 | ⏳ **SSH 路径未验证**（字段已预留，降级路径可用） |
| D6 聚合粒度 | ✅ 会话级判定 + 聚合函数完成；⏳ 端口→总灯的 UI 呈现未做 |
| D7 插件回传 | ✅ 完成且契约对齐 |
| D8 采集方式 | ✅ 插件事件驱动 + 轮询客户端就绪；⏳ `session/follow` 订阅流未试 |
| D9 灯排布/尺寸 | ⏳ 未开始 |
| D10 浮窗交互 | ⏳ 未开始 |
| D11 通知策略 | ⏳ 未开始 |

---

## 六、下一步（按依赖排序）

1. **`DshMonitor` 适配器类** —— 把 `DshClient` + `discoverDshInstances` +
   `deriveFromListItem` + 退避心跳接进 `MonitorAdapter` 基类，
   并入 `monitor-host` 的分派。这是"能被 GUI 用起来"的关键一步。
2. **插件↔采集的合并仲裁** —— 装了插件的实例用精确值，未装的用近似值；
   插件心跳失效自动退回。
3. **浮窗 UI（D9/D10）** —— 每端口一盏 14px 灯 + 端口号，总灯置顶，
   可点击展开 + 托盘"锁定/穿透"开关。
4. **D5 SSH 取远端密钥** —— 带超时重试。
5. **D11 通知** —— 只通知 waiting/failed/success，文案带端口。

---

## 七、复现

```powershell
cd D:\Projects\lamp\ai-task-indicator

# 三份类型检查（都应 exit 0）
node node_modules/typescript/bin/tsc -p tsconfig.json          --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.test.json     --noEmit

# 全量测试（应 273 passed）
node node_modules/vitest/vitest.mjs run

# 只跑本轮新增的
node node_modules/vitest/vitest.mjs run test/dsh-instance.test.ts test/dsh-discovery.test.ts

# 端到端冒烟
node scripts/smoke-e2e.js
```
