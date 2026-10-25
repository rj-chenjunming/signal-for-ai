# SPEC-039：Electron 升级 33 → 34.5.8

> 状态：done
> 类型：chore（依赖升级，运行时变更）
> 需求来源：用户 2026-10-24 拍板（逐项决策第 1 项）。事实依据：仓库 pin 的 Electron 33.4.11 在本机初始化即崩（0xC0000005，见 SPEC-031 §6 环境记录——`--version` 正常、33 系已无更新版本、10-21 后本机应用日志为空）；实测 Electron 34.5.8 在同机正常（最小应用 `READY ok`，退出码 0）。
> 负责人：AI 协作（dreaming）
> 基线提交与环境：SPEC-031~038 完成后的工作区；Windows 10.0.26200 x64，Node v24.16.0。
> 需求依据及假设：33 系最后一版 33.4.11 就是当前坏的地基，无补丁可等；34.5.8 为 34 系最新且实测可跑。假设：Electron 34（Chromium 132 / Node 20.18）对本项目的 API 面无破坏性变更——`package.json` 无 electron 相关编译依赖，主进程用的 BrowserWindow/Tray/globalShortcut/ipcMain 等均为稳定 API；以全量回归验证该假设，失败则回退。
> 关联/替代条款：SPEC-031 §6 环境记录（33 崩溃证据链）；`docs/development/testing.md` 的 AITI_ELECTRON 说明（升级后 pin 版可用，夹具回归用 pin 版，解除"Electron 33 复核"挂起项）。

## 1. 问题与目标

Electron 33 在本机无法初始化，应用疑似自 10-21 起无法启动，渲染层验证被迫借 31.7.7。目标：pin 升至 34.5.8，本机可正常启动与验证；全量回归通过。

## 2. 范围与非目标

- 本次包含：`package.json` 的 electron 版本（^33.0.0 → ^34.5.8）、重装、全量回归（typecheck / npm test / build / smoke / check:ui / check:goals，夹具用 pin 版而非 AITI_ELECTRON）。
- 本次不包含：35 系评估（用户已选 34）；electron-builder 打包链验证（`npm run dist` 未在本轮范围，发布时另验）；借来的 /tmp 临时 Electron 副本清理（系统临时目录，自生自灭）。
- 受影响：package.json、package-lock 情况（仓库不提交 lockfile，本地安装用 `--package-lock=false`）。

## 3. 验收条件

| ID | Given（前置） | When（动作/事件） | Then（可观测结果） |
| --- | --- | --- | --- |
| AC-01 | 升级安装完成 | `npx electron --version` | 输出 34.5.8 相关版本，退出码 0 |
| AC-02 | 升级后 | typecheck / npm test / build / smoke | 全部退出码 0，测试数不少于 952 |
| AC-03 | 升级后（**不设** AITI_ELECTRON） | check:ui / check:goals | 用 pin 版 Electron 全部通过——SPEC-031~037 的"Electron 33 复核"挂起项就此解除 |
| AC-04 | 升级后 | 双击启动指示灯（真机） | 应用正常启动（用户确认，非本规格自动化范围） |

边界：升级失败/回归不过 → 回退 ^33.0.0 并记录（不硬上）。

## 4. 方案与任务切片

单切片：改版本 → `npm install --package-lock=false` → AC-01→03 顺序验证 → 记录。

## 5. 测试计划与追踪

| AC | 测试/步骤 | Red 证据 | Green 证据 | 回归/平台验收 |
| --- | --- | --- | --- | --- |
| AC-01 | `npx electron --version` | 不适用（环境前置） | 待运行 | 待运行 |
| AC-02 | 全量命令 | 不适用 | 待运行 | 待运行 |
| AC-03 | 夹具（pin 版） | 不适用 | 待运行 | 待运行 |
| AC-04 | 真机双击启动 | 不适用 | 未运行 | 未运行（用户） |

## 6. 执行记录

- 修改前回归：SPEC-037 完成时全绿（952/952，借 31.7.7 跑夹具）。
- **根因修正（推翻 SPEC-031 §6 的"Electron 33 版本问题"结论）**：升级过程中发现同一份 Electron 二进制（sha256 相同）在 `/tmp`、`PRJ\` 上级、兄弟目录 `ai-signal2` 均正常运行，唯独放进本仓库目录必崩（0xC0000005）；Electron 31 放入仓库同样崩。即**版本无辜，位置有毒**。定位到仓库根 ACL 被某沙箱工具写入了毒性条目：`Everyone:(CI)(DENY)(DC)` + `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`（并伴随 `CodexSandboxUsers` 等非继承授权）。铁证：同目录下加 `--no-sandbox` 即可正常运行——Chromium 沙箱初始化在该 ACL 下崩溃。时间线吻合：毒 ACL 应为 2026-10-20/21 间被写入（当天已有 electron 崩溃转储与应用日志中断）。
- **修复**（可回滚）：`icacls C:\Users\chen\PRJ\ai-signal /save` 备份至 `C:\Users\chen\PRJ\acl-aisignal-backup.txt` → `/remove:d Everyone` 删除 DENY → `/setintegritylevel (OI)(CI)M` 低完整性提到中。修复后仓库内 Electron 34.5.8 **默认沙箱**正常运行（`--version` 与最小应用均退出码 0）。
- **升级执行**：package.json `^33.0.0` → `^34.5.8`；npm postinstall 在本机反复解压不完整（dist 只出 locales），以镜像缓存 zip 手动解压 + 补写 `path.txt` 完成（zip 完整性 `unzip -t` 通过；`require('electron')` 依赖 path.txt）。
- **验证（全部真实退出码，pin 版 Electron 34.5.8、不设 AITI_ELECTRON、仓库目录内）**：typecheck 0；`npm test` 952/952；build 0；smoke 0；check:ui 35 用例 0；check:goals 0。SPEC-031~037 的"Electron 33 运行时复核"挂起项就此解除（夹具已回到 pin 版）。
- 遗留清理：测试用的临时目录已删（`PRJ\ai-signal2`、`PRJ\e34-p`、仓库内 `e34-test*`）；ACL 备份文件保留在 `C:\Users\chen\PRJ\acl-aisignal-backup.txt` 供回滚。
- TDD 例外：依赖/环境变更，无行为 Red；以全量回归为验收。
- AC-04（2026-10-25）：应用经 npm start --config config.local.yaml 启动（等效验证核心链路：Electron 34 在仓库目录内默认沙箱运行），用户全程操作约 27 分钟后托盘退出，退出码 0、日志干净、无残留进程。
- 需求变更记录：无。

## 7. 交付与验收

- [x] AC-01~03 有验收证据（见 §6）。
- [x] 类型检查、全量测试、构建后 smoke 及夹具检查已记录。
- [x] 规格索引已更新；ACL 备份在仓库外，无秘密入库。
- [ ] AC-04（真机双击启动指示灯）待用户确认 → 保持 `verifying`。

最终结果/提交引用：未提交（与 SPEC-031~038 同一工作区）。
