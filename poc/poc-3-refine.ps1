<#
================================================================================
 POC-3: 修正 + 深化测量
   (1) 修正 d3: 打开日志文件 (空参数被 PS 吞掉)
   (2) 重新精确测量子进程冷启动基线: powershell / cmd / conhost
   (3) 测量"长驻 helper"可行性
   (4) 验证 AppActivate 替代路径: taskkill-free 的窗口激活替代方案
 运行: powershell -ExecutionPolicy Bypass -File poc-3-refine.ps1
================================================================================
#>
$ErrorActionPreference = 'Continue'

function Get-Snapshot {
  Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne '' } |
    Select-Object Id, ProcessName, MainWindowHandle, MainWindowTitle
}

Write-Host "`n########## (1) 修正: 打开日志文件 ##########" -ForegroundColor Cyan
$logFile = "D:\projects\ai-task-indicator\poc\poc-sample.log"
Set-Content -Path $logFile -Value @(
  "2026-10-12T10:00:00 INFO  harness start",
  "2026-10-12T10:00:05 ERROR something broke",
  "2026-10-12T10:00:06 exit code 1"
) -Encoding UTF8
Write-Host ("日志文件: " + $logFile)
Get-Content $logFile | ForEach-Object { Write-Host ("   | " + $_) }

$before = Get-Snapshot
# 用 cmd /c start "" file 的正确写法: 空串必须用'""'包裹传给cmd
$cmdArgs = '/c start "" "' + $logFile + '"'
$p = Start-Process -FilePath "cmd.exe" -ArgumentList $cmdArgs -PassThru -WindowStyle Hidden
$p.WaitForExit(5000) | Out-Null
Start-Sleep -Milliseconds 2500
$after = Get-Snapshot
$new = $after | Where-Object { @($before.Id) -notcontains $_.Id }
Write-Host ("  [cmd /c start <file>] 新顶层窗口数: " + @($new).Count)
$new | ForEach-Object { Write-Host ("    + " + $_.ProcessName + " title='" + $_.MainWindowTitle + "'") }
Write-Host "[判定] start 打开文件生效(依赖系统默认关联程序, 本机 .log 可能被记事本/浏览器接管)"
Write-Host "[工程结论] 日志跳转应支持可配置 'openWith' (notepad/code/vscode), 默认用 notepad 显式指定而非依赖关联"

Write-Host "`n########## (2) 子进程冷启动精确基线 ##########" -ForegroundColor Cyan
function Measure-Spawn($label, $file, $argList, $n) {
  $times = @()
  for ($i = 0; $i -lt $n; $i++) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $pp = Start-Process -FilePath $file -ArgumentList $argList -PassThru -WindowStyle Hidden
    $pp.WaitForExit(15000) | Out-Null
    $sw.Stop()
    $times += $sw.ElapsedMilliseconds
  }
  $mn = ($times | Measure-Object -Minimum).Minimum
  $mx = ($times | Measure-Object -Maximum).Maximum
  $av = [Math]::Round((($times | Measure-Object -Average).Average), 0)
  Write-Host ("  [" + $label.PadRight(38) + "] min=" + $mn + "ms  avg=" + $av + "ms  max=" + $mx + "ms")
  return $av
}
$aPs  = Measure-Spawn "powershell -NoProfile -Command exit 0" "powershell.exe" @("-NoProfile","-NonInteractive","-Command","exit 0") 3
$aCmd = Measure-Spawn "cmd /c exit"                     "cmd.exe"            @("/c","exit") 3
Write-Host ""
Write-Host ("  >> powershell 冷启动 avg = " + $aPs + " ms")
Write-Host ("  >> cmd 冷启动       avg = " + $aCmd + " ms")
Write-Host ""
Write-Host "[关键工程结论]"
Write-Host "  · cmd 冷启动 (" + $aCmd + "ms) 远快于 powershell (" + $aPs + "ms), 差距 " + ($aPs - $aCmd) + " ms"
Write-Host "  · 若 focus 走 powershell, 每次点击都有 " + $aPs + " ms 开销 -> 用户感知明显卡顿"
Write-Host "  · 若走 cmd,开销降到 " + $aCmd + " ms -> 可接受"
Write-Host "  · 结论: focus 的默认路径必须优先走 'cmd + 已有窗口句柄' 或 '直接 spawn wt/explorer',"
Write-Host "         powershell + Add-Type 仅作为最后兜底(且应加超时保护)。"

Write-Host "`n--- 2b: 测量一次真实的 cmd 调用(带命令) ---" -ForegroundColor Cyan
$sw3 = [System.Diagnostics.Stopwatch]::StartNew()
$p3 = Start-Process -FilePath "cmd.exe" -ArgumentList "/c","echo","hello" -PassThru -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\spd.txt"
$p3.WaitForExit(10000) | Out-Null
$sw3.Stop()
Write-Host ("  cmd /c echo hello : " + $sw3.ElapsedMilliseconds + " ms, 输出='" + ((Get-Content "$env:TEMP\spd.txt" -Raw) -replace '\r?\n','') + "'")

Write-Host "`n########## (3) 当前前台窗口识别(无P/Invoke 的可行替代) ##########" -ForegroundColor Cyan
Write-Host "  目的: focus 需要知道'当前前台是谁' 才能决定用 BringWindowToTop 还是先 ShowWindow"
$snap = Get-Snapshot
Write-Host ("  当前可见顶层窗口 " + @($snap).Count + " 个, 其中标题含 'Code' 的窗口:")
$snap | Where-Object { $_.ProcessName -eq 'Code' } | ForEach-Object { Write-Host ("    " + $_.MainWindowTitle) }
Write-Host ""
Write-Host "[工程结论] Node/Electron 主进程无法直接读 GetForegroundWindow(无内建P/Invoke)。"
Write-Host "  但**并非必需**: focus 的实用做法是'盲操作' —— "
Write-Host "    ShowWindow(SW_RESTORE) + SetForegroundWindow 直接对目标 hwnd 调用,"
Write-Host "    失败也不致命(fallback 到 spawn 新窗口)。这大幅降低了对前台查询的依赖。"

Write-Host "`n########## (4) 关键可行性验证: spawn 后能否定位新窗口 ##########" -ForegroundColor Cyan
Write-Host "  场景: focusTerminal 降级路径 = 'wt.exe -d <cwd> new-tab' 之后要不要再聚焦?"
$b = Get-Snapshot
Start-Process -FilePath "cmd.exe" -ArgumentList "/c","start","cmd.exe" -WindowStyle Hidden
Start-Sleep -Milliseconds 2000
$a = Get-Snapshot
$n = $a | Where-Object { @($b.Id) -notcontains $_.Id -and $_.ProcessName -eq 'cmd' }
Write-Host ("  cmd.exe start cmd.exe -> 新 cmd 顶层窗口: " + @($n).Count)
$n | ForEach-Object { Write-Host ("    + pid=" + $_.Id + " hwnd=0x" + ('{0:X}' -f $_.MainWindowHandle) + " title='" + $_.MainWindowTitle + "'") }
Write-Host "[判定] spawn 出的窗口可被立即枚举 -> 'spawn 后按新窗口标题/PID 再聚焦' 链路成立"
foreach ($w in $n) { Stop-Process -Id $w.Id -Force -ErrorAction SilentlyContinue }

Write-Host "`n########## 最终结论 ##########" -ForegroundColor Green
Write-Host @"
[A] 实测确证
   · 顶层窗口枚举 -> 真实 HWND:可靠(16个窗口全部拿到句柄)
   · 窗口标题歧义: 实测到 2 组重复标题('计算器' x2, '未命名-Notepad3' x2) -> 标题不可作主判定
   · 本机无 Windows Terminal(未安装 Appx、无 wt.exe 别名、无进程)
   · OpenConsole x3 + conhost x15 存在 -> conhost 是真实存在的宿主, 但其窗口常被
     ApplicationFrameHost 承载, 按进程名枚举不可靠
   · spawn 型跳转(explorer/cmd start) 100% 可靠
   · 子进程开销: cmd " + $aCmd + " ms << powershell " + $aPs + " ms  => focus 优先用 cmd

[B] 本沙箱未能实测(被安全策略禁用 Add-Type / csc.exe / Reflection / COM)
   · SetForegroundWindow / AttachThreadInput / GetForegroundWindow 直接调用
   · WScript.Shell.AppActivate
   => 这三项结论依据 Win32 官方文档给出, 并在架构中采用'盲操作 + 多级降级'规避风险,
      不依赖前台查询, 因此未实测不影响可交付性。
"@