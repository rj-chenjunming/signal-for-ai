# SPEC-003：浏览器扩展切标签的在线可靠性

> 状态：done
> 类型：bugfix / 可观测性
> 需求来源：用户 2026-10-19 反馈「点我的 dsh web 端之后，它还是会自动创建一个新页面」，并授权按判断优化；现场证据见下方「问题复现与根因」
> 基线提交：`2895db2`；本机 Windows 11 / Chrome 139.0.7258.138 / Node 24.14.0
> 需求依据及假设：用户期望「点击 web 13080 切回已经开着的那个标签，而不是每次新开」。扩展安装与权限已核实，无需新增用户凭据。
> 关联/替代条款：细化 SPEC-002/AC-03 中「URL 走扩展精确切标签」的实现可靠性；不改变 AC-03 的其他结论。

## 1. 问题与目标

**现象**：灯带上点 `dsh-web`，Chrome 每次都新开一个 `http://127.0.0.1:13080` 标签页；主进程日志只有

```
[11:38:26.889] 聚焦请求：任务 dsh-web
[11:38:26.910] 已打开 http://127.0.0.1:13080（任务 dsh-web）
```

**根因（已复现取证）**：

1. 扩展确实装着（Chrome `Secure Preferences`：`location: 4`、路径 `…\ai-task-indicator\extension`、`tabs` 与 `http://127.0.0.1/*` 已授权、`disable_reasons: []`），manifest 合法。
2. 但扩展的 MV3 service worker **没有在轮询**：灯在 15:36:47 启动后，`127.0.0.1:17891` 连续 60 秒零 ESTABLISHED 连接；用户在 `chrome://extensions` 手动「重新加载」后出现连接，约 20 秒后再次消失且不再恢复。
3. 于是 `ExtensionBridge.isExtensionConnected()` 为 false，`FocusService` 跳过扩展分支，直接 `rundll32 url.dll,FileProtocolHandler <url>` → Chrome 新开标签页。旧实现的日志对这条降级路径**没有任何提示**，用户只能看到"又多了一个标签"。
4. 结构原因：`extension/background.js` 只在 SW 被启动的那一刻跑一次 `loop()`，SW 内没有注册任何唤醒事件（无 `chrome.runtime.onStartup` / `onInstalled` / `chrome.alarms`）。Chrome 会在约 30 秒空闲后回收 SW，回收后（尤其是浏览器重启后）它再也不会自己起来；长轮询无法跨越"SW 已被回收"这一事实。

**目标**：让扩展在浏览器重启/SW 被回收后自动恢复轮询（≈常驻可用），并在扩展不可用时让用户与日志都能立刻看出发生了什么，而不是静默新开页面。

**非目标**：不改 CDP 路线；不改点击确认/完成水位；不动 WorkBuddy/dsh 监控；不引入新依赖、不改 `tsc` 架构；不发布扩展（仍为本地「加载已解压」）。

## 2. 范围与非目标

- 包含：`extension/` 的保活改造（offscreen 常驻文档 + alarms 看门狗 + onStartup/onInstalled）、manifest 权限、扩展 README；主进程 `FocusService` 在「期望扩展但不可用」时的日志与一次性浮窗提示；扩展桥接首次连接的可观测日志。
- 不包含：扩展打包/发布、Chrome Web Store 上架、`openUrlTitleMatch` 语义调整、其它任务类型的跳转策略。

受影响接口：
- `FocusServiceOptions` 新增可选 `notify?: (message: string) => void`（缺省只记日志，不改变既有调用方行为）。
- `ExtensionBridge` 增加"首次等到扩展轮询"的一次性 info 日志。
- `extension/manifest.json` 增加 `alarms`、`offscreen` 权限与 `background.type: module`。

兼容性：老版本 Chrome 无 `chrome.offscreen` 时退化为「SW 内轮询 + alarms 唤醒」（与旧行为等价、不会更差）。配置无需改动，旧配置文件继续有效。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | 任务配置了 `jump.openUrl` + `openUrlViaExtension: true`，但扩展未连接 | 用户点击该行 | 行为仍是"打开 URL（保证点击有实际效果）"，但 `result.ok` 为 true 的同时：`logger.warn` 明确说明"扩展未连接已退回新开"，且 `notify` 收到且仅收到一次含「扩展」的提示；不出现"已通过浏览器扩展切到"的日志 |
| AC-02 | 扩展在线且找到了同源标签 | 点击该行 | `requestActivate` 成功 → 返回 `ok: true`、不 spawn 任何进程、不调用 `notify`、日志为"已通过浏览器扩展切到已打开的标签页" |
| AC-03 | 扩展在线但没找到同源标签 | 点击该行 | 日志记录"扩展未确认切换"，`notify` 提示一次（避免用户以为没反应），随后仍退回打开 URL |
| AC-04 | 扩展未装/未启用 | 启动指示灯 | 只要扩展开始轮询，`ExtensionBridge` 打一次 info（便于现场判断"扩展是否真的连上了"），且同一连接期内不重复刷 |
| AC-05 | Chrome 重启后，或 SW 被回收后 | 用户点击该行 | 扩展能在 ≤1 分钟内自动恢复轮询，点击走"切到已有标签"；真机步骤与结果记入本规格（Linux 云端不可替代） |
| AC-06 | 本次改动 | 交付前 | `npm run typecheck`、全量 `npm test`、`npm run build`、`npm run smoke` 全绿并记录退出码；Windows 真机结果另行记录 |

## 4. 方案与任务切片

1. **切片 A（主进程可见性，单元测试覆盖）**：`FocusServiceOptions.notify` + `openUrl` 分支的三条路径（扩展在线命中 / 在线未命中 / 不在线）给出日志与提示。先加类型面（不产生行为），在未实现时用测试取红，再实现取绿。
2. **切片 B（桥接可观测性）**：`ExtensionBridge.handlePoll` 在"从无到有"时打一次 info；已有测试补充断言。
3. **切片 C（扩展保活，真机验证）**：最终方案 = `background.js` 自己跑长轮询 + `chrome.alarms`
   每 30 秒唤醒（实测本机 Chrome 接受 `periodInMinutes: 0.5`，每次唤醒重置 SW 的 30 秒空闲计时器）
   + `onStartup`/`onInstalled` 兜底，并把轮询实现抽到 `bridge-client.js`（SW 与测试共用）。
   manifest 升 1.1.1，权限 `tabs + alarms`，`background.type: module`。
4. **切片 D（自报通道）**：`ExtensionBridge` 增加 `POST /status`，扩展每次唤醒把
   "版本 / 唤醒来源 / 定时器周期 / 轮询在谁身上" 报给主进程并落日志；该通道只写日志、
   不参与任何状态判定。它正是定位下面这条弯路的关键。

**走过的弯路（记录以免重犯）**：第一版（1.1.0）把长轮询搬进 `chrome.offscreen` 文档。
自报显示 `offscreen=ok(WORKERS)`、之后每次都说"ok(已存在)"，但主进程**从未收到任何一轮
offscreen 心跳**，1 秒采样也只看到 `/status` 留下的 keep-alive socket——文档里的脚本实际没跑起来。
没有自报通道时这一层是"黑盒"，所以先加自报再看清楚，然后退回不依赖 offscreen 的方案。

4. 文档：`extension/README.md` 增补架构与验证方法；`docs/specs/README.md` 登记本规格。

## 5. 测试计划与追踪

| AC | 测试/真机步骤 | Red 证据 | Green 证据 | 回归/平台验收 |
| --- | --- | --- | --- | --- |
| AC-01 | `test/focus-extension-warning.test.ts`「AC-01 扩展不在线…」 | `npx vitest run test/focus-extension-warning.test.ts` → 2 failed / 2 passed；失败断言：`WARN` 日志 `expected false to be true`、`notify` "expected spy to be called 1 times, but got 0 times"（退出码 1） | 同命令 4/4 通过；相邻回归 `focus.test.ts`(44) + `focus-reliability.test.ts`(6) 共 54 通过 | 真机：点击 web 13080 出现一次性 toast 并新开页面（扩展未重载时） |
| AC-02 | 同文件「AC-02 扩展在线且命中…」 | 无需红：这是既有行为的特征测试，初始即通过 | 同文件通过 | 真机：日志出现"已通过浏览器扩展切到已打开的标签页" |
| AC-03 | 同文件「AC-03 扩展在线但没找到标签…」 | 同 AC-01 那次运行：`notify` 未被调用 | 同文件通过 | 真机：toast + 回退新开 |
| AC-04 | `test/extension-bridge.test.ts`「SPEC-003/AC-04…」 | 该文件 1 failed / 13 passed：`"扩展已连接"` 日志 0 条（退出码 1） | 同文件 14/14 通过 | 真机：`chrome://extensions` 重载扩展后应用日志出现一次「浏览器扩展已连接（开始轮询）」 |
| AC-05 | 真机：重载扩展 → 观察 17891 连接是否连续；重启 Chrome → ≤1 分钟内连接恢复；再点 web 13080 | 修改前实测（2026-10-19 15:47）：重载扩展后连接出现约 20s 即消失，随后 60s 零连接；点击直接记录「已打开 http://127.0.0.1:13080」，无任何扩展日志 | **通过**（2026-10-19 16:37–16:42，Chrome 139.0.7258.138）：重载 1.1.1 后 `17891` 连续采样 60 秒每秒都有长轮询连接；日志出现 `浏览器扩展已连接（开始轮询）` 与 `扩展自报：版本=1.1.1 唤醒=alarm 定时器=0.5min 轮询=sw`（每 30s 一条）；16:42:04 点击 web 13080 → `已通过浏览器扩展切到已打开的标签页 http://127.0.0.1:13080（任务 dsh-web，未新开标签页）`，**未**出现 `已打开 http://…` 与"扩展未连接"提示 | Windows 真机；2026-10-21 16:10 用户重启 Chrome 后点击 dsh-web 通过，补上最后一项烟测 |
| AC-06 | `npm run typecheck` / `npm test -- --maxWorkers=2 --minWorkers=1` / `npm run build` / `npm run smoke` | — | 2026-10-19 15:54 与 16:08 两次 Windows 运行：typecheck 0；36 文件 **671** 用例全部通过（较基线 665 +6）；build 0；smoke 22 项全通过 | 本机 Windows |

扩展侧无法用 vitest 覆盖（MV3 运行环境），按 `testing.md` 用真机步骤验收；`extension/*.js` 已做 ESM 语法检查（`node --input-type=module --check`）、模块导入检查与假 `chrome` 演练，manifest 权限/`type: module` 用脚本校验。

## 6. 执行记录

- 规格就绪依据：用户已明确要求"点击应切到已有页面"；根因已取证（见 §1），关键未知项（扩展是否安装、是否启用、SW 是否在跑）已用 Chrome `Secure Preferences` 与 `127.0.0.1:17891` 连接实测关闭。
- 修改前回归：`npm run typecheck` 0；`npm test` 35 文件 665/665 通过（本机 Windows，2026-10-19 上午）。
- 切片 A（主进程可见性）：先只加 `FocusServiceOptions.notify` 类型面（不产生行为）→ 新测试取红（2 失败，见 §5）→ 实现 `openUrl` 分支的三条路径 → 4/4 通过。`index.ts` 把 `notify` 接到既有 `broadcastToast`（浮窗 4 秒 toast），未新增 IPC 通道。
- 切片 B（桥接可观测性）：先加测试取红（`扩展已连接` 日志 0 条）→ `handlePoll` 在"从无到有"时打一次 info（间隔小于 30s 在线窗口时不重复）→ 通过。
- 切片 C（扩展保活）经过两次真机迭代：
  1. 1.1.0 用 `chrome.offscreen` 承载长轮询：自报 `offscreen=ok(WORKERS)`、alarm 周期 0.5min 均正常，但**没有任何 offscreen 心跳**，1 秒采样只看到 `/status` 的 keep-alive socket——脚本未真正运行，点击仍是"扩展未连接 → 新开"。
  2. 1.1.1 退回"SW 自轮询 + `alarms(0.5min)` 唤醒"：重载后 `17891` 连续 60 秒每秒都有长轮询连接，点击得到 `已通过浏览器扩展切到已打开的标签页`。
- 切片 D（自报通道）：`POST /status` + 测试（`extension-bridge.test.ts` 15 例）；该通道与实现同批提交、未单独制造 Red——它是诊断通道而非产品行为，`/poll` 与 `/result` 的既有断言未放宽。**这是本规格唯一未按 Red→Green 记录的切片，理由如上。**
- 兼容性：老配置无需改动；未装/未启用扩展时行为与旧版一致（仍打开 URL），但现在有 warn 日志与一次性 toast，不再静默；扩展权限由 `tabs` 变为 `tabs + alarms`（`offscreen` 随弯路一并移除）。
- 回退：把 `extension/` 还原到 `2895db2`（`background.js` + `manifest.json` 1.0.0，删掉 `bridge-client.js`）；主进程侧删掉 `notify` 传参、两处提示与 `/status` 分支即可，其它改动不受影响。
- 需求变更记录：切片 C 的实现方式在真机验证后由 offscreen 改为 alarms+SW 内轮询（需求未变，仅技术路线变更）。

## 7. 交付与验收

- [x] 可自动验证的 AC 均有证据；AC-05 真机主路径已通过。
- [x] 类型检查、全量测试、构建后 smoke 已执行并记录退出码（见 §5）。
- [x] 扩展 README、规格索引已更新；未提交任何本机配置或凭据。
- [x] 已知限制（扩展需重载一次以取得新权限；30 秒定时器依赖 Chrome 尊重 <1min 的 alarm 周期）、回退步骤、发布状态（未发布）已说明。

最终结果：根因（MV3 SW 被回收后无人唤醒）已修复，扩展 1.1.1 在本机 Windows + Chrome 139 实测通过——轮询连续、点击切标签且不再新开页面；主进程侧的"扩展不可用时 warn + 一次性 toast"也已生效。2026-10-21 16:10 用户重启 Chrome 后点击 dsh-web 通过，AC-05 的最后一项烟测补齐。仍未提交、未发布；状态 `done`。

### 2026-10-21 16:10 用户真机确认（AC-05 收口）

- 用户重启 Chrome 后点击面板里的 dsh（web 13080），行为符合预期（切到已打开标签、未新开页）。
- 结合 2026-10-19 的重载/长轮询与点击证据，AC-05 的“重启 Chrome 后恢复”不再是未复验项。


