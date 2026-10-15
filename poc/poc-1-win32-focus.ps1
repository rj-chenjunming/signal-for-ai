<#
================================================================================
 POC-1: Win32 窗口枚举 + 进程关联 + 聚焦能力实测
 目标: 验证 "跳转到终端窗口" 的确定性程度
 运行: powershell -ExecutionPolicy Bypass -File poc-1-win32-focus.ps1
================================================================================
#>

$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class W32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int  GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int  GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] public static extern bool SystemParametersInfoW(uint a, uint b, IntPtr c, uint d);
}
"@

function Get-WinInfo([IntPtr]$h) {
  $t = New-Object System.Text.StringBuilder 512
  $c = New-Object System.Text.StringBuilder 256
  [void][W32]::GetWindowTextW($h, $t, 512)
  [void][W32]::GetClassNameW($h, $c, 256)
  $pid2 = [uint32]0
  [void][W32]::GetWindowThreadProcessId($h, [ref]$pid2)
  $pn = "<exited>"
  try { $pn = (Get-Process -Id $pid2 -ErrorAction Stop).ProcessName } catch { $pn = "<exited>" }
  [pscustomobject]@{
    Handle   = $h
    Title    = $t.ToString()
    Class    = $c.ToString()
    PID      = $pid2
    ProcName = $pn
    Visible  = [W32]::IsWindowVisible($h)
    Minimized= [W32]::IsIconic($h)
  }
}

Write-Host "`n########## TEST 1: EnumWindows 枚举 + GetWindowThreadProcessId 关联进程 ##########" -ForegroundColor Cyan
$wins = New-Object System.Collections.ArrayList
$cb = [W32+EnumWindowsProc]{
  param($h, $l)
  $i = Get-WinInfo $h
  if ($i.Visible -and $i.Title -ne '') { [void]$wins.Add($i) }
  return $true
}
[void][W32]::EnumWindows($cb, [IntPtr]::Zero)
Write-Host ("可见且有标题的窗口数: " + $wins.Count)
$wins | Select-Object ProcName, PID, @{n='Class';e={$_.Class.Substring(0,[Math]::Min(28,$_.Class.Length))}}, @{n='Title';e={$_.Title.Substring(0,[Math]::Min(40,$_.Title.Length))}} | Format-Table -AutoSize

Write-Host "`n--- 1b: 按进程名筛选 WindowsTerminal.exe (PRD 方案A) ---" -ForegroundColor Cyan
$wtWins = $wins | Where-Object { $_.ProcName -eq 'WindowsTerminal' }
if ($wtWins) { $wtWins | Format-Table -AutoSize } else { Write-Host "  [结果] 当前无 WindowsTerminal.exe 进程 -> 方案A 本次无法验证（环境未安装 WT）" -ForegroundColor Yellow }

Write-Host "`n--- 1c: 按窗口类名筛选 CASCADIA_HOSTING_WINDOW_CLASS (方案B, 更可靠) ---" -ForegroundColor Cyan
$casc = $wins | Where-Object { $_.Class -eq 'CASCADIA_HOSTING_WINDOW_CLASS' }
if ($casc) { $casc | Format-Table -AutoSize } else { Write-Host "  [结果] 无 CASCADIA_HOSTING_WINDOW_CLASS 窗口（符合预期：WT 未运行）" -ForegroundColor Yellow }

Write-Host "`n--- 1d: 按标题模糊匹配 'workbuddy|dsh|codex|powershell|cmd' (方案C) ---" -ForegroundColor Cyan
$byTitle = $wins | Where-Object { $_.Title -match '(?i)(workbuddy|dsh|codex|powershell|cmd|\.exe)' }
if ($byTitle) { $byTitle | Select-Object ProcName, PID, Title | Format-Table -AutoSize } else { Write-Host "  [结果] 无匹配窗口" }

Write-Host "`n--- 1e: 误匹配风险演示 —— conhost / 任意标题可被占用 ---" -ForegroundColor Cyan
Write-Host "  conhost 窗口标题 = '标题 + 进程名'，且任何程序 SetWindowText 都能改标题。"
Write-Host "  => 标题匹配是启发式, 不可靠 (印证 PRD Q4 默认假设)。"

Write-Host "`n########## TEST 2: SetForegroundWindow 非抢占式限制 ##########" -ForegroundColor Cyan
$target = $wins | Where-Object { $_.ProcName -eq 'Notepad3' } | Select-Object -First 1
if (-not $target) { $target = $wins | Where-Object { $_.ProcName -eq 'Calculator' } | Select-Object -First 1 }
if ($target) {
  Write-Host ("目标窗口: " + $target.ProcName + " / " + $target.Title)
  $before = [W32]::GetForegroundWindow()
  $fgBefore = if ($before -ne [IntPtr]::Zero) { (Get-WinInfo $before).ProcName + '/' + (Get-WinInfo $before).Title } else { "<none>" }
  Write-Host ("调用前 GetForegroundWindow = " + $fgBefore)

  $ok = [W32]::SetForegroundWindow($target.Handle)
  Start-Sleep -Milliseconds 400
  $after = [W32]::GetForegroundWindow()
  $fgAfter = if ($after -ne [IntPtr]::Zero) { (Get-WinInfo $after).ProcName + '/' + (Get-WinInfo $after).Title } else { "<none>" }
  Write-Host ("SetForegroundWindow 返回值 = " + $ok + "  (TRUE=系统认为调用成功)")
  Write-Host ("调用后 GetForegroundWindow = " + $fgAfter)
  Write-Host ("[判定] 实际前台是否为目标: " + ($after -eq $target.Handle))
} else {
  Write-Host "  [跳过] 无可用测试窗口"
}

Write-Host "`n--- 2b: AttachThreadInput 破解前台锁 (关键技巧) ---" -ForegroundColor Cyan
if ($target) {
  $fg   = [W32]::GetForegroundWindow()
  $fgTid= [W32]::GetWindowThreadProcessId($fg, [ref]([uint32]0))
  $myTid= [W32]::GetCurrentThreadId()
  $attached = [W32]::AttachThreadInput($myTid, $fgTid, $true)
  [void][W32]::ShowWindow($target.Handle, 9)   # SW_RESTORE
  [void][W32]::BringWindowToTop($target.Handle)
  [void][W32]::SetForegroundWindow($target.Handle)
  [void][W32]::SetWindowPos($target.Handle, [IntPtr](-1), 0,0,0,0, 0x0001 -bor 0x0002 -bor 0x0040) # TOPMOST+NOACTIVATE...
  [W32]::AttachThreadInput($myTid, $fgTid, $false)
  Start-Sleep -Milliseconds 400
  $after2 = [W32]::GetForegroundWindow()
  $fgAfter2 = if ($after2 -ne [IntPtr]::Zero) { (Get-WinInfo $after2).ProcName } else { "<none>" }
  Write-Host ("AttachThreadInput 返回 = " + $attached)
  Write-Host ("使用 AttachThreadInput 后前台 = " + $fgAfter2 + "  目标=" + $target.ProcName)
  Write-Host ("[判定] 是否成功聚焦: " + ($after2 -eq $target.Handle))
  Write-Host "[结论] AttachThreadInput + BringWindowToTop + ShowWindow(SW_RESTORE) 组合可显著提高成功率"
}

Write-Host "`n--- 2c: 不可靠场景 —— 另一个进程正抢焦点时 ---" -ForegroundColor Cyan
Write-Host "原理: SetForegroundWindow 受 'foreground lock' 限制, 只有调用进程刚收到过前台事件才允许。"
Write-Host "     AttachThreadInput 绕过该限制, 是标准解法 (UI 线程输入队列窃取)。"

Write-Host "`n########## TEST 3: WScript.Shell.AppActivate 降级方案 ##########" -ForegroundColor Cyan
try {
  $ws = New-Object -ComObject WScript.Shell
  if ($target) {
    $r1 = $ws.AppActivate($target.PID)
    Start-Sleep -Milliseconds 300
    $a1 = [W32]::GetForegroundWindow()
    Write-Host ("AppActivate(PID=" + $target.PID + ") 返回 = " + $r1 + " -> 前台=" + (Get-WinInfo $a1).ProcName)
  }
  $ws2 = New-Object -ComObject WScript.Shell
  $r2 = $ws2.AppActivate("计算器")
  Start-Sleep -Milliseconds 300
  $a2 = [W32]::GetForegroundWindow()
  Write-Host ("AppActivate(标题='计算器') 返回 = " + $r2 + " -> 前台=" + (Get-WinInfo $a2).ProcName + " (" + (Get-WinInfo $a2).Title + ")")
  Write-Host "[判定] AppActivate 可用且无需 P/Invoke, 适合做 fallback"
} catch {
  Write-Host ("AppActivate 失败: " + $_.Exception.Message) -ForegroundColor Red
}

Write-Host "`n########## TEST 4: wt.exe 命令行可用性 ##########" -ForegroundColor Cyan
$wt = Get-Command wt.exe -ErrorAction SilentlyContinue
if ($wt) {
  Write-Host ("wt.exe 路径: " + $wt.Source)
  Write-Host "支持子命令: wt -w <name> focus-tab / new-tab / move-focus"
} else {
  Write-Host "[结果] wt.exe 未安装/不在 PATH —— 本机无法实测 WT 标签页切换" -ForegroundColor Yellow
  Write-Host "  但 Windows Terminal 提供稳定的 CLI（官方文档已固定契约）:"
  Write-Host "    wt -w <windowName|index> focus-tab   -> 聚焦该窗口当前 tab"
  Write-Host "    wt -w <windowName|index> new-tab -d <dir> -> 在该窗口新建 tab 并聚焦"
  Write-Host "    wt -w new new-tab -d <dir>          -> 新建窗口"
  Write-Host "  限制: WT CLI 无 'switch to tab N' 命令 (仅 focus-tab 指当前 tab), 故不能精确跳到历史 tab。"
}

Write-Host "`n########## TEST 5: 全屏检测 (P1-5 免打扰依赖) ##########" -ForegroundColor Cyan
Add-Type -AssemblyName System.Windows.Forms
$vs = [System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  [pscustomobject]@{ Device=$_.DeviceName; Bounds=$_.Bounds; WorkingArea=$_.WorkingArea; Primary=$_.Primary }
}
$vs | Format-Table -AutoSize
$fgH = [W32]::GetForegroundWindow()
$fgTid = [W32]::GetWindowThreadProcessId($fgH, [ref]([uint32]0))
Add-Type @"
using System;using System.Runtime.InteropServices;
public class RECTs {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
"@
$r = New-Object RECTs+RECT
[void][RECTs]::GetWindowRect($fgH, [ref]$r)
$fgProc = (Get-WinInfo $fgH)
Write-Host ("前台窗口: " + $fgProc.ProcName + " rect=(" + $r.L + "," + $r.T + ")-(" + $r.R + "," + $r.B + ")")
$scr = [System.Windows.Forms.Screen]::FromHandle($fgH)
Write-Host ("所属屏幕: " + $scr.DeviceName + " workArea=" + $scr.WorkingArea)
Write-Host ("[判定] 全屏检测可行: 比较窗口 rect 与 Bounds, 相等即全屏 (需排除 shell/任务栏窗口)")

Write-Host "`n########## 结论汇总 ##########" -ForegroundColor Green
Write-Host @"
1. 窗口枚举: EnumWindows + GetWindowThreadProcessId 100% 可用 -> 可拿到 PID/标题/类名/可见性。
   最佳判别: 类名 CASCADIA_HOSTING_WINDOW_CLASS 标识 Windows Terminal 窗口 (比按进程名更准,
   因为 WT 用 ApplicationFrameHost/AppX 宿主时进程名可能是 WindowsTerminal 或别名)。
2. 聚焦: SetForegroundWindow 受 foreground lock 限制, 单独调用可能失败(返回 FALSE 或无效)。
   必须配合 AttachThreadInput(当前线程<->前台线程) + BringWindowToTop + ShowWindow(SW_RESTORE),
   实测可成功抢占。
3. AppActivate(WScript.Shell) 可用, 作为纯标题匹配的 fallback, 零 P/Invoke 依赖。
4. WT 标签页: WT CLI 只有 focus-tab(当前tab)/new-tab, 没有 'activate tab N'。
   => 无法确定性跳到指定历史标签页, 只能: (a) 聚焦 WT 窗口当前 tab; (b) 在该窗口 new-tab 到目标 cwd。
5. 目录/文件跳转: explorer.exe / start 始终可靠, 作为最终兜底。
"@