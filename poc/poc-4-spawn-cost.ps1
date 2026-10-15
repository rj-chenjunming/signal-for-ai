<#
================================================================================
 POC-4: 精确测量 spawn 开销 (排除 Start-Process 的 PowerShell 自身开销)
   -> 直接用 System.Diagnostics.Process, 走 CreateProcess 真实路径
   -> 这个数字直接决定 focusTerminal 的实现选型
 运行: powershell -ExecutionPolicy Bypass -File poc-4-spawn-cost.ps1
================================================================================
#>
$ErrorActionPreference = 'Continue'

function Measure-Real($label, $file, $argv, $n) {
  $times = @()
  for ($i = 0; $i -lt $n; $i++) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $file
    $psi.Arguments = $argv
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $pr = [System.Diagnostics.Process]::Start($psi)
    $out = $pr.StandardOutput.ReadToEnd()
    $pr.WaitForExit(15000) | Out-Null
    $sw.Stop()
    $times += $sw.ElapsedMilliseconds
    if ($pr) { $pr.Dispose() }
  }
  $mn = ($times | Measure-Object -Minimum).Minimum
  $mx = ($times | Measure-Object -Maximum).Maximum
  $av = [Math]::Round((($times | Measure-Object -Average).Average), 0)
  Write-Host ("  [" + $label.PadRight(34) + "] min=" + $mn + "  avg=" + $av + "  max=" + $mx + "  ms   (n=" + $n + ")")
  return $av
}

Write-Host "`n########## 真实 spawn 开销 (System.Diagnostics.Process) ##########" -ForegroundColor Cyan
$e1 = Measure-Real "cmd /c exit 0"                  "cmd.exe"           "/c exit 0" 5
$e2 = Measure-Real "cmd /c echo hello"              "cmd.exe"           "/c echo hello" 5
$e3 = Measure-Real "powershell -NoProfile exit 0"   "powershell.exe"    "-NoProfile -NonInteractive -Command exit 0" 3
$e4 = Measure-Real "powershell -NoProfile echo"     "powershell.exe"    "-NoProfile -NonInteractive -Command echo hi" 3
$e5 = Measure-Real "where.exe (PATH 查找)"          "where.exe"         "wt.exe" 3

Write-Host ""
Write-Host ("  >> cmd /c exit          : " + $e1 + " ms")
Write-Host ("  >> cmd /c echo hello    : " + $e2 + " ms")
Write-Host ("  >> powershell exit 0    : " + $e3 + " ms")
Write-Host ("  >> powershell echo      : " + $e4 + " ms")
Write-Host ("  >> where.exe PATH 查找  : " + $e5 + " ms")

Write-Host "`n########## 结论: focusTerminal 选型 ##########" -ForegroundColor Green
Write-Host @"
实测数据(3次以上取平均, System.Diagnostics.Process 直连 CreateProcess):
  · cmd.exe               ≈ $e1 ms
  · powershell.exe        ≈ $e3 ms   (比 cmd 慢约 $($e3 - $e1) ms,主要在 CLR 启动)
  · PATH 查找(wher.exe)   ≈ $e5 ms

决策:
  1) 【首选】wt.exe / explorer.exe / notepad.exe 直接 spawn —— 全部走 cmd 级开销(≈ $e1 ms),
     用户点击后几乎瞬时响应。降级链的第一级不该是 powershell。
  2) 【次选】powershell + WScript.Shell.AppActivate —— 约 $e3 ms,用于聚焦已有窗口。
     3 秒内可感知但不阻塞 UI(focus 是异步 fire-and-forget),可接受。
  3) 【兜底】若wt.exe 不存在(本机实测就是这种情况),直接降级到 explorer.exe / notepad.exe,
     不要浪费 3 秒去尝试 powershell 聚焦一个不存在的窗口。
  4) 全链路必须设 5s 超时,超时只记日志不抛错(PRD P0-7 非法项不崩溃)。
"@

Write-Host "`n########## 附: 一次性探测 wt.exe 是否存在(应缓存结果) ##########" -ForegroundColor Cyan
Write-Host @"
实现: 在 main 进程启动时做一次 where.exe wt.exe 探测(≈ $e5 ms),结果缓存到内存。
      focusTerminal 每次调用直接读缓存,不再重复探测 -> 避免每次点击多付 $e5 ms。
      用户安装/卸载 WT 后可托盘菜单「重新探测终端」手动刷新缓存。
"@