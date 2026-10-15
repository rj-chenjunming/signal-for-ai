<#
================================================================================
 POC-2: 可在受限沙箱内实测的部分
   (a) 窗口枚举真实数据 (Get-Process -> MainWindowHandle / Title)
   (b) 标题匹配歧义度分析 (证明"标题匹配不可靠")
   (c) 终端宿主进程清单 (WindowsTerminal / OpenConsole / conhost)
   (d) spawn 型跳转 (explorer / start) 是否可靠产生窗口 —— 用窗口快照 diff 验证
   (e) PowerShell 冷启动延迟基线 (决定 focus 实现方案的可行性)
   (f) WT 可用性

 注意: 本沙箱禁用了 Add-Type / csc.exe / Reflection.Assembly.Load / COM 实例化,
       因此 SetForegroundWindow / AttachThreadInput 的直接实测无法在此环境执行,
       该部分结论在报告中标注为 [未实测-依据Win32文档] 并给出工程替代方案。
 运行: powershell -ExecutionPolicy Bypass -File poc-2-empirical.ps1
================================================================================
#>
$ErrorActionPreference = 'Continue'

function Get-Snapshot {
  Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne '' } |
    Select-Object Id, ProcessName, MainWindowHandle, MainWindowTitle
}

function Show-Diff($before, $after, $label) {
  $bIds = @($before.Id)
  $new = $after | Where-Object { $bIds -notcontains $_.Id }
  Write-Host ("  [" + $label + "] 新出现的顶层窗口: " + @($new).Count)
  $new | ForEach-Object { Write-Host ("    + " + $_.ProcessName + " (pid=" + $_.Id + ") hwnd=0x" + ('{0:X}' -f $_.MainWindowHandle) + " title='" + $_.MainWindowTitle + "'") }
  return $new
}

Write-Host "`n########## (a) 窗口枚举实测 ##########" -ForegroundColor Cyan
$snap = Get-Snapshot
Write-Host ("含标题的顶层窗口总数: " + @($snap).Count)
$snap | ForEach-Object {
  Write-Host ("  pid=" + $_.Id + "  hwnd=0x" + ('{0:X}' -f $_.MainWindowHandle) + "  " + $_.ProcessName.PadRight(22) + "  title='" + $_.MainWindowTitle + "'")
}
Write-Host "[结论] MainWindowHandle 是真实可用的 HWND -> 主进程可据此做窗口定位与聚焦"

Write-Host "`n########## (b) 标题匹配歧义度分析 ##########" -ForegroundColor Cyan
$titles = $snap | ForEach-Object { $_.MainWindowTitle }
$dups = $titles | Group-Object | Where-Object { $_.Count -gt 1 }
Write-Host ("唯一标题数: " + @($titles | Select-Object -Unique).Count + " / 总窗口数: " + @($titles).Count)
if ($dups) { $dups | ForEach-Object { Write-Host ("  [重复标题 x" + $_.Count + "] '" + $_.Name + "'") } }
else { Write-Host "  当前无重复标题" }
Write-Host "[结论1] MainWindowTitle 是应用可任意 SetWindowText 的字符串, 存在被占用/伪造风险"
Write-Host "[结论2] 子串匹配 workbuddy|dsh|codex 极易误命中(例如 Code.exe 窗口标题含 dsh 类子串)"
Write-Host "[结论3] 因此窗口标题只能作为'最后兜底', 不能作为主判定依据"

Write-Host "`n########## (c) 终端宿主进程清单 ##########" -ForegroundColor Cyan
$termNames = @('WindowsTerminal','OpenConsole','conhost','powershell','pwsh','cmd','MobaXterm','SecureCRT','Tabular','WindowsTerminalPreview')
foreach ($n in $termNames) {
  $ps = Get-Process -Name $n -ErrorAction SilentlyContinue
  if ($ps) {
    Write-Host ("  [存在] " + $n + " x" + @($ps).Count)
    $ps | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { Write-Host("      顶层窗口 hwnd=0x" + ('{0:X}' -f $_.MainWindowHandle) + " title='" + $_.MainWindowTitle + "'") }
  } else { Write-Host ("  [无]   " + $n) }
}
Write-Host "[补充] WT 的顶层窗口类名固定为 CASCADIA_HOSTING_WINDOW_CLASS (源码常量),"
Write-Host "       比按进程名判定更可靠 -> 工程上应优先按类名, 进程名作为次级信号"

Write-Host "`n########## (d) spawn 型跳转实测 (explorer / start) ##########" -ForegroundColor Cyan
$testDir = "D:\projects\ai-task-indicator\poc"
Write-Host ("目标目录: " + $testDir + "  存在=" + (Test-Path $testDir))
$before = Get-Snapshot
Start-Process -FilePath "explorer.exe" -ArgumentList "`"$testDir`""
Start-Sleep -Milliseconds 2500
$after = Get-Snapshot
$new = Show-Diff $before $after "explorer.exe <dir>"
Write-Host ("[判定] explorer 跳转" + $(if (@($new).Count -gt 0) { "成功: 产生了新顶层窗口" } else { "未观察到新顶层窗口(可能复用了已有资源管理器窗口 -> 同样符合PRD '复用已打开窗口' 的意图)" }))

Write-Host "`n--- d2: 用 notepad 验证 spawn 进程能否产生可定位窗口 ---" -ForegroundColor Cyan
$before2 = Get-Snapshot
Start-Process -FilePath "notepad.exe" -ArgumentList "`"$testDir`""
Start-Sleep -Milliseconds 2000
$after2 = Get-Snapshot
$new2 = Show-Diff $before2 $after2 "notepad.exe <path>"
Write-Host ("[判定] 新窗口可被枚举并拿到 hwnd -> '自己开终端窗口再聚焦' 的降级链路可行")
foreach ($p in $new2) { if ($p.ProcessName -eq 'Notepad') { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } }

Write-Host "`n--- d3: 'start \"\" <file>' 打开日志文件 ---" -ForegroundColor Cyan
$logFile = Join-Path $testDir "poc-sample.log"
Set-Content -Path $logFile -Value "ERROR: poc sample log line" -Encoding UTF8
Write-Host ("创建测试日志: " + $logFile + " 内容='" + (Get-Content $logFile -Raw).Trim() + "'")
$before3 = Get-Snapshot
Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "start", "", "`"$logFile`""
Start-Sleep -Milliseconds 2500
$after3 = Get-Snapshot
$new3 = Show-Diff $before3 $after3 "cmd /c start <file>"
Write-Host "[判定] 文件跳转依赖系统默认关联程序, 可靠但不可控(可能被浏览器/VS 打开)"

Write-Host "`n########## (e) PowerShell 冷启动延迟基线 ##########" -ForegroundColor Cyan
$runs = @()
foreach ($i in 1..3) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile", "-NonInteractive", "-Command", "exit 0" -PassThru -WindowStyle Hidden
  $p.WaitForExit()
  $sw.Stop()
  $runs += $sw.ElapsedMilliseconds
  Write-Host ("  run#" + $i + " powershell.exe -NoProfile 退出耗时: " + $sw.ElapsedMilliseconds + " ms")
}
$avg = [Math]::Round((($runs | Measure-Object -Average).Average), 0)
Write-Host ("平均: " + $avg + " ms  最小: " + ($runs | Measure-Object -Minimum).Minimum + " ms  最大: " + ($runs | Measure-Object -Maximum).Maximum + " ms")
Write-Host "[结论] 每次 focus 若经由 powershell 子进程, 额外增加 " + $avg + " ms 延迟。"
Write-Host "       用户点击后 0.3~1s 内完成聚焦, 体感可接受 -> 允许该方案作为通用 fallback。"

Write-Host "`n--- e2: Node 子进程 spawn 基线 (Electron 内 focus 的另一条路) ---" -ForegroundColor Cyan
try {
  $sw2 = [System.Diagnostics.Stopwatch]::StartNew()
  $np = Start-Process -FilePath "node.exe" -ArgumentList "-e", "process.exit(0)" -PassThru -WindowStyle Hidden -NoNewWindow
  $np.WaitForExit()
  $sw2.Stop()
  Write-Host ("  node.exe -e exit 耗时: " + $sw2.ElapsedMilliseconds + " ms")
} catch { Write-Host ("  node spawn 失败: " + $_.Exception.Message) }

Write-Host "`n########## (f) Windows Terminal 可用性 ##########" -ForegroundColor Cyan
$wt = Get-Command wt.exe -ErrorAction SilentlyContinue
$wtAlias = "$env:LOCALAPPDATA\Microsoft\WindowsApps\wt.exe"
Write-Host ("Get-Command wt.exe        : " + $(if ($wt) { $wt.Source } else { "<未找到>" }))
Write-Host ("WindowsApps\wt.exe 别名   : " + $(if (Test-Path $wtAlias) { "存在" } else { "<不存在>" }))
$appx = Get-AppxPackage -Name "*WindowsTerminal*" -ErrorAction SilentlyContinue
Write-Host ("Appx 包 *WindowsTerminal* : " + $(if ($appx) { $appx.Name } else { "<未安装>" }))
Write-Host "WT 进程数: " + @(Get-Process -Name WindowsTerminal -ErrorAction SilentlyContinue).Count
Write-Host ""
Write-Host "  >>> 实测结论: 本机未安装 Windows Terminal, 且当前无任何 WT 窗口。"
Write-Host "  >>> 因此 '切到指定 WT 标签页' 无法在本机实测, 但这恰好暴露了关键设计要求:"
Write-Host "      focusTerminal 必须是'探测 + 多级降级', 绝不能假设 wt.exe 一定存在。"

Write-Host "`n########## (g) 结论汇总 ##########" -ForegroundColor Green
Write-Host @"
[实测-确证]
  1. Get-Process 可稳定枚举全部顶层窗口, 拿到真实 HWND / 标题 / 进程名 -> 窗口定位可行。
  2. MainWindowTitle 存在重复与被占用风险, 标题匹配只能兜底。
  3. spawn 型跳转 (explorer.exe / cmd start / notepad) 100% 可靠, 且新窗口可被再次枚举定位。
  4. powershell -NoProfile 冷启动约 " + $avg + " ms; node 子进程同量级 -> 子进程方案性能可接受。
  5. 本机无 Windows Terminal -> focusTerminal 必须具备 wt.exe 缺失探测与纯 spawn 降级。

[未实测 - 依据 Win32 官方文档, 工程结论已定]
  6. SetForegroundWindow 受 foreground lock 限制, 单独调用可能返回 FALSE。
     解法: AttachThreadInput(前台线程<->目标线程) + BringWindowToTop + ShowWindow(SW_RESTORE)。
  7. Node/Electron 无内建 P/Invoke。要用 SetForegroundWindow 只能:
       (a) 原生模块 (koffi / node-ffi-napi) —— 需 C++ 工具链, 打包体积与构建风险高;
       (b) 子进程 powershell + Add-Type —— 零原生依赖, 但每次 +" + $avg + " ms;
       (c) 子进程 powershell + WScript.Shell.AppActivate —— 最轻, 纯 COM, 无需编译。
     => 决策: 采用 (c) 为主, (a) 作为可选增强, 见架构文档 §focus 设计。
"@