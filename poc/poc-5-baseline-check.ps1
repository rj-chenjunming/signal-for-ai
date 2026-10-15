<#
================================================================================
 POC-5: 校验 spawn 测量基线 —— 判断 ~2.3s 是真实开销还是沙箱开销
   对比: 极轻量 exe (cmd /c ver) vs 稍重 (powershell)
   若两者都>=2s, 说明存在固定创建开销(沙箱/杀软), 绝对值不可用于生产决策,
   只有相对值(powershell 比 cmd 慢多少)有效。
 运行: powershell -ExecutionPolicy Bypass -File poc-5-baseline-check.ps1
================================================================================
#>
$ErrorActionPreference = 'Continue'

function T($label, $file, $argv, $n) {
  $times = @()
  for ($i = 0; $i -lt $n; $i++) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $file; $psi.Arguments = $argv
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $pr = [System.Diagnostics.Process]::Start($psi)
    $null = $pr.StandardOutput.ReadToEnd()
    $pr.WaitForExit(20000) | Out-Null
    $sw.Stop(); $times += $sw.ElapsedMilliseconds
    if ($pr) { $pr.Dispose() }
  }
  $av = [Math]::Round((($times | Measure-Object -Average).Average),0)
  $mn = ($times | Measure-Object -Minimum).Minimum
  Write-Host ("  [" + $label.PadRight(30) + "] min=" + $mn + " avg=" + $av + " ms")
  return @{ label=$label; avg=$av; min=$mn }
}

Write-Host "`n########## 基线校验: 极轻 exe vs 重量 exe ##########" -ForegroundColor Cyan
$a = T "cmd /c ver (最轻)"          "cmd.exe"        "/c ver" 5
$b = T "cmd /c exit"                "cmd.exe"        "/c exit" 5
$c = T "powershell -NoProfile ver"  "powershell.exe" "-NoProfile -NonInteractive -Command exit" 4
$d = T "hostname"                   "hostname.exe"   "" 3

Write-Host ""
Write-Host "  ============================ 分析 ============================"
Write-Host ("  极轻量 hostname.exe   : " + $d.avg + " ms  <- 进程创建固定开销基线")
Write-Host ("  cmd /c ver            : " + $a.avg + " ms")
Write-Host ("  cmd /c exit           : " + $b.avg + " ms")
Write-Host ("  powershell -NoProfile : " + $c.avg + " ms")
Write-Host ""
Write-Host ("  固定开销(以 hostname 计): " + $d.avg + " ms")
Write-Host ("  cmd 净开销          : " + ($b.avg - $d.avg) + " ms")
Write-Host ("  powershell 净开销    : " + ($c.avg - $d.avg) + " ms")
Write-Host ("  powershell 相对 cmd  : +" + ($c.avg - $b.avg) + " ms")
Write-Host ""
if ($d.avg -gt 1000) {
  Write-Host "  >>> 判定: 存在 >1s 的进程创建固定开销 (沙箱/杀软/容器拦截)。" -ForegroundColor Yellow
  Write-Host "  >>> 因此 POC-2/3/4 中的绝对值(2.3~4.7s) 不可用于生产延迟预算。" -ForegroundColor Yellow
  Write-Host "  >>> 只有【相对差值】有效: powershell 比 cmd 慢约 $(($c.avg - $b.avg)) ms。" -ForegroundColor Yellow
  Write-Host "  >>> 真实 Windows 10/11 桌面参考值: cmd ≈ 20~60ms, powershell -NoProfile ≈ 250~600ms。" -ForegroundColor Yellow
} else {
  Write-Host "  >>> 判定: 无异常固定开销, 绝对值可用。" -ForegroundColor Green
}
Write-Host ""
Write-Host "  >>> 对架构的最终影响(与绝对值无关, 结论不变):" -ForegroundColor Green
Write-Host "      1. 优先直接 spawn 目标程序 (wt/explorer/notepad), 不经中间层"
Write-Host "      2. powershell 只作为聚焦已有窗口的最后手段, 且异步不阻塞 UI"
Write-Host "      3. wt.exe 存在性必须启动时探测一次并缓存 (不能每次点击都 where)"
Write-Host "      4. 所有 spawn 设超时, 失败逐级降级, 绝不抛到UI"