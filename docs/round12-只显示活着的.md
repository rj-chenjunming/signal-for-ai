# 新增：「浮窗里出现的，默认就该是活着的」（round 12）

> 你的判断：「如果没活着就没必要显示在浮窗里面了，既然能存在浮窗里面，
> 那么就应该是活着的」。
> 这条原则实现过程中连带挖出**三个真 bug**。
> 日期：2026-10-14 · 结论：**483 测试全绿，全部实测链通过**

---

## 一、规则（你确认的三项）

| 决策 | 选择 |
|---|---|
| 隐藏哪些 | **只隐藏「失联」和「失败」** |
| 全部隐藏时 | **缩成单灯**（自动展开回去） |
| 适用范围 | **所有监控型统一** |

于是「看到一行」就等于「它是活着的」—— 不需要再去分辨灰灯是"空闲"还是"掉线"。
这条规则的价值在于**可依赖**。

保留 `idle` 是刻意的：dsh 端口连接正常但暂时没有活跃会话时，
仍要能看到"这个端口在、只是空闲"。

---

## 二、实现

新增 `src/shared/visibility.ts`（规则单一来源）：

```ts
export const HIDDEN_STATUSES = new Set(['unknown', 'failed']);
export function isVisibleStatus(s) { return !HIDDEN_STATUSES.has(s); }
export function isTaskVisible(t) {
  return t.enabled !== false && t.paused !== true && isVisibleStatus(t.status);
}
```

`Snapshot` 新增两个字段：

- `displayTasks`：**主进程过滤好**的待渲染行
- `hiddenCount`：被隐藏的行数（tooltip 用来说明"另有 N 个未显示"）

### 为什么过滤放在主进程

渲染层是 **classic script（零 import）** —— 一旦 import 共享模块，
TS 会生成 `export {}`，页面变成模块脚本、**直接白屏**（项目既有约定）。
所以规则只能有一份实现，放主进程；渲染层退化成"照着画"，不做业务判断。

### 一条不能破的不变量

**隐藏 ≠ 掩盖**：被隐藏的行**仍然参与总灯聚合**。
若把它们从聚合里也剔除，总灯就会变绿 —— 那是把问题藏起来，比不显示更危险。
已加专门测试锁死。

---

## 三、★ 连带挖出的三个真 bug

### bug 1：`hidden` 属性根本不起作用（CSS 优先级）

浏览器默认的 `[hidden] { display: none }` **优先级极低**，
会被任何类选择器上的 `display` 覆盖。而 `.lamp-strip { display: flex }` 正好覆盖了它。

所以 JS 里 `lampStrip.hidden = true` **根本藏不住灯带**。

这个缺陷一直存在，只是**从未暴露**：以往只有"≥2 个任务 → 显示灯带"一条路径，
没人需要把灯带藏起来。加上"没活着就缩成单灯"之后，首次出现"必须隐藏灯带"的场景，
它立刻显形 —— 表现为**窗口已缩成 52x52 单灯，里面却还画着一块灯带**。

修法（`shared.css`）：

```css
[hidden] { display: none !important; }
```

用 `!important` 是刻意的：hidden 语义必须压过任何展示样式，
否则每个新组件都要重新踩一遍。

### bug 2：热重载同步不到 `enabled`（我自己引入的可见性问题）

配置里把 `enabled` 从 `true` 改成 `false` 后，浮窗上那一行**还在**。

根因在 `syncTasks`：

```ts
// 修改前
const nameChanged = existing.name !== cfg.name || existing.cwd !== cfg.jump?.cwd;
if (nameChanged) {
  existing.name = cfg.name;
  existing.cwd = cfg.jump?.cwd;
  existing.paused = !cfg.enabled;   // ← 写在 nameChanged 分支里
  changed.push(cfg.id);
}
```

于是「名字没变、只把 yaml 的 `enabled` 改成 `false`」这个**最常见的操作**
同步不到 store。现在两条独立判断，各自比较、各自记录。已加回归测试。

### bug 3：`task.paused` 被当成两个意思用

`TaskState.paused` 同时被用于：

- **运行时**暂停（托盘「暂停监控」）—— `store.setTaskPaused()`
- **配置**里的 `enabled`（`existing.paused = !cfg.enabled`）

两者语义完全不同：前者用户随时可恢复，后者来自 yaml、重启后仍是那个值。
混用是 bug 2 的深层原因。

修法：给 `TaskState` 加独立的 `enabled` 字段，`paused` 只管运行时。
顺带修正一个既有测试的断言（它断言 `paused === true`，把错误设计固化成了预期行为）。

### 附：我自己的两个诊断错误

1. inspect 脚本里把单灯容器写成 `lamp-single`，实际 id 是 **`lamp-core`** ——
   于是 `singleVisible` 恒为 false，一度让我误判成"单灯也没显示"。
2. 用 `\s+` 断言"不能空格粘连"时，`\s` **包含换行**，把正确的换行拼接也判成 bug。

---

## 四、实测验证

用「临时把三个任务全设为 `enabled:false`」制造"没有任何东西活着"，
观察完再恢复（热重载，无需重启）：

```
=== 全部禁用后 ===
灯带可见: false    单灯可见: true
body class: overlay-body            ← 已去掉 strip-mode
日志: 悬浮灯窗口已创建（52x52，单灯模式，任务数=0）
✅ 形态单一且自洽（单灯）
✅ 单灯形态下没有残留的端口行（0 行）

=== 恢复后 ===
灯带可见: true     单灯可见: false
  3080       idle      空闲 · 17 会话
  workbuddy  running   进程存活 WorkBuddy.exe
  13080      running   64 会话，1 个活跃
```

**窗口尺寸会自动跟着切换**（164x135 ↔ 52x52），因为 `setState` 每次都调
`fitToTaskCount()` 自校正。

顺带确认：配置里 `enabled: false` 的 `dsh-plugin-3080` 也正确地不再出现。

---

## 五、质量关卡

| 关卡 | 结果 |
|---|---|
| `tsc` × 3 份配置 | **全部 exit 0** |
| `vitest run` | **483 passed**（461 → 483，+22） |
| `scripts/d2-arbitration-check.mjs` | **10/10** |
| `scripts/d5-tunnel-check.mjs` | **7/7** |
| `scripts/live-dsh-check.mjs` | **打通** |
| `scripts/verify-strip-visual.mjs` | **17/17** |
| `scripts/smoke-e2e.js` | **全部通过** |
| `scripts/check-dsh-config.mjs` | **0 警告** |
| `scripts/inspect-live-lamp.mjs` | **两种形态都通过**（新增单灯形态断言） |

### 顺带修的脆弱断言

`inspect-live-lamp.mjs` 原来断言"灯带模式已生效（单灯应隐藏）" ——
但现在**单灯是正常形态**，不是失败。改成"形态单一且自洽"，
并按形态分别断言（灯带要求 ≥2 行；单灯要求 0 行无残留）。
另外加了"**显示出来的行不该是 failed/unknown**"这条产品原则的断言。

---

## 六、复现

```powershell
cd D:\Projects\lamp\ai-task-indicator

node node_modules/typescript/bin/tsc -p tsconfig.json          --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.electron.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.test.json     --noEmit
node node_modules/vitest/vitest.mjs run

# 只跑本轮新增
node node_modules/vitest/vitest.mjs run test/visibility.test.ts

node node_modules/typescript/bin/tsc -p tsconfig.json
node scripts/start.mjs -- --config ./config.dsh.example.yaml --remote-debugging-port=9222
node scripts/inspect-live-lamp.mjs   # 会按当前形态断言（灯带或单灯）
```
