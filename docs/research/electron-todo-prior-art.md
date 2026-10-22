# Electron 小工具里的简易 Todo / 任务清单：先例调研（主题 B）

- 调研日期：**2026-10-22**（Asia/Shanghai）
- 调研对象：桌面小工具（托盘 / 菜单栏 / 悬浮小面板）里的简易 todo、任务清单实现模式
- 目的：为 ai-task-indicator 即将做的「简单 todo 功能」找可复用的做法，而不是照抄一个完整 todo 应用
- 本文只写**核实过**的事实；无法核实的字段一律写「未核实」，不做记忆式断言

---

## 0. 核实方式与本环境的限制（请先读）

| 项 | 说明 |
| --- | --- |
| 联网工具 | 本 session 的 `web_search` 不可用（返回 HTTP 402 / Insufficient Balance），检索改由 **GitHub REST API** 完成 |
| 可访问域名 | 实测只有 `api.github.com` 可用；`raw.githubusercontent.com`、`cdn.jsdelivr.net`、`ungh.cc`、`registry.npmjs.org`、`www.electronjs.org` 均 `fetch failed`（本环境出网策略限制） |
| 因此可核实 | 仓库元数据（star / license / 最近 push / language / description / topics）、仓库目录树（`/contents/`）、GitHub 搜索结果的 star 数 |
| 因此**不可**核实 | 单个源文件内容（`/contents/<file>` 只返回 base64，且本环境无法可靠解码大文件 → 未逐行读源码）、README 正文、npm 依赖清单 |
| 标注约定 | 「✅API」= 通过 `api.github.com` 核实；「⚠️未核实」= 本环境无法取证，**不要当作事实引用**；「判断」= 我基于已核实结构 + 本项目代码给出的工程意见 |

> 复现命令（任意一台能正常出网的机器上可读源码复核）：
> `curl -s https://api.github.com/repos/<owner>/<repo>`、
> `curl -s https://api.github.com/repos/<owner>/<repo>/contents/<path>`、
> 或直接 `git clone --depth 1 <repo>` 读 `main.js` / `preload.js` / `package.json`。

---

## 1. 结论速览

| 结论 | 依据 |
| --- | --- |
| 「小面板 + 主进程持数据 + preload 白名单 + 单文件 JSON」是这类工具最主流的组合 | 结构与官方描述（✅API），见 §2.1 / §2.2 |
| 真正框架无关（原生 DOM）的 Electron todo 仓库**很少且质量低**：能找到的更接近教学 demo（3★、archived、Electron 2.x） | §2.6 |
| 热度高的 todo 桌面应用几乎都带框架（React / Vue / AngularJS），且持久化大多交给「整文件 JSON」而非 SQLite | §2.3–§2.5 |
| 常见坑集中在：**无许可证**（不能抄代码）、**主进程单文件过大**、**老 Electron 的 nodeIntegration 时代写法** | §2.1–§2.6 |
| 对本项目最优路线：**沿用 TaskStore 的「主进程唯一数据源 + IPC 快照推送」**，todo 独立存 `userData/todo.json`，原子写 + 防抖 | §4、§5 |

---

## 2. 项目卡片（按与本项目的接近程度排序）

### 2.1 xiaopu-ai/TO-DO-Panel —— 最接近「小面板 todo」的现代实现

| 字段 | 值 |
| --- | --- |
| 仓库 | `xiaopu-ai/TO-DO-Panel` · https://github.com/xiaopu-ai/TO-DO-Panel |
| Star | **243**（✅API 2026-10-22） |
| 许可证 | **MIT**（✅API） |
| 语言 / 活跃度 | JavaScript；最近 push **2026-09-30**，创建于 2026-08-26（✅API） |
| 官方描述 | 「把 Mac 刘海变成随手可用的本地工作台：待办、随笔记、链接、录音与 AI 完成提醒。」（✅API） |
| topics | `electron`、`local-first`、`macos`、`notch`、`todo`、`productivity`（✅API） |
| 仓库结构（✅API `/contents/`） | 根级 **`main.js`（130,660 B）**、**`main-services.js`（28,048 B）**、**`preload.js`（6,222 B）**、`platform.js`（1,743 B）、`renderer/`、`scripts/`、`tests/`、`docs/`、`build/`、`website/`、`package.json`（3,426 B）、`AGENTS.md` / `CLAUDE.md` / `HARNESS-GUIDE.md`、`CHANGELOG.md` |
| 持久化方式 | ⚠️未核实（根目录无 db/data 文件，源码未读） |
| IPC / 渲染架构 | ✅结构可证：主进程（`main.js` + `main-services.js`）+ `preload.js` + `renderer/` 三层，和本项目同构；具体通道名单⚠️未核实 |
| 可借鉴 | ① 一个「面板型」todo 的目录分层（main / preload / renderer）与本项目天然一致；② `platform.js` 把平台差异单独抽一层；③ `tests/` 存在，说明这类小面板也值得配测试；④ 面板产品语义（待办 + 速记 + 提醒）与本项目「灯 + 面板」的定位接近 |
| 坑 / 不要学 | ① **主进程单文件 130 KB**：所有窗口/托盘/IPC/数据逻辑塞在 `main.js`，后期几乎不可维护；② 依赖 Electron **^44**（据 `package.json`，⚠️依赖清单未核实），本项目固定在 Electron 33，不能直接抄 API 用法；③ 无 TypeScript，`main.js` 里没有编译期契约 |
| 核实方式 | `api.github.com/repos/xiaopu-ai/TO-DO-Panel`、`.../contents/`（2026-10-22） |

**对本项目的直接启示**：它是「形态参照物」而不是「代码参照物」。本项目已有 `src/main/*` 按职责拆分（`store.ts` / `panel.ts` / `ipc.ts` / `tray.ts`），Todo 应该新增独立模块（例如 `src/main/todo-store.ts`），**绝不能**继续往 `index.ts` / `ipc.ts` 里堆。

---

### 2.2 RStankov/FocusedTask —— 菜单栏（menubar）todo 的经典分层

| 字段 | 值 |
| --- | --- |
| 仓库 | `RStankov/FocusedTask` · https://github.com/RStankov/FocusedTask |
| Star | **149**（✅API 2026-10-22） |
| 许可证 | **MIT**（✅API） |
| 语言 / 活跃度 | TypeScript；最近 push **2023-10-27**（✅API） |
| 官方描述 | 「MacOS menu bar todo app built with Electron, React and Redux. It goals is to help you do deep work.」（✅API） |
| topics | `electron`、`macos`、`menubar-app`、`react`、`redux`、`todo`、`bookmarks`、`shortcut`（✅API） |
| 仓库结构（✅API） | 根：`app/`、`shell/`、`updater/`、`bin/`、`assets/`、`credentials.json.example`、`releases.json`、`package.json`（677 B）、`yarn.lock`；`app/` 内：`package.json`（1,302 B）、`src/`（`components/`、`hooks/`、`modules/`、`screens/`、`types/`、`utils/`、`index.tsx`、`index.css`、`setupTests.tsx`、`react-app-env.d.ts`）、`public/`、`tests/`、`jest.config.js`、`tsconfig.json` |
| 数据模型 / 持久化 | ⚠️未核实（源码未读；结构上「Redux 状态 + 主进程 shell」分家） |
| IPC / 渲染架构 | ✅结构可证：**主进程代码在根级 `shell/`，渲染层是独立 React 应用 `app/`**，带自己的 `app/package.json`；有 `jest` 测试目录 |
| 可借鉴 | ① **主进程与渲染层各自独立成包**（`shell/` vs `app/`），契约靠接口而不是同目录相对路径；② menubar 应用的「点图标弹出固定尺寸面板、失焦即收」形态，与本项目面板近乎同构；③ 有 `tests/` + `jest.config.js`，可对标本项目的 vitest 策略 |
| 坑 / 不要学 | ① macOS 专属（menubar 位置/刘海/权限），Windows 形态不可平移；② 2023 年后停更，Electron/React 版本已旧；③ root 的 `credentials.json.example` 说明它带 OAuth 凭据流程，本项目不要引入 |
| 核实方式 | `api.github.com/repos/RStankov/FocusedTask`、`.../contents/`、`.../contents/app`、`.../contents/app/src`（2026-10-22） |

---

### 2.3 cassidoo/todometer —— 「极简单页 + 进度」参照物

| 字段 | 值 |
| --- | --- |
| 仓库 | `cassidoo/todometer` · https://github.com/cassidoo/todometer |
| Star | **2135**（✅API 2026-10-22） |
| 许可证 | **MIT**（✅API） |
| 语言 / 活跃度 | JavaScript；最近 push **2026-10-12**（✅API） |
| 官方描述 | 「A simple task app with a progress bar」（✅API） |
| topics | `electron`、`productivity`、`react`、`to-do`、`to-do-app`、`to-do-list`（✅API） |
| 仓库结构（✅API） | `src/`、`build/`、`docs/`、`scripts/`、`assets/`、`eslint.config.js`、`package.json`（3,419 B）、`package-lock.json`、`RELEASE-DOCS.md`、README；**根目录没有 Electron 主进程文件** |
| 数据模型 | 官方描述只承诺「任务 + 进度条」；具体模型⚠️未核实 |
| 持久化 | ⚠️未核实（无根级主进程文件，Electron 入口可能在 `package.json` 的 `main`/forge 配置里） |
| IPC / 渲染架构 | ⚠️未核实；结构上更像「React Web 应用 + Electron 外壳」 |
| 可借鉴 | ① **单页只做一件事**：任务列表 + 完成进度，不做优先级/标签/子任务，这是小面板的正确复杂度上限；② 进度条让「完成度」一眼可见，适合本项目的面板顶部状态区 |
| 坑 / 不要学 | ① 它是完整窗口应用，不是常驻小面板；② 若确认数据在渲染层（localStorage）→ **不要学**（见 §5.1：本项目渲染层与主进程状态机分离，数据放渲染层会绕开 TaskStore 的唯一写入口） |
| 核实方式 | `api.github.com/repos/cassidoo/todometer`、`.../contents/`（2026-10-22） |

---

### 2.4 troyedwardsjr/redux-electron-todo-example —— 明确「住在系统托盘」的 todo

| 字段 | 值 |
| --- | --- |
| 仓库 | `troyedwardsjr/redux-electron-todo-example` · https://github.com/troyedwardsjr/redux-electron-todo-example |
| Star | **47**（✅GitHub 搜索 API，2026-10-22） |
| 许可证 | **无**（仓库元数据 `license: null`，✅GitHub 搜索 API） |
| 语言 / 活跃度 | JavaScript；最近 push **2016-04-19**（✅API） |
| 官方描述 | 「React + Redux + Electron + Material UI + Sass + Browserify + Gulp Todo List Application example that lives in your system tray.」（✅API） |
| 仓库结构（✅API） | 根：`app/`、`src/`、`gulpfile.js`（5,346 B）、`package.json`（1,319 B）、`.babelrc`、`.eslintrc`、`README.md`（1,228 B） |
| 数据模型 / 持久化 | ⚠️未核实 |
| IPC / 渲染架构 | ⚠️未核实；但「tray 常驻 + 点开一个小窗口」的产品形态可由官方描述与目录确认 |
| 可借鉴 | ① 产品形态与本项目一致：**托盘常驻，点开才出现一个小窗口**；② 把「列表状态」放在单一 store（Redux）里，所有入口（托盘菜单 / 窗口 / 快捷键）只 dispatch，不改状态副本——这正是本项目 `TaskStore.apply()` 唯一写入口的思路 |
| 坑 / 不要学 | ① **无 LICENSE = 不能复制其代码**，只能看思路；② 2016 年 Browserify + Gulp + Babel 工具链，与本项目「零打包器 + tsc」完全相反；③ 十年未更新，Electron 安全基线早已过时 |
| 核实方式 | `api.github.com/repos/troyedwardsjr/redux-electron-todo-example`、`.../contents/`（2026-10-22） |

---

### 2.5 xiajingren/xhznl-todo-list —— 中文「便签式」小窗 todo（反面教材属性强）

| 字段 | 值 |
| --- | --- |
| 仓库 | `xiajingren/xhznl-todo-list` · https://github.com/xiajingren/xhznl-todo-list |
| Star | **318**（✅API 2026-10-22） |
| 许可证 | **无**（仓库元数据 `license: null`，✅API） |
| 语言 / 活跃度 | JavaScript；最近 push **2022-09-03**，24 个 open issues（✅API） |
| 官方描述 | 「一个使用 electron + vue + electron-builder 开发的跨平台 todolist（便签）桌面应用」（✅API） |
| 仓库结构 / 持久化 | ⚠️未核实（根目录内容未逐项拉取；未读源码） |
| 可借鉴 | ① 「便签式」交互对本项目面板有参考：一行一条、点一下就勾掉、不要弹窗；② electron-builder 跨平台打包思路（本项目已在用） |
| 坑 / 不要学 | ① **无许可证**：默认保留所有权利，**不能复制代码**（只能阅读思路）；② 停更 4 年 + 24 个未处理 issue，不要以其行为作为「正确语义」的依据 |
| 核实方式 | `api.github.com/repos/xiajingren/xhznl-todo-list`（2026-10-22） |

> 备注：GitHub 搜索条目的 license 字段在部分仓库为 `null`（即无许可证）。上表一律以 `/repos/<name>` 端点返回的 `license` 为准；搜索页里「看起来有 license」的条目可能是相邻条目的错位，不要采信。

---

### 2.6 deathart/todolist-electron —— 唯一找到的「原生 JS + Electron」小体量 todo（且已归档）

| 字段 | 值 |
| --- | --- |
| 仓库 | `deathart/todolist-electron` · https://github.com/deathart/todolist-electron |
| Star | **3**（✅API 2026-10-22） |
| 许可证 | **GPL-3.0**（✅API） |
| 语言 / 活跃度 | JavaScript；**archived = true**；最近 push **2019-11-06**（✅API） |
| 官方描述 | 「Todo list developed in javascript with Node JS & Electron」（✅API） |
| 仓库结构（✅API） | 根：`app/`、`ressources/`、`gulpfile.js`（2,818 B）、`package.json`（2,585 B）、`reporter.js`、`dev-app-update.yml`、`LICENSE`、`code_of_conduct.md`、`contributing.md`；`app/` 内：**`main.js`（7,394 B）**、`html/`、`locales/` |
| 数据模型 / 持久化 | ⚠️未核实（未读 `main.js` / `html/` 内脚本） |
| IPC / 渲染架构 | ✅结构可证：**单主进程文件 `app/main.js` + 静态 `app/html/`（jQuery/Handlebars 时代写法）+ `app/locales/` 国际化目录**；无独立 preload 文件 |
| 可借鉴 | ① **体量控制**：主进程 7 KB 就能撑起一个 todo，说明「简单 todo」不需要框架；② `locales/` 单列目录的做法的确划算；③ 用 `electron-builder` 打包的配置可直接对照本项目 `electron-builder.yml` |
| 坑 / 不要学 | ① **Electron 2.x 时代**（据 `package.json` devDependencies，⚠️依赖清单未核实）：`nodeIntegration` 默认开启、无 contextIsolation，**不能照抄它的主/渲染连接方式**；② 无 preload 白名单 = 本项目明确禁止的模式；③ 已归档、3★、无测试；④ GPL-3.0 有传染性，不要复制代码进 MIT 项目 |
| 核实方式 | `api.github.com/repos/deathart/todolist-electron`、`.../contents/`、`.../contents/app`（2026-10-22） |

---

## 3. 备选清单（只核了 star，够用来判断「值不值得再花时间」）

| 仓库 | Star（✅搜索 API 2026-10-22） | 官方描述要点 | 备注 |
| --- | --- | --- | --- |
| `tonylu110/uyou-todo-electron` | 372 | todo list with electron（TypeScript，topic 含 electron/vue3/tsx） | 技术栈是 Vue3，与本项目不同；license 见仓库页，本文未核 |
| `czytelny/backlog` | 434 | 「Simple desktop app for storing lists of items」 | Vue + Electron，偏「列表管理」 |
| `CodeDraken/electron-todo` | 62 | 「Todo app made in Electron」 | 无 license（搜索条目 `license: null`） |
| `Vj3k0/ea-todo` | 67 | Electron + AngularJS 的简单 todo | 2016 年，仅历史参考 |
| `gorkys/To-Do-List` | 36 | electron-vue 待办 | 无 license |
| `RStankov/FocusedTask` | 149 | 见 §2.2 | — |

> 结论：**没有找到「零框架 + preload 白名单 + 单文件 JSON + 有测试」的现成开源实现**。本项目要的组合需要自己拼，但每一块都有可参考的单点。

---

## 4. 横向模式对比

### 4.1 形态：托盘 / 菜单栏 / 悬浮面板

| 形态 | 代表 | 交互要点 | 对本项目的提示 |
| --- | --- | --- | --- |
| 系统托盘 + 点开小窗 | `troyedwardsjr/redux-electron-todo-example`（官方描述） | 托盘图标常驻，窗口按需显示/隐藏；列表状态在单一 store | 本项目已有 tray + panel，todo 只需在 panel 里加一段，不要新增窗口 |
| 菜单栏弹出（macOS） | `FocusedTask` | 固定尺寸、失焦收起、快捷键唤起 | 面板尺寸固定（本项目 420×≤520）比「按内容自适应」稳；列表内部滚动 |
| 刘海/悬浮工作台 | `TO-DO-Panel` | 多模块（待办/速记/链接/录音）共用一个面板 | 面板空间稀缺：todo 区必须限高 + 滚动，不能挤压任务灯区 |

### 4.2 数据持久化：三种可选路线

| 路线 | 代表 / 事实 | 优点 | 代价 | 适用判断 |
| --- | --- | --- | --- | --- |
| **`userData` 下整文件 JSON（自写）** | 本项目 `config.ts` 已经在写 `userData/config.yaml`（✅本仓库代码：`app.getPath('userData')` + `fs.writeFileSync` + `.bak` 备份） | 零依赖、可 diff、可手工修；单文件几十 KB 完全无压力 | 崩溃时可能写坏；需要自己实现原子写/恢复 | **推荐**：todo 量级（几十~几百条）用这个 |
| **electron-store（npm 库）** | `sindresorhus/electron-store`：**5026★、MIT**，官方描述「Simple data persistence for your Electron app or module - Save and load user preferences, app state, cache, etc」（✅API 2026-10-22，最近 push 2026-10-12，topic 含 `data-persistence`/`storage`） | 省掉「读写 + 默认值 + schema 校验」的样板代码；主进程/渲染层都能用 | 引入依赖，违背本项目「不顺带引入依赖」的约定；其最新版对 Electron 版本的兼容性**未核实** | 本项目**不建议**引入（既有 YAML 配置已证明手写够用） |
| **SQLite** | 本项目已在监控层用 SQLite 读取（`src/main/monitors/sqlite.ts`），说明「读别人库」可行 | 事务、并发、查询能力强 | 写库需原生模块/`node:sqlite`，Electron 33 自带 Node 20.x（⚠️版本对应未核实）→ 引入 native rebuild 与打包体积，收益对「小面板 todo」为负 | **不推荐**：用不上事务和查询 |

**「不丢数据」的最小工程要求（判断，非仓库事实）**：
1. **原子替换**：写 `todo.json.tmp` → `fsync` → `fs.renameSync(tmp, target)`（同目录 rename 在 Windows 上可覆盖目标文件）；本项目现有 `config.ts` 是**直接 `writeFileSync`**，中途崩会留下半截文件——如果 todo 复用同一写法，就是同一个隐患。
2. **防抖合并**：勾选/输入是高频小写入，200–500 ms 防抖 + `flush on quit`（`before-quit` 里同步落盘）。
3. **损坏恢复**：启动 `JSON.parse` 失败 → 尝试 `.bak` → 都不行则用空表并在面板上提示「待办数据读取失败，已重置（旧文件保留为 todo.json.corrupt-<ts>）」，**绝不静默清空**。
4. **写前备份**：沿用 `config.ts` 已有 `${path}.bak` 策略，保持项目内一致。

### 4.3 IPC / 状态同步：谁持有 todo 数据？

| 模式 | 代表 | 风险 |
| --- | --- | --- |
| 主进程持有 + 推送快照 | 本项目现状：`TaskStore` 是唯一数据源（`store.ts` 注释「主进程唯一数据源」），渲染层只 `getSnapshot` + 订阅 `IPC_PUSH.SNAPSHOT`（✅本仓库） | 需要为 todo 新增一条 push 通道，否则面板刷新时机不一致 |
| 渲染层持有 + 自己存 | 多数「Electron + React」教学项目 | 数据与主进程状态机分家；多窗口（灯 + 面板）出现两份真相；`file://` 下的 localStorage 清缓存即丢 |
| 中间层 store（electron-store 等） | `FocusedTask` 的 Redux + 可能的持久化中间件（⚠️未核实） | 状态库与窗口生命周期耦合，托盘菜单改数据时不一定触发面板刷新 |

本项目已有的强约束（✅读代码核实）：
- `src/shared/ipc-contract.ts`：**通道名只在一处定义**，注释明确「任何主/渲染侧代码都不得写裸字符串」；`InvokeMap` 把「请求→响应」类型钉死；`RendererApi` 是 preload 白名单的契约。
- `src/preload/preload.ts`：`contextIsolation: true`、`nodeIntegration: false`，只暴露 `RendererApi` 的方法，不 open 整个 `ipcRenderer`；订阅函数返回「取消订阅」。
- `src/main/panel.ts`：面板 `width=420`、高度 `min(520, 工作区 70%)`、`frame:false`、`alwaysOnTop`、`skipTaskbar`，**懒创建**。
- `src/shared/visibility.ts`：主进程与渲染层共用「哪些行可见」的判定（`unknown`/`failed` 隐藏），因为窗口尺寸和渲染必须同口径。

→ 因此 todo 的正确接入方式是：**新增 `todo:*` 通道到 `ipc-contract.ts`（含 `InvokeMap` + `RendererApi` 方法）→ 主进程 `TodoStore` 落盘 → 变更后像 `SNAPSHOT` 一样 push 给面板**。不要用第二个数据源。

### 4.4 列表 UI 细节（小窗口场景的经验条款）

| 细节 | 建议 | 理由 / 来源 |
| --- | --- | --- |
| 空状态 | 一行灰字（如「暂无待办，回车添加」）+ 快捷输入框常驻焦点 | 小面板没有按钮空间；`todometer`/`TO-DO-Panel` 都把输入放在首屏（形态判断） |
| 超长文本 | 单行 `text-overflow: ellipsis` + `title` 全文；编辑时再展开 | 420 px 宽，两行就会撑爆行高导致列表跳动 |
| 完成态 | 删除线 + 降低透明度 + 保持行高不变；不要用 `display:none` 直接移除 | 直接移除会让列表「跳一下」，误点后也无法撤销 |
| 勾选可访问性 | 用真实 `<input type="checkbox">` 或 `role="checkbox"` + `aria-checked`；整行 label 可点 | 原生控件自动获得键盘/读屏支持，零成本 |
| 键盘 | `Enter` 新增；`Esc` 清空输入（再按收起面板）；`Ctrl+Z` 撤销最近一次删除（可选） | 面板常驻焦点，键盘优先是这类工具的核心体验 |
| 滚动 | 列表容器 `flex:1; min-height:0; overflow-y:auto`，**窗口高度不随条数变化** | 面板高度已由 `panel.ts` 固定；若让 todo 数量驱动尺寸，会与 `countVisibleTasks()` 的尺寸逻辑打架（本项目踩过同类 bug，见 `visibility.ts` 注释） |
| 排序 | 未完成在上、完成在下；同组按 `createdAt` 升序（或新任务置顶）；提供「清除已完成」 | 简单可预测；不要做拖拽排序（成本高、小面板易误触） |
| 删除 | 二次确认或 3 秒内撤销，优于直接删 | 小面板误触概率高，且没有回收站 |

---

## 5. 对本项目的可借鉴结论（≤5 条）

**1）数据归属：todo 必须放主进程，沿用「唯一数据源 + 快照推送」骨架。**
新建 `src/main/todo-store.ts`（纯 Node，不 import electron，便于 vitest 直接测，做法同 `store.ts`），在 `ipc-contract.ts` 增加 `todo:list` / `todo:add` / `todo:toggle` / `todo:remove` 到 `InvokeMap`，并把 `getTodos()` / `onTodos()` 加进 `RendererApi` 白名单；变更后 push 一条 `IPC_PUSH.TODOS`。**不要**把 todo 塞进 `TaskStore` 的状态机（todo 不是任务运行态，不参与 `ALLOWED_TRANSITIONS`），也**不要**放渲染层。

**2）持久化：`userData/todo.json` 单文件 + 原子写 + 防抖 + 损坏恢复。**
不引 electron-store（5026★/MIT，✅但本项目约定「不顺带引入依赖」），不上 SQLite（小数据无收益、native 模块有打包成本）。写盘补上 `tmp + fsync + rename`（现有 `config.ts` 是直接 `writeFileSync`，这对 todo 是真实风险），200–500 ms 防抖 + 退出时 flush，解析失败回退 `.bak` 并保留损坏文件。

**3）数据模型保持「可迁移」和「不污染可见性规则」。**
`{ schemaVersion, items: [{ id, title, done, createdAt, updatedAt }] }`；todo 是否展示由 todo 模块自己的过滤决定，**不要复用** `isTaskVisible()` / `countVisibleTasks()`（它们服务于任务运行态与窗口尺寸，复用会让「隐藏 failed/unknown」的语义渗进 todo，且空列表时窗口尺寸逻辑会互相干扰）。

**4）UI：列表限高内部滚动，窗口尺寸不随 todo 条数变化；空态 + 快捷输入 + 原生 checkbox。**
420 px 面板里给 todo 一个固定 `flex` 区域（`overflow-y:auto; min-height:0`），完成态用删除线+透明而非移除，超长文本 ellipsis，键盘 Enter/Esc 优先，删除要能撤销。这样不会破坏 `panel.ts` 既有的尺寸契约。

**5）只借「主进程持数据 + 小面板 + 单文件 JSON」三件事，其余一律不抄。**
不抄 `TO-DO-Panel` 的 130 KB 单文件主进程、不抄 `FocusedTask` 的 macOS menubar 专属逻辑、不抄 2016 年项目的 `nodeIntegration` 写法；**无许可证仓库（`troyedwardsjr`、`xhznl`、`ea-todo` 等）只看思路不复制代码**；引入前先跑本项目 specTDD 流程（spec → Red → Green），别用别人的行为定义自己的语义。

---

## 6. 检索词与 URL 清单

### 6.1 检索词（实际使用）

- GitHub REST 搜索：`electron todo`（sort=stars，per_page=25）
- GitHub REST 搜索：`electron todo javascript in:name,description`（sort=stars，per_page=6）
- 计划但环境不可用：web 搜索（`electron todo minimal github`、`electron menubar todo app`、`electron userData json atomic write`）——`web_search` 返回 HTTP 402，未执行成功
- 代码级复核（本次未执行成功）：`/search/code?q=localStorage+repo:<repo>` 返回 **401 Requires authentication**

### 6.2 URL 清单（全部于 2026-10-22 访问）

已核实项目：
1. https://github.com/xiaopu-ai/TO-DO-Panel · API：https://api.github.com/repos/xiaopu-ai/TO-DO-Panel · 目录：https://api.github.com/repos/xiaopu-ai/TO-DO-Panel/contents/
2. https://github.com/RStankov/FocusedTask · API：https://api.github.com/repos/RStankov/FocusedTask · 目录：`/contents/`、`/contents/app`、`/contents/app/src`
3. https://github.com/cassidoo/todometer · API：https://api.github.com/repos/cassidoo/todometer · 目录：`/contents/`
4. https://github.com/troyedwardsjr/redux-electron-todo-example · API：https://api.github.com/repos/troyedwardsjr/redux-electron-todo-example · 目录：`/contents/`
5. https://github.com/xiajingren/xhznl-todo-list · API：https://api.github.com/repos/xiajingren/xhznl-todo-list
6. https://github.com/deathart/todolist-electron · API：https://api.github.com/repos/deathart/todolist-electron · 目录：`/contents/`、`/contents/app`

持久化备选库：
7. https://github.com/sindresorhus/electron-store · API：https://api.github.com/repos/sindresorhus/electron-store（5026★ / MIT / 描述见 §4.2）

备选（仅核 star）：
8. https://github.com/tonylu110/uyou-todo-electron
9. https://github.com/czytelny/backlog
10. https://github.com/CodeDraken/electron-todo
11. https://github.com/Vj3k0/ea-todo
12. https://github.com/gorkys/To-Do-List

本项目内已核实的对照代码：
13. `src/main/store.ts`（唯一状态写入口 / 禁止转移表）
14. `src/shared/ipc-contract.ts`（通道名单点定义 + InvokeMap + RendererApi 白名单）
15. `src/preload/preload.ts`（contextBridge 白名单、订阅返回退订函数）
16. `src/main/panel.ts`（420 × ≤520、frameless、alwaysOnTop、懒创建）
17. `src/main/config.ts`（userData YAML、`.bak` 备份、内容相等判据、直接 `writeFileSync`）
18. `src/shared/visibility.ts`（主/渲染共用的可见性口径）

### 6.3 未完成项（如实记录）

- 未能逐行阅读任何外部仓库的 `main.js` / `preload.js` / `package.json`（本环境 raw 文件不可读），因此「数据模型」「持久化实现细节」「IPC 通道名单」这些需要源码才能确认的字段，本文一律标 ⚠️未核实。
- 未运行 `npm install`、未 clone 任何仓库（符合任务约束）。
- 建议在能正常出网的环境补做：`git clone --depth 1` 上述 6 个仓库，重点看 `main.js`/`preload.js` 里 `ipcMain.handle` 的注册方式、写盘调用（`writeFile` / `electron-store` / `localStorage`）与窗口参数。
