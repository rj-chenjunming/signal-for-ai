# SPEC-016：Windows 双击启动入口

> 状态：done
> 类型：feature
> 需求来源：2026-10-21 用户“补充一个启动程序或者脚本”。
> 负责人：Codex
> 基线：662f41b＋保留的SPEC-015未提交修改；系统Node24.16.0，Windows10.0.26200。
> 需求依据及假设：用户需要本地可直接运行的入口；不要求打包安装程序。沿用既有Electron/原生DOM/tsc架构及本地配置。
> 关联：SPEC-018参数与环境清理；本机已确认仓库目录内Electron退出而临时目录相同版本可运行。

## 1. 问题与目标

普通 npm start 需要手动定位仓库、构建和处理运行时路径。本机已有同版本临时Electron工作路径，但用户不应记住带日期的路径。提供根目录可双击的cmd和Node启动助手，使用当前项目与配置，不依赖调用者工作目录。

## 2. 范围与非目标

- 根目录启动指示灯.cmd定位自身目录、检查Node；助手要求Node>=22.5（推荐24），缺依赖明确说明、不自动联网安装。
- config.local.yaml存在则原样使用，不存在才从config.desktop.example.yaml以独占创建方式复制；不输出配置内容/凭据。
- dist入口缺失时调用现有npm构建；已存在则直接启动，源码更新需先构建。不另造打包器或依赖。
- 先探测当前Electron --version；不可运行时，将本项目同版本Electron复制到TEMP下独立目录再探测，复用缓存前核对版本及运行时所有文件SHA-256。忽略的日志收据只记录路径，不修改全局环境/系统权限，不下载二进制。
- 始终经scripts/start.mjs启动，保留环境清理/GPU参数和Electron单实例机制；失败保留退出码并让cmd暂停显示原因，正常托盘退出不暂停。
- --check仅验证Node/依赖/运行时，不创建本地配置、不构建或启动界面，便于无干扰验收。主助手无参数时启动，拒绝未知参数。
- 不结束已有指示灯/工具；再次启动由Electron单实例入口唤起已有面板。日志/个人配置/运行时不提交。

## 3. 验收条件

| ID | Given | When | Then |
| --- | --- | --- | --- |
| AC-01 | 从任意工作目录双击 | 运行cmd | 以脚本所在仓库运行助手，Node缺失/旧版本/依赖缺失明确失败并保留窗口 |
| AC-02 | 有/无本地配置，dist有/无 | 正常启动 | 保留原配置；缺配置从模板独占复制；缺dist先构建，构建失败不拉起Electron |
| AC-03 | 原运行时可用/崩溃、缓存匹配/被改/缺失、复制或探测失败 | 选择运行时 | 首选可用原版；失败时只复制本项目同版本文件到临时目录，完整校验复用缓存；错误不掩盖、不改系统权限 |
| AC-04 | 启动返回失败或已有实例 | 执行 | 保留失败退出码；单实例由既有应用保护，不重复后台实例；--check不启动应用 |

## 4. 方案与切片

先新增启动助手契约测试，在实现前运行得到行为缺失的有效Red；再加入模块化助手与cmd。运行时探测/复制可注入，隔离测试不启动个人Electron；真实--check验证运行时，双击UI验收有条件时再做。无PowerShell执行策略修改，无安装下载。

## 5. 测试追踪

| AC | 测试 | Red | Green | 平台 |
| --- | --- | --- | --- | --- |
| AC-01～04 | test/desktop-start.test.ts，前置、配置、构建、运行时回退/篡改/失败、退出码 | entry/behavior/boundary-valid日志，exit1 | 本文件10项＋旧启动器6项通过，完整824项通过 | 实际--check冷/热复用、cmd跨目录冷启动及已有实例复用均通过，见交付记录 |

## 6. 执行记录

保留SPEC-015改动及运行中的指示灯，TDD无例外；全量typecheck→test→build→smoke重新执行。桌面审批服务此前因使用额度未完成审核，若仍不可用则如实记录，不绕过审批或把mock当真机。

- 08:42:48入口检查Red：`npm test -- test/desktop-start.test.ts --maxWorkers=2 --minWorkers=1`，exit1，缺少双击入口断言失败，`logs/spec016-entry-red.log`。添加仅返回1的助手骨架后，08:43:44行为Red 5项失败/2项通过（配置保护/创建、构建退出码、运行时回退、启动退出码），`logs/spec016-behavior-red.log`；未用模块导入失败作Red。
- 最小助手实现后，与旧启动器共13项通过、exit0，`logs/spec016-green.log`。
- 08:44边界检查先遇cmd测试夹具引号错误（保留`logs/spec016-boundary-red.log`，该部分不算产品Red）。修正为Windows原样参数call后，08:45:10两个独立产品断言有效失败：接受错误版本、构建exit0但无产物仍启动；`logs/spec016-boundary-valid-red.log`。加入物理运行时版本与构建产物检查后，08:45:24共16项通过（含真实隔离cmd、带空格目录、运行时副本篡改后重建），`logs/spec016-final-green.log`。
- 真实`node scripts/start-desktop.mjs --check`：exit0，Node24.16.0，原目录Electron失败后复制并校验同版本到TEMP，探测成功；没有创建/改写个人配置或拉起GUI。副本路径仅在忽略收据logs/desktop-runtime.json，不写入共享源码。

## 7. 交付

- `npm run typecheck`：exit0，`logs/spec016-typecheck-final.log`。
- 首轮全量：823通过/1失败，exit1，`logs/spec016-full-test.log`。失败为原有真实dsh扫描用例要求至少一个服务，而当时进程/49622监听均不存在；没有改断言、跳过用例或建立假服务。08:49真实dsh重新运行，应用选中64080并认证成功；在此前置条件恢复后重新按顺序验证，08:51:22全量53文件824项通过、无跳过、exit0，`logs/spec016-full-final.log`。保留两轮记录，不将首轮失败算成通过。
- `npm run build`→`npm run smoke`：均exit0，`logs/spec016-build-final.log` / `logs/spec016-smoke-final.log`；`git diff --check` exit0。
- 真实--check冷准备与缓存复用均exit0，完整运行时校验通过；个人配置与六项Hook复核保留。
- 08:48实际执行根目录cmd，从TEMP工作目录启动，主PID12144，使用自动准备的TEMP同版本运行时，应用日志记录托盘/悬浮灯/三个监控器创建及启动完成。原生桌面枚举与截图确认指示灯窗口出现。再次执行真实cmd入口exit0，原主PID12144不变，并出现原实例任务面板，验证单实例复用。日志`logs/spec016-runtime.log` / `logs/spec016-runtime-error.log`。
- cmd跨目录与空格路径由真实隔离Windows包装器验证，失败退出码由助手测试保护；cmd的非零退出后pause分支经源码检查，未做人工按键验收。没有修改系统执行策略或权限，没有联网下载。共享入口不包含个人路径/凭据；临时副本路径只记在忽略收据。
- SPEC-016启动入口验收完成，应用保持运行。SPEC-015曾独立等待WorkBuddy关闭确认；随后用户明确确认且元数据复核通过，另在015记录，不因本规格完成直接推定通过。源码更新后需先构建；cmd应保留在仓库中，可创建快捷方式使用，不能单独复制。没有自动提交或推送。
