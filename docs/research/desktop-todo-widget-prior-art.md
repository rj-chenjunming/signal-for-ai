# 桌面「简易 Todo」小组件开源先例调研

- 调研日期：2026-10-22（Asia/Shanghai）
- 调研范围：托盘 / 菜单栏 / 悬浮窗里内嵌的**用户自维护**简易待办清单；todo.txt 纯文本生态；本地持久化方案
- 与本项目的关系：本项目是 Electron 托盘应用，点托盘展开一个小窗。本轮只调研「小窗里的手动 todo」，与 AI 会话状态无关（上一版调研方向已被用户否决，未落盘）。
- 核实方式：GitHub Search API（`sort=stars`）、repo API（`stargazers_count` / `license` / `pushed_at`）、仓库 README（raw.githubusercontent.com）、npm 包 readme（unpkg）。**未** clone、**未** 安装、**未** 运行任何被调研项目；star 数为 2026-10-22 快照。

> 说明：本环境 `web_search` 端点返回 HTTP 402（余额不足），因此改用 GitHub 官方 Search API + repo API + README 原文核实。搜索 API 的部分返回里混入了与本主题无关的仓库和明显的垃圾/注入内容，已全部丢弃，只保留能逐项核实的项目。

## 0. 结论速览

| 项目 | 形态（最贴近本项目的加粗） | 技术栈 | 数据落盘 | 许可 | Star | 最近推送 |
|---|---|---|---|---|---|---|
| [shakee93/todopop](https://github.com/shakee93/todopop) | **macOS 菜单栏弹出面板**，点图标开面板 | SwiftUI + SwiftPM，零依赖 | JSON 文件（`todos.json`，可选 iCloud Drive） | MIT | 5 | 2026-06-11 |
| [RStankov/FocusedTask](https://github.com/RStankov/FocusedTask) | **macOS 菜单栏应用（Electron）** | Electron + React + Redux | README 未说明（未核代码） | MIT | 149 | 2023-10-27（已停更） |
| [star0628/DeskTodo](https://github.com/star0628/DeskTodo) | **Windows 无边框置顶小窗 + 托盘**，Tauri 版 | Tauri 2 + React + TS + Vite | Tauri Store JSON（`%APPDATA%\com.desktodo.desktop\desktodo-state.json`） | MIT | 1 | 2026-10-18 |
| [BUG-gao/floating-todo](https://github.com/BUG-gao/floating-todo) | **桌面悬浮窗 + 托盘/菜单栏** | Tauri 2 + 原生 HTML/CSS/JS（无打包） | `localStorage` | **无许可证（API `license: null`）** | 25 | 2026-09-14 |
| [ransome1/sleek](https://github.com/ransome1/sleek) | 桌面窗口（todo.txt 管理器） | Electron + React + TypeScript | `todo.txt` 纯文本 + `done.txt` 归档 | MIT | 2048 | 2026-10-18 |
| [todotxt/todo.txt](https://github.com/todotxt/todo.txt) | 纯文本格式规范 | 文本 | `todo.txt` | GPL-3.0 | 3434 | 2026-06-28 |
| [todotxt/todo.txt-cli](https://github.com/todotxt/todo.txt-cli) | CLI | Shell | `todo.txt` / `done.txt` | GPL-3.0 | 6200 | 2026-10-11 |
| [sindresorhus/electron-store](https://www.npmjs.com/package/electron-store) | Electron 持久化库（非 todo） | JS/TS（ESM） | `app.getPath('userData')` 下 JSON | 未核实 | 未核实 | 未核实 |

---

## 1. 托盘 / 菜单栏 / 悬浮窗待办（形态最贴近本项目）

### 1.1 TodoPop —— 单文件菜单栏 todo，交互写得最清楚

- Repo：<https://github.com/shakee93/todopop>｜5★｜MIT｜SwiftUI `MenuBarExtra`，SwiftPM，**零第三方依赖**；作者明确说「不需要 Xcode，命令行工具链就够」。
- 形态：菜单栏图标显示**今日未完成数**（`✓ 3`），为 0 时隐藏数字；点开是弹出面板，面板里是今天/某一天的清单，无 Dock 图标（`LSUIElement = true`）。
- 交互（README「Features」逐条）：
  - 快速添加：输入框 **Return 提交**；行内改名（inline rename）；勾选完成。
  - 删除：hover 出现 `✕`、滑动、或 `⌫`；**把标题改成空 = 删除**。
  - 排序：行左侧专用 `≡` 拖拽 handle，或右键 Move Up/Down。作者专门解释：**没用 `List` 自带拖拽，因为菜单栏 popover 里行内输入框会吞掉抓取手势**——这是很具体的桌面小窗坑。
  - 日期：左右箭头 / 标题横向滑动 / `⌘[` `⌘]` 切换；离开今天时出现「Today」胶囊（`⌘T`）；按天分桶保存，可回看历史；在「今天」有「Roll over N」把更早未完成项顺延到今天。
  - 反馈：标题下细进度条，footer 显示「N of M done」或「All done」；复选框有动画、hover 态、跟随明暗。
  - 键盘：Return 添加、`⌘[`/`⌘]` 换日、`⌘T` 回今天、`⌘Q` 退出。
- 数据：JSON 文件 `~/Library/Application Support/TodoPop/todos.json`；开启 iCloud 时改放 iCloud Drive。**last-writer-wins**，两台 Mac 同时编辑会产生 `todos 2.json` 冲突副本——作者自己写明了这个上限。
- 可靠性（README「Sync」与「Status」）：文件变更 watcher 用内容 diff 忽略自己的写入；**空读/占位文件不会把非空列表清空**；seed 时忽略非法 JSON；启动时先催 iCloud 下载。自带 64 个 headless 检查（CRUD、排序 tiebreak、拖拽越界、rollover、watcher 数据丢失防护等）。
- 可借鉴：面板信息架构（计数 → 列表 → footer 统计）、空状态/全完成态、删除的三种入口、拖拽用独立 handle、`Roll over` 这类「跨天清理」动作的克制做法。
- 坑：star 很少（5），不能当成熟度背书；iCloud 同步是文件级 last-writer-wins，**不建议本项目第一步就做同步**。

### 1.2 FocusedTask —— Electron 菜单栏 todo 的老样本

- Repo：<https://github.com/RStankov/FocusedTask>｜149★｜MIT｜Electron + React + Redux，`pushed_at` 2023-10-27，**已停更**。
- 形态：macOS 菜单栏应用，点开是「当前唯一任务」的详情：todos、书签链接、自由文本；支持拖文件成书签。核心主张是「一次只专注一件事」，全部操作都有快捷键。
- 数据：README 未写持久化格式（只写 `yarn dev` 启动），本次未深入源码核实。
- 可借鉴：Electron 做菜单栏窗口的形态可行性、Redux 式单向数据流在 todo 上的映射、「键盘优先，鼠标可选」的产品取向。
- 坑：停更三年多；Electron + Redux 对「一个 todo 列表」明显过重，本项目已有 strict TS + 原生 DOM，不应引入这套。

### 1.3 DeskTodo —— Windows 托盘小组件，工程细节最全，但功能过重

- Repo：<https://github.com/star0628/DeskTodo>｜1★（很新）｜MIT｜Tauri 2 + React + TypeScript + Vite + Plain CSS + Vitest；Tauri Store 持久化。
- 形态：Windows 优先的**无边框、半透明、默认置顶**小窗 + 系统托盘；点「×」关到托盘，左键托盘恢复；默认不在任务栏显示；单实例唤醒；窗口位置/尺寸恢复；支持置顶/普通/桌面层三档；10%–100% 背景不透明度、12–20px 字号、紧凑密度、五套配色。
- 与 todo 直接相关的交互：
  - 新增/编辑/勾选/删除一级任务与子任务；长按行拖拽排序（拖动时其他行平滑让位）。
  - **完成区默认折叠**，有偏好开关；完全完成的工作归入列表下方可折叠区域。
  - 删除/清理历史后 **8 秒内可撤销**，`Ctrl+Z` 也可恢复待撤销删除；焦点跟随行在待完成/已完成之间移动。
  - `Ctrl+N` 在「今天」/未来视图聚焦快速新增；`Ctrl+F` 本地搜索（NFKC 规范化、中英文全角 emoji）。
  - 重要标记只在派生视图里置顶，**不改写存储顺序**（这个区分很值得学）。
- 持久化与恢复（README 写得很细）：
  - Tauri Store 存 `%APPDATA%\com.desktodo.desktop\desktodo-state.json`；浏览器开发模式回退 `localStorage`。
  - **schema v10**：含任务、导入的完成快照、视觉设置、重要标记、计划日期、时间段、重复系列、截止时间等；v1–v9 在内存迁移，首次保存前把原始状态备份到对应版本 key。
  - 安全解析 schema：数据缺失、损坏、版本不匹配、子任务非法嵌套 → 回退默认空状态并记警告；**异步 hydration 不会用默认空数据覆盖缺失/无效的持久化数据**。
  - 保存：todo 真实变化后立即保存（避免快速退出丢数据）；写到失败保持运行并记警告，后续修改或隐藏/退出前的 flush 会**串行重试最新状态**；原生侧在隐藏/关闭到托盘前先请求前端 flush。
- 可借鉴：单实例、关闭到托盘、退出前 flush、损坏数据「保留原文件 + 空态 + 警告」而不是静默覆盖、迁移前备份、重要标记只在视图排序而不写回存储。
- 坑（明确的「不要学」样本）：README 已膨胀成完整产品说明书——日历订阅、重复任务、子任务、导入导出、五套主题、三档窗口层级……作者自己在「已知限制」里列了 15+ 条。**这就是「简单 todo」被需求拖成半个 GTD 的样子**，其 schema v10 就是代价。

### 1.4 悬浮待办 Floating Todo —— 悬浮窗形态 + 全局快捷键

- Repo：<https://github.com/BUG-gao/floating-todo>｜25★｜**API `license` 为 `null`（没有许可证文件）**｜Tauri 2 + 原生 HTML/CSS/JS，**无前端打包**；持久化用 `localStorage`。
- 形态：常驻桌面、半透明、始终置顶的浮窗；托盘/菜单栏入口；可调透明度、背景色、明暗、四角缩放、紧凑模式只显示今天；Windows 可切「桌面固定」或「鼠标穿透」；开机自启。
- 交互：全局快捷键 `Ctrl+Shift+Space`（macOS `⌘⇧Space`）唤起并聚焦输入框，**回车后继续手头的事**；`Esc` 收起；今日/明天/后天三列；一键完成、删除、**一键清除已完成**；完成后自动沉底且保留手动排序；双击标题就地编辑；更多菜单可加描述、移到其他日期、设为每天；自然语言识别「明天 15:00」并本地通知；每天习惯有 streak。
- 可借鉴：**「唤出即输入、回车即走」的零切换路径**；三段时间盒（今/明/后天）比完整日期选择器轻；清除已完成作为显式动作；导出/导入 JSON 备份而**不做云**。
- 坑：**无许可证 = 默认保留所有权利，代码不可复制**（只能学思路）；`localStorage` 在桌面端不便备份/迁移，也不受原子写保护；功能同样已经开始膨胀（习惯打卡/自然语言/通知）。

---

## 2. todo.txt 生态：纯文本方案的完整样本

### 2.1 格式本身（todotxt/todo.txt，3434★，GPL-3.0）

核实自格式规范 README，规则很短：

- 一行 = 一个任务。
- 未完成任务三条规则：① 优先级 `(A)`（大写字母 A–Z，括号+空格）必须在最前；② 创建日期 `YYYY-MM-DD` 紧跟优先级之后（无优先级则在最前）；③ `+project`、`@context` 可出现在优先级/日期之后的任意位置，可多个。
- 已完成任务：行首小写 `x` + 空格，后接**完成日期**；若原来有创建日期，完成日期在前、创建日期在后（便于按日期排序）。
- 扩展元数据用 `key:value`（如 `due:2010-01-02`），key/value 不含空白和冒号。
- 设计目标写得很直白：人类可读、可用纯文本编辑器按直觉修改、能直接享受 `sort` 之类的通用工具。

### 2.2 todo.txt-cli（6200★，GPL-3.0）

- 命令模型即数据操作：`add`（`-t` 自动加日期）、`append`/`prepend`/`replace`、`do`（标记完成）、`del`、`archive`（把 done 移到 `done.txt`）、`list`/`listpri`/`listproj`/`listcon`、`pri`/`depri`。
- 细节值得注意：`-n/-N` 控制**删除后是否保留行号**（因为行号就是任务身份）；`-a/-A` 控制完成时**是否自动归档**；有 `TODOTXT_AUTO_ARCHIVE` 等环境变量。
- 可借鉴：「已完成」与「活动列表」物理分离（`done.txt`）、归档是显式动作、`add` 时可选自动日期。
- 坑：行号即 id，删除/重排会漂移；纯文本没有原子写和并发保护。

### 2.3 sleek（2048★，MIT）—— 把它做成 GUI 的样子

- 技术栈：Electron + React + TypeScript，Vitest（README 招募贡献者时点名的技能栈）。
- 能力：完整 todo.txt 语法；已完成的 todo 可**隐藏或归档进单独的 `done.txt`**；**持续扫描 todo.txt 文件**以与其他 todo.txt 应用互通；标签过滤 + 可配置分组 + 全文搜索。
- 可借鉴：文件格式本身就是「同步协议」——不自建后端、不做账号，用户拿 U 盘/网盘同步文件即可；「隐藏已完成」与「归档已完成」是两个不同动作。
- 坑：为互通而做**文件监听 + 冲突处理**，复杂度立刻上一个量级；本项目没有外部编辑器同时改文件的需求，不该引入。

---

## 3. 持久化与数据模型：可直接落地的取舍

### 3.1 electron-store（Electron 官方生态最常用）——已核实的行为

来源：npm 包 readme（<https://unpkg.com/electron-store@12.0.0/readme.md>；GitHub API 本次取不到该仓库，**star/许可未核实**，故只引用行为描述）：

- 位置：`app.getPath('userData')` 下的 `config.json`；**每次变更整文件读写**，作者明确说不适合 1MB+ 数据，也不适合高频写。
- **原子写**：「Changes are written to disk atomically, so if the process crashes during a write, it will not corrupt the existing config.」——这正是我们手写 `writeFile` 时缺的那一层。
- **不支持两个进程同时写**同一个文件（写前会先读，重叠写会丢改动）；需要 `watch` 才能看到别的进程的改动。
- schema 用 JSON Schema（ajv）校验；`migrations` 存在且**作者声明有已知 bug、不提供支持**。
- 损坏处理：`clearInvalidConfig` 默认 **false**，即 JSON 语法错误/校验失败时**抛错**而不是清空；只有显式打开才会「清空并覆盖」。
- 渲染进程不要直接用（`fs` 被禁），应放主进程 + `ipcMain.handle` / `ipcRenderer.invoke` 暴露。
- 对本项目的意义：我们不加这个依赖，也应复制它的三个决定——**userData 下 JSON、原子写、默认不清空损坏文件**。

### 3.2 已被验证的恢复/并发策略（来自 1.3 / 1.1）

| 问题 | DeskTodo 的做法 | TodoPop 的做法 | 对本项目的建议 |
|---|---|---|---|
| 文件损坏/非法 JSON | 回退空状态 + 记警告；hydration 不覆盖无效文件 | seed 时忽略非法 JSON | 保留原文件（改名 `.corrupt`），显示空态 + 一行可关闭的提示；**绝不静默用 `[]` 覆盖** |
| schema 升级 | 内存迁移 v1–v9 → v10，首次保存前把旧数据备份到版本 key | v1 直接 JSON，未提迁移 | 首版就写 `version: 1`，迁移函数留空但存在；未知版本 → 只读提示 |
| 写入失败 | 保持运行 + 警告，后续修改/退出前 flush 串行重试最新状态 | 未提 | 保存失败要有可见反馈；退出/隐藏前 await 一次 flush |
| 多实例 | Tauri single-instance 插件 | 未提（单 app） | Electron `app.requestSingleInstanceLock()`，第二实例直接聚焦已有窗口 |
| 外部改动 | 不监听文件 | watcher + 内容 diff + 空读保护 | v1 不监听文件（没有外部编辑器场景），省掉一整类 bug |
| 排序 | 长按拖拽，平滑让位 | 专用 `≡` handle | 排序字段存 `order`，视图只读；**拖拽可后置**，先支持「新增在顶部/底部」 |

### 3.3 建议的数据模型（针对本项目，属推导建议，非某项目原样）

```jsonc
{
  "version": 1,
  "items": [
    {
      "id": "uuid-v4",          // 稳定身份，避免 todo.txt 的行号漂移
      "text": "买牛奶",          // 单一文本字段，不拆标题/描述
      "done": false,
      "createdAt": 1761100000000,
      "completedAt": null,
      "order": 1                // 或直接依赖数组顺序，二选一，不要两者并存
    }
  ]
}
```

- 不建议首版加：`priority`、`tags`、`project`、`dueDate`、`subtasks`、`repeat`（DeskTodo 的 v10 就是这些字段的后果）。
- `done` 用布尔而不是状态枚举：todo 只有「没做/做完」，**不要照搬 AI todo 的 pending/in_progress**——本项目没有执行者。
- 删除用物理删除 + 内存快照撤销，不要软删除表。

---

## 4. 「状态指示 / 监控类应用里附带手动 todo」——未找到可核实项目

按 lead 要求优先找这一类，检索了 `monitor todo widget`、`menu bar todo`、`tray todo`、`status indicator todo` 等组合（GitHub Search API），**没有找到「以监控/状态展示为主、附带用户自维护 todo 清单」且能核实的开源项目**。命中的都是：

1. AI 会话 todo 展示器（上一轮方向，已否决）；
2. 纯 todo 应用（本文第 1、2 节）；
3. 名字带 todo 但实际是别的工具（游戏脚本、WhatsApp agent 等垃圾结果，已丢弃）。

因此形态结论只能从「菜单栏/托盘 todo 应用」迁移：**它们解决的是同一个窗口尺寸与同一个输入场景**，差别只在于本项目的小窗里还要放灯带和会话列表。

---

## 5. 对本项目的可借鉴结论（5 条以内）

1. **形态**：小窗内固定宽度、单列、自上而下 = 计数（未完成数）/ 输入行 / 唯一滚动列表 / 底部「已完成」折叠区 + 「N of M done」。托盘 tooltip 或图标角标同步未完成数（TodoPop 的 `✓ 3`、DeskTodo 的进度线）。输入行 Enter 提交后**保持焦点**，方便连续录入。
2. **数据模型**：带 `version` 的 JSON，`items[]` 只放 `id/text/done/createdAt/completedAt/order`；状态只有两态；不加优先级、标签、日期、子任务。稳定 `id` 是撤销、动画和「focus 跟随行」的前提。
3. **持久化**：`app.getPath('userData')` 下一个 JSON；写临时文件 + `rename` 原子替换（electron-store 的承诺就是这一层）；启动解析失败 → 保留原文件、空态 + 可见告警，**不用默认值覆盖**；`app.requestSingleInstanceLock()`；退出/隐藏前 flush。
4. **交互**：勾选即完成并沉底（可撤销）；hover 显示删除；删除后 5–8 秒 toast 撤销（DeskTodo 用 8 秒 + `Ctrl+Z`）；行内双击/点击编辑，清空文本 = 删除（TodoPop）；超长文本换行 + 最大行高；空状态一行文案；拖拽排序**后置**，真要做就用独立 handle 而不是整行抓取（TodoPop 在菜单栏 popover 里踩过「输入框吞手势」）。
5. **克制**：不做云同步 / iCloud / 多设备（TodoPop 明说 last-writer-wins、会产生冲突副本）；不做 todo.txt 文件监听双向同步（sleek 为此付出持续扫描 + 冲突处理的代价）；不引入 UI 框架或持久化依赖，继续 strict TS + 原生 DOM。

## 6. 明确「不要学」的坑

- ❌ **把简单 todo 做成完整 GTD**：DeskTodo 的日历订阅、重复任务、子任务、导入导出、主题系统，换来 schema v10 和 15+ 条已知限制。
- ❌ **首版做拖拽排序/跨天顺延/习惯打卡**：TodoPop 的 rollover、floating-todo 的 streak 都是成熟后才值得加的糖。
- ❌ **做云同步/多端**：iCloud 文件同步会出 `todos 2.json` 冲突副本，且要处理占位文件、空读、目录 watcher 的 SIGTRAP 类问题（TodoPop 的 Status 里记录过）。
- ❌ **复用无许可证项目的代码**：floating-todo 的 API `license` 为 `null`，默认保留所有权利，只能借鉴交互。
- ❌ **用 `localStorage` 存桌面应用数据**：floating-todo 这么用，但不可原子写、不便备份、清缓存即丢。
- ❌ **手写「清空损坏配置」逻辑**：electron-store 的 `clearInvalidConfig` 默认关掉，说明「损坏就清空」是危险默认值。
- ❌ **照搬 Electron + Redux**（FocusedTask）：本项目是原生 DOM + strict TS，加状态库只会扩大面积。

---

## 7. 检索词与查询到的 URL 清单

### 7.1 实际使用的检索词（GitHub Search API，`sort=stars`）

- `todo widget tauri`
- `menu bar todo`
- `todo.txt`
- （上一方向、已废弃，仅记录）`claude code todo`、`claude code statusline`、`deepseek harness`

### 7.2 URL 清单（均于 2026-10-22 访问）

元数据（repo API）：

- <https://api.github.com/repos/shakee93/todopop>
- <https://api.github.com/repos/RStankov/FocusedTask>
- <https://api.github.com/repos/star0628/DeskTodo>
- <https://api.github.com/repos/BUG-gao/floating-todo>
- <https://api.github.com/repos/ransome1/sleek>
- <https://api.github.com/repos/todotxt/todo.txt>
- <https://api.github.com/repos/todotxt/todo.txt-cli>

README / 文档：

- <https://raw.githubusercontent.com/shakee93/todopop/refs/heads/main/README.md>
- <https://raw.githubusercontent.com/RStankov/FocusedTask/refs/heads/master/README.md>
- <https://raw.githubusercontent.com/star0628/DeskTodo/refs/heads/main/README.md>
- <https://raw.githubusercontent.com/BUG-gao/floating-todo/refs/heads/main/README.md>
- <https://raw.githubusercontent.com/ransome1/sleek/refs/heads/main/README.md>
- <https://raw.githubusercontent.com/todotxt/todo.txt/refs/heads/master/README.md>
- <https://raw.githubusercontent.com/todotxt/todo.txt-cli/refs/heads/master/README.md>
- <https://raw.githubusercontent.com/todotxt/todo.txt-cli/refs/heads/master/USAGE.md>
- <https://unpkg.com/electron-store@12.0.0/readme.md>

搜索页（人工复核用）：

- <https://github.com/search?q=todo+widget+tauri&type=repositories>
- <https://github.com/search?q=menu+bar+todo&type=repositories>
- <https://github.com/search?q=todo.txt&type=repositories>

## 8. 核实方法与局限

- **核实方式**：先用 GitHub Search API 拿候选（按 star 排序），再用 repo API 读 `stargazers_count`、`license`、`pushed_at`，最后读仓库 README/文档确认机制与交互。star/许可来自 API 字段，不是记忆；README 原文支持文中每条行为描述。
- **未做**：没有 clone、没有 `npm install`、没有运行任何项目；因此对「代码实现细节」（例如 TodoPop 的 Swift 存储类、DeskTodo 的 reducer）只引用 README 的明确陈述，不做源码级断言。
- **局限**：
  1. star 数会变，本文是 2026-10-22 快照；低 star（TodoPop 5、DeskTodo 1）不代表设计差，只代表没有社区背书。
  2. `electron-store` 的 GitHub API 本次取不到（网络失败/404），star 与许可证**未核实**；仅其 npm readme 的行为描述可用。
  3. 本环境 `web_search` 不可用（HTTP 402），检索覆盖面依赖 GitHub Search API 的排序，可能漏掉未打 topic/keyword 的项目。
  4. 第 4 节「未找到状态监控类应用附带手动 todo」是**检索不到**，不是证明不存在。
