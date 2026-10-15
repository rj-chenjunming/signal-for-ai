# 进展报告：D11 通知策略 + D10 锁定/穿透（goal round 5）

> 本轮完成 11 项设计决策中最后两项功能性工作：通知策略（D11）
> 与浮窗「锁定/穿透」开关（D10）。
> 日期：2026-10-13 · 结论：**354 测试全绿，全部关卡通过**

---

## 一、D11 通知策略

### 一个意外的好消息：策略早已是对的

读代码发现 `DEFAULT_NOTIFY_STATES` **本来就是**：

```ts
export const DEFAULT_NOTIFY_STATES: TaskStatus[] = ['waiting', 'success', 'failed'];
```

而 D11 要求「只通知 waiting / failed / success」——**完全一致**。
去重键 `key = ${taskId}:${status}` 与 D11 的「去重键 = `<实例id>:<状态>`」也一致。

所以 D11 **真正缺的只有「文案带端口」这一条**。

### 补齐「文案带端口」

多端口场景下，光看「⏸ 等待授权」你不知道是**哪个实例**在等你 ——
而"哪个实例卡住了"正是本次需求要解决的问题。所以端口放进正文**最前**：

```
┌─────────────────────────────────────┐
│ ⏸ 等待授权 dsh @ 3080                │
│ 端口 3080 · D:\your-project · 等待批准：pwsh │
└─────────────────────────────────────┘
```

正文顺序刻意固定为：**端口 → 目录 → 耗时 → 消息**（有专门用例锁定顺序）。

### 为了让文案可测，把它与 electron 解耦

`Notification` 来自 electron，单测里起不来（`notify.ts` 的 import 会拖进整个 electron）。
因此把文案逻辑抽到新文件 `src/main/notify-content.ts` —— **零 electron 依赖**，
`notify.ts` 只做转发。这样文案就能被真实断言覆盖，而不是靠读代码猜。

新增 19 个用例，重点包括：

- 端口必须出现在正文**最前**（`body.startsWith('端口 3080')`）
- 不同端口产生不同正文（多端口可区分）
- 无 `portLabel` 时**不写"端口"二字**（避免出现「端口 undefined」）
- 正文顺序：端口 → 目录 → 耗时 → 消息
- `count > 1` 追加 `×N`（与 30s 去抖计数衔接）
- `durationMs = 0` 时不写耗时
- 负数时长按 0（防脏数据渲染出 `-1:-1`）
- 白名单默认恰好三态；高频态不在其中；用户仍可显式加回（配置优先，不锁死）

---

## 二、D10 锁定/穿透

### 现状：字段与行为早就有，只差菜单入口

- `LampSettings.clickThrough` ✅ 早已存在
- `OverlayWindow` 早已调用 `setIgnoreMouseEvents(true, { forward: true })` ✅
- **托盘菜单没有入口** ❌ ← 本轮补上

### 补齐

托盘右键菜单新增：

```ts
{
  label: '锁定浮窗（鼠标穿透）',
  type: 'checkbox',
  checked: snapshot.clickThrough,
  click: (item) => this.callbacks.onToggleClickThrough(item.checked),
}
```

为此 `Snapshot` 新增 `clickThrough` 字段（只暴露这一个，而不是整个 `LampSettings`
—— 托盘用不到尺寸/透明度）。

### 三处必须同步（否则会出难查的 bug）

`toggleClickThrough()` 一次性更新三处：

| # | 更新对象 | 漏了会怎样 |
|---|---|---|
| 1 | `store.setClickThrough()` | 托盘菜单勾了，但窗口没锁（或反之） |
| 2 | `overlay.applySettings()` | 勾选状态对了，窗口行为没变 |
| 3 | `configManager.update()` | 当次生效，**重启后设置丢了** |

### 顺手修掉一个自己埋的性能问题

`applySettings` 原本把 `clickThrough` 算进了 `needRecreate`：

```ts
// 修改前 —— 有问题
const needRecreate = next.size !== this.settings.size
                  || next.clickThrough !== this.settings.clickThrough;
```

于是托盘里每切一次「锁定/穿透」就会 **destroy + create 整个窗口**
—— 一次本可零成本的开关带来一次闪烁，窗口重建期间灯还会短暂消失。

`clickThrough` 本来就有实时的 `setIgnoreMouseEvents` 路径，**不该触发重建**：

```ts
// 修改后
const needRecreate = next.size !== this.settings.size;   // 只有尺寸需要重建
```

---

## 三、质量关卡

| 关卡 | 结果 |
|---|---|
| `tsc -p tsconfig.json --noEmit` | **exit 0** |
| `tsc -p tsconfig.electron.json --noEmit` | **exit 0** |
| `tsc -p tsconfig.test.json --noEmit` | **exit 0** |
| `vitest run` | **354 passed × 2 次连续** |
| `node scripts/smoke-e2e.js` | **全部通过** |
| `scripts/live-dsh-check.mjs` | **真实 dsh 打通** |
| `scripts/verify-strip-visual.mjs` | **17/17 视觉验收通过** |
| `scripts/check-dsh-config.mjs` | **示例配置 0 警告** |

测试数字对账：
`329（上轮）+ 19（notify-content）+ 6（store-clickthrough）= 354` ✅

---

## 四、文档更新

`config.dsh.example.yaml` 补上 `lamp` 与 `notify` 两段，并写清：

- `lamp.clickThrough` 既能在配置里改，也能在**托盘右键菜单**里随时切
- `notify.notifyStates` 默认恰好三态，以及**为什么**（多端口不刷屏）
- 通知正文会自动带端口号，并给了实际样例
- 同时**修正了我上一轮写反的一处注释**：环境变量展开是发生在
  YAML parse **之后**（不是之前），所以双引号其实也安全；
  示例仍用单引号是出于「顺序若被改动则更稳妥」的考虑。

---

## 五、完成度

| 决策 | 状态 |
|---|---|
| D1 置顶浮窗 | ✅ |
| D2 状态采集 | ✅ (a) 真实打通 · ✅ (b) 插件验证 · ⏳ **二者合并仲裁仍缺** |
| D3 扩展项目 | ✅ |
| D4 端口发现 | ✅ |
| D5 远端鉴权 | ⏳ **SSH 路径未验证** |
| D6 聚合粒度 | ✅ 灯带 UI 已验收 |
| D7 插件 | ✅ |
| D8 采集方式 | ✅ 轮询/事件就绪；⏳ `session/follow` 未试 |
| D9 灯排布 | ✅ |
| **D10 浮窗交互** | ✅ **完成**（可点击 + 锁定/穿透托盘开关） |
| **D11 通知策略** | ✅ **完成**（三态白名单 + 文案带端口 + 30s 去重） |
| 插件装进真实 3080 | ⏳ 待你同意重启 |

**11 项设计决策里 9 项已完成**；剩下的是：D2 混合仲裁（收尾）、
D5 SSH（外部阻塞）、D8 订阅流（可选优化）、以及插件上线（需你同意重启）。

---

## 六、复现

```powershell
cd D:\Projects\lamp\ai-task-indicator

# 类型检查（三份都应 exit 0）
node node_modules/typescript/bin/tsc -p tsconfig.json          --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.test.json     --noEmit

# 全量测试（应 354 passed）
node node_modules/vitest/vitest.mjs run

# 只跑本轮新增的
node node_modules/vitest/vitest.mjs run test/notify-content.test.ts test/store-clickthrough.test.ts

# 真实 dsh 端到端
node node_modules/typescript/bin/tsc -p tsconfig.json
node scripts/live-dsh-check.mjs

# 视觉验收 + 端到端冒烟 + 示例配置校验
node scripts/verify-strip-visual.mjs
node scripts/smoke-e2e.js
node scripts/check-dsh-config.mjs
```
