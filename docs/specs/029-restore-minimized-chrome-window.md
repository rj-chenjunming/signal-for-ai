# SPEC-029：点击 web 任务时恢复最小化的浏览器窗口

> 状态：done
> 类型：bugfix（交互/窗口恢复）
> 需求来源：用户 2026-10-22 17:55 会话——「有时候我点击 dsh web 图标，不会自动打开窗口，底下图标会亮就是了大概这样的」，附任务栏截图（Chrome 任务栏按钮高亮、无窗口）。
> 负责人：lead
> 基线提交：`7aadfa7`（工作区含 SPEC-028 未提交改动；`extension/` 未改）
> 需求依据及假设：用户要「点 web 13080 就把那个 Chrome 窗口带到前台」；窗口最小化时也算「没打开」，必须还原。不改变「URL 总是要打开」「按同源切标签」的既有语义。
> 关联/替代条款：补充 [SPEC-003](003-extension-tab-switch-reliability.md) 的扩展切标签链路；不改变 SPEC-002/022 的主进程窗口恢复策略，也不改 `openUrlDebugPort` CDP 路线与无扩展时的「新开页面」降级。

## 1. 问题与目标

`dsh-web` 任务配置了 `jump.openUrl=http://127.0.0.1:13080` 与 `openUrlViaExtension: true`。点击该行时主进程把指令交给 Chrome 扩展，扩展执行：

```js
await chrome.tabs.update(tab.id, { active: true });
await chrome.windows.update(tab.windowId, { focused: true });
```

`focused: true` 只做「聚焦」，**不改变窗口状态**：Chrome 窗口最小化时，Windows 上这等价于对它 `SetForegroundWindow`，窗口仍是 minimized，只是任务栏按钮变成高亮 —— 用户看到的就是「底下图标会亮，但窗口没打开」。

现场证据（2026-10-22 本机）：

| 证据 | 内容 |
| --- | --- |
| 指示灯日志 | `17:55:10 已通过浏览器扩展切到已打开的标签页 http://127.0.0.1:13080（任务 dsh-web，未新开标签页）` —— 扩展回报成功，主进程据此判定成功 |
| 窗口枚举（17:57 左右） | Chrome 主窗口 `Chrome_WidgetWin_1`：`Visible=True`、`Minimized=True`、`Rect=-32000,-32000 160x28`，标题 `Greeting — DeepSeek Harness - Google Chrome` —— 点完之后仍是最小化 |
| 用户截图 | 任务栏 Chrome 图标高亮，桌面上没有 Chrome 窗口 |

同类记录：当天 15:31（3 次）、16:33 的扩展切标签调用日志也都是「成功」，说明该链路平时可用；差异只在**点击时窗口是否最小化**，这就是用户说的「有时候」。

目标行为：窗口最小化时，点击 web 任务应**还原并聚焦**该窗口；窗口未最小化时行为完全不变（不把最大化/全屏窗口重置）。

## 2. 范围与非目标

- 本次包含：
  - `extension/bridge-client.js` `activateByUrl()`：先读目标窗口状态；`state === 'minimized'` 时，聚焦调用同时带 `state: 'normal'`。
  - `extension/manifest.json`：版本 `1.1.1 → 1.1.2`，让指示灯日志的「扩展自报：版本=…」能证明用户重载后跑的是修复版。
  - 新增 `test/extension-bridge-client.test.ts`：用假 `chrome` 对象断言三种情况（最小化还原、正常窗口不改变状态、`windows.get` 失败仍尝试聚焦）。
  - `tsconfig.test.json` 允许测试程序引入扩展侧 JS（`allowJs`），让类型检查覆盖这份测试。
  - `extension/README.md`：把「工作原理」里的调用写清楚（最小化时带 `state:'normal'`），并补一条排查提示。
  - 规格索引与本文档。
- 本次不包含：
  - 主进程无扩展时的 `rundll32 url.dll,FileProtocolHandler` 降级路径（Chrome 最小化时同样不会自动还原；本轮先修扩展链路）。
  - 跨虚拟桌面、跨显示器、其它浏览器（Edge/Firefox）的窗口恢复。
  - 主进程对「扩展说成功但前台未确认」的二次校验（属于另一层防御，见"残余风险"）。
  - 改变按同源匹配、URL 总是要打开、未找到标签时新开 + 提示的语义。
- 受影响模块/接口/用户文档：`extension/bridge-client.js`、`test/extension-bridge-client.test.ts`、`tsconfig.test.json`、`extension/README.md`、`docs/specs/README.md`。主进程 IPC/配置/数据格式不变；扩展需要用户在 `chrome://extensions` 重新加载一次。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | Chrome 里开着 `http://127.0.0.1:13080`，其窗口 `state='minimized'` | 扩展执行 `activateByUrl(url)` | 先 `tabs.update(tabId,{active:true})`；再 `windows.update(windowId,{focused:true,state:'normal'})`（同时带两者）；返回 `found: true` |
| AC-02 | 同上，窗口 `state='normal'` | 同上 | `windows.update(windowId,{focused:true})`，**不携带 `state`**（最大化/全屏窗口不被重置）；返回 `found: true` |
| AC-03 | 目标窗口 `windows.get` 抛错（刚关闭等） | 同上 | 不抛异常；仍执行 `windows.update(...,{focused:true})`；返回 `found: true` |
| AC-04 | 没有任何同源标签 | 同上 | 不调用 `tabs.update`/`windows.update`；返回 `{found:false,reason:'no tab'}`（SPEC-003 的降级与提示不变） |
| AC-05 | 目标窗口最小化 | 用户在真机点击 dsh-web 行（重载扩展后） | Chrome 窗口从最小化恢复并到前台，不再只亮任务栏图标；指示灯日志仍记录「已通过浏览器扩展切到已打开的标签页」 |
| AC-06 | 现有测试与构建 | 执行 | `typecheck` / 全量测试通过；无新增失败（扩展 JS 不进 `dist`，构建/smoke 不受影响，仍跑一次确认） |

边界、异常、恢复/停止行为：

- `windows.get` 返回缺少 `state` 或窗口已关闭：按「不改变状态」处理，仍聚焦；不阻断主流程。
- 窗口 `state` 为 `maximized` / `fullscreen` / `locked-fullscreen`：不传 `state`，避免把最大化/全屏窗口还原。
- 标签在后台窗口：以标签实际的 `windowId` 为准（现有逻辑不变）。
- 扩展未连接/未找到标签：行为与 SPEC-003 完全一致（新开 + 可见提示）。

## 4. 方案与任务切片

最小方案（只改扩展侧一个函数）：

```js
const tab = hits.find((t) => t.active === true) ?? hits[0];
await chromeApi.tabs.update(tab.id, { active: true });
if (typeof tab.windowId === 'number') {
  let state;
  try { state = (await chromeApi.windows.get(tab.windowId))?.state; } catch { /* 窗口刚关掉 */ }
  const update = { focused: true };
  if (state === 'minimized') update.state = 'normal'; // ← 关键：只聚焦不会还原最小化窗口
  try { await chromeApi.windows.update(tab.windowId, update); } catch { /* 忽略 */ }
}
```

备选取舍：

- 由主进程点完后用 Win32 枚举 Chrome 窗口并 `ShowWindow(SW_RESTORE)`：能救无扩展降级路径，但会引入"猜哪个窗口"的歧义与额外 1–3 秒（`refreshWindows` 走 PowerShell），且扩展已经知道确切 `windowId`，故本轮不做。
- 扩展端无条件 `state:'normal'`：会把最大化的窗口缩成普通窗口，明显回退，故必须按 `state` 条件处理。

任务切片：

1. **S1（Red）**：新增 `test/extension-bridge-client.test.ts`（AC-01/AC-02/AC-03/AC-04），在未改扩展的代码上运行，确认最小化用例失败（当前只传 `focused:true`）。
2. **S2（Green）**：改 `activateByUrl()`，重跑目标测试与全量。
3. **S3（回归与文档）**：`typecheck` → 全量测试 → `build` → `smoke`；更新 `extension/README.md`、索引、本文档；真机步骤交用户验证（需重载扩展）。

## 5. 测试计划与追踪

| AC | 测试文件/完整用例名或真机步骤 | Red 证据 | Green 证据 | 回归/平台验收 |
| --- | --- | --- | --- | --- |
| AC-01、AC-02、AC-03、AC-04 | `test/extension-bridge-client.test.ts`：`最小化窗口：先激活标签，再带 state:normal 聚焦，确保窗口被还原`、`正常窗口：只聚焦，不改变窗口状态（不能把最大化/全屏窗口重置）`、`windows.get 抛错：不中断切标签，仍尝试聚焦`、`没有同源标签：不碰标签/窗口 API，返回 found:false（交给主进程降级）` | 2026-10-22 17:58 `npm test -- test/extension-bridge-client.test.ts` exit 1：1 failed / 3 passed；`expected "spy" to be called with arguments: [7, {focused:true, state:'normal'}]`，实际只收到 `{focused:true}`（缺 `state`） | 17:59 同命令 exit 0：4 passed；`npm run typecheck` exit 0（含 `allowJs` 后的测试程序） | 纯逻辑（假 chrome 对象） |
| AC-05 | Windows 真机：`chrome://extensions` 重载扩展（版本应为 1.1.2）→ 最小化 Chrome → 点 dsh-web 行 | 用户 2026-10-22 17:55 截图 + 日志（扩展回报成功但窗口仍 `Minimized=True`） | 2026-10-23 用户重载扩展后真机确认可以收尾（回复「2和3可以改为done了」，即本条与 SPEC-028 的 AC） | 真实 Chrome + 指示灯 |
| AC-06 | `npm run typecheck`、`npm test -- --maxWorkers=2 --minWorkers=1`、`npm run build`、`npm run smoke` | — | 18:00–18:01：typecheck 0；65 files / 932 tests passed；build 0；smoke 0；`git diff --check` 0 | Windows 本机 |

## 6. 执行记录

- 规格就绪依据、仍需澄清项：现象与代码路径已由日志 + 窗口枚举锁定（17:55:10 扩展回报成功；17:57 枚举 Chrome 主窗口仍 `Minimized=True`），无需再澄清。
- 修改前状态：`git status` 仅有 SPEC-028 的未提交改动（`src/renderer/shared.css` 等），`extension/` 未动；基线行为即上面的现场证据。
- 切片 Red → Green：
  - S1（Red，17:58，commit 前工作区）：新增 `test/extension-bridge-client.test.ts` 后 `npm test -- test/extension-bridge-client.test.ts` exit 1，1 failed / 3 passed；失败断言为最小化用例的 `windows.update` 参数，实际 `{focused:true}`、期望 `{focused:true, state:'normal'}`。
  - S2（Green，17:59）：改 `activateByUrl()` 读窗口状态并条件带 `state:'normal'`；同命令 exit 0（4 passed）；`npm run typecheck` exit 0。
  - S3（回归，18:00–18:01）：`npm run typecheck` exit 0；`npm test -- --maxWorkers=2 --minWorkers=1` 65 files / 932 tests passed，exit 0；`npm run build` exit 0；`npm run smoke` exit 0；`git diff --check` exit 0。
- 兼容性：扩展权限未变（仍 `tabs` + `alarms` + `http://127.0.0.1/*`），协议与 `/poll` `/result` 字段未变，主进程无需改动；旧版扩展仍能连接，只是最小化窗口不会还原。
- 真机验证步骤（待用户执行）：`chrome://extensions` → 本扩展 → **重新加载**；确认指示灯日志出现 `扩展自报：版本=1.1.2`；把 Chrome 最小化后点 dsh-web 行，窗口应恢复并到前台。
- TDD 例外：无。
- 需求变更记录：无。

## 7. 交付与验收

- [x] AC-01 ~ AC-04 有单测证据；AC-06 的类型检查/全量测试/构建/smoke 已记录；AC-05 已于 2026-10-23 用户真机确认。
- [x] 类型检查、全量测试、构建后 smoke 及相关集成检查结果已记录（见执行记录）。
- [x] 扩展 README、规格索引已更新；没有秘密或本机配置进入提交。
- [x] 无遗留失败、无跳过或删除断言；真机项已关闭。

最终结果/提交引用：已随提交 `9290ee1`（「fix: SPEC-028/029/030 …」）推送 `origin/main`；2026-10-23 用户确认（回复「2和3可以改为done了」）。回退方式是还原 `extension/bridge-client.js` 的 `windows.get`/`state:'normal'` 段落并重载扩展。
