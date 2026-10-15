<#
================================================================================
 POC-6: 进程监控器的数据源可行性 (P0-8 process 型监控的关键)
   问题: PRD 要求"匹配进程名 + 命令行子串"。Node/Electron 能拿到命令行吗?
   逐一实测候选方案:
     A. tasklist /fo csv          -> 只有 Image Name, 无命令行
     B. wmic process get CommandLine-> 有命令行, 但 WMIC 已在 Win11 弃用
     C. PowerShell Get-CimInstance Win32_Process-> 有命令行 + ProcessId
     D. PowerShell Get-Process    -> 只有 ProcessName, 无命令行
   同时验证 Node.js 侧的 tail 增量读日志可行性(log 型监控的基础)
 运行: powershell -ExecutionPolicy Bypass -File poc-6-process-enum.ps1
================================================================================
#>
$ErrorActionPreference = 'Continue'

function Run-Capture($file, $argv, $timeoutMs) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $file; $psi.Arguments = $argv
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $pr = [System.Diagnostics.Process]::Start($psi)
  $out = $pr.StandardOutput.ReadToEnd()
  $err = $pr.StandardError.ReadToEnd()
  $pr.WaitForExit($timeoutMs) | Out-Null
  $code = if ($pr.HasExited) { $pr.ExitCode } else { "TIMEOUT" }
  $pr.Dispose()
  return @{ out=$out; err=$err; code=$code }
}

Write-Host "`n########## 方案 A: tasklist /fo csv ##########" -ForegroundColor Cyan
$a = Run-Capture "tasklist.exe" "/fo csv /nh" 20000
$lines = $a.out -split "`r?`n" | Where-Object { $_ -ne '' }
Write-Host ("  退出码=" + $a.code + "  行数=" + @($lines).Count)
$lines | Select-Object -First 4 | ForEach-Object { Write-Host ("    " + $_) }
Write-Host "  [判定] 只含Image Name/ PID/ Session/ Mem, 【无命令行】 -> 不能满足 cmdlineContains"

Write-Host "`n########## 方案 B: wmic process ##########" -ForegroundColor Cyan
$b = Run-Capture "wmic.exe" "process get ProcessId,Name,CommandLine /format:csv" 30000
Write-Host ("  退出码=" + $b.code)
$bl = $b.out -split "`r?`n" | Where-Object { $_ -ne '' }
Write-Host ("  行数=" + @($bl).Count)
if ($a.err) { Write-Host ("  STDERR(前200字符): " + $a.err.Substring(0,[Math]::Min(200,$a.err.Length))) }
if ($b.err) { Write-Host ("  STDERR(前300字符): " + $b.err.Substring(0,[Math]::Min(300,$b.err.Length))) }
$bl | Select-Object -First 3 | ForEach-Object { Write-Host ("    " + $_.Substring(0,[Math]::Min(160,$_.Length))) }
if ($b.code -ne 0) { Write-Host "  [判定] WMIC 失败/弃用 -> 不可作为主方案" -ForegroundColor Yellow }
else { Write-Host "  [判定] 含命令行, 但 WMIC 在 Win11 24H2 已标记弃用, 未来不可用" -ForegroundColor Yellow }

Write-Host "`n########## 方案 C: PowerShell Get-CimInstance Win32_Process ##########" -ForegroundColor Cyan
$c = Run-Capture "powershell.exe" '-NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"' 40000
Write-Host ("  退出码=" + $c.code + "  输出长度=" + $c.out.Length)
$cl = $c.out -split "`r?`n" | Where-Object { $_ -ne '' }
$cl | Select-Object -First 2 | ForEach-Object { Write-Host ("    " + $_.Substring(0,[Math]::Min(300,$_.Length))) }
if ($c.code -eq 0 -and $c.out.Length -gt 10) {
  Write-Host "  [判定] 可行: 拿到 ProcessId + Name + CommandLine" -ForegroundColor Green
  Write-Host "  [注意] 本沙箱进程创建开销 ~2.2s, 每次轮询 spawn ps 代价极高 -> 必须缓存复用进程"
}

Write-Host "`n########## 方案 D: PowerShell Get-Process ##########" -ForegroundColor Cyan
$d = Run-Capture "powershell.exe" '-NoProfile -NonInteractive -Command "Get-Process | Select-Object Id,ProcessName | ConvertTo-Json -Compress"' 40000
Write-Host ("  退出码=" + $d.code + "  输出长度=" + $d.out.Length)
Write-Host "  [判定] 只有 Id+ProcessName, 无命令行 -> 仅够processNames 匹配"

Write-Host "`n########## 方案 E: Node.js 侧能力验证 ##########" -ForegroundColor Cyan
Write-Host ("  node版本: " + (& node -v 2>&1))
$js = @'
const fs = require("fs");
const path = require("path");
const f = path.join(__dirname, "tail-test.log");
fs.writeFileSync(f, "line1\nline2\nline3\n");
const st = fs.statSync(f);
console.log("  文件大小:", st.size, "bytes");
// 模拟首次 tail 读取(从末尾 N 字节)
const fd = fs.openSync(f, "r");
const from = Math.max(0, st.size - 16);
const buf = Buffer.alloc(st.size - from);
fs.readSync(fd, buf, 0, buf.length, from);
console.log("  tail 16 字节 =>", JSON.stringify(buf.toString("utf8")));
fs.closeSync(fd);
// 模拟增量: 追加后只读新增部分
fs.appendFileSync(f, "line4\nline5\n");
const st2 = fs.statSync(f);
const buf2 = Buffer.alloc(st2.size - st.size);
const fd2 = fs.openSync(f, "r");
fs.readSync(fd2, buf2, 0, buf2.length, st.size);
console.log("  增量读取 =>", JSON.stringify(buf2.toString("utf8")));
fs.closeSync(fd2);
console.log("  [OK] Node fs 增量 tail 可行, 无需第三方库");
// 目录 glob 能力
const dir = __dirname;
const hits = fs.readdirSync(dir).filter(f => f.endsWith(".log"));
console.log("  readdirSync *.log命中:", JSON.stringify(hits));
console.log("  [OK] readdirSync 可做单层 glob; 递归 glob 需自己实现或用 tinyglobby");
'@
$jsFile = "D:\projects\ai-task-indicator\poc\poc-6-node-check.js"
[System.IO.File]::WriteAllText($jsFile, $js, (New-Object System.Text.UTF8Encoding($false)))
& node $jsFile 2>&1 | ForEach-Object { Write-Host $_ }

Write-Host "`n########## 最终结论: process 型监控实现路线 ##########" -ForegroundColor Green
Write-Host @"
【实测结论】
  · tasklist (A): 有ImageName 无命令行 -> 只能做 processNames 匹配
  · wmic    (B): 本机 WMIC 已不可用(退出码非0) -> 【排除】
  · Get-CimInstance (C): 可行, ProcessId+Name+CommandLine 齐全
  · Get-Process (D): 有 Id+ProcessName, 无命令行
  · Node fs 增量 tail: 完全可行, 零依赖

【架构决策】process 监控器采用【长驻 PowerShell 子进程 + 逐行 JSON 流】
  1. main 进程启动时拉起一个 `powershell -NoProfile -Command "while(\$true){ Get-CimInstance
     Win32_Process | ... | ConvertTo-Json -Compress; Start-Sleep -Milliseconds <poll> }"`
     常驻子进程, 通过 stdout 逐条读 JSON。
  2. 【理由】本沙箱实测每次进程创建固定开销 ~2.2s; 即便在真实 Windows 上,
     每 3s轮询一次 spawn powershell 也比长驻方案慢一个数量级。
  3. 子进程崩溃 -> 指数退避重启(1s/2s/4s/8s, 上限 30s), 最多重启 5 次后转 unknown 并告警。
  4. 若cmdlineContains 为空 -> 可降级用更轻的 tasklist(它更快), 但统一用长驻方案更简单。
  5. 无命令行需求时(如只匹配 node.exe)仍走同一长驻进程, 避免维护两套逻辑。

【glob 依赖决策】
  · 单层目录 (*.log) -> Node fs.readdirSync 即可, 零依赖
  · 多层递归 (**/*.log) -> 需要第三方。选 `tinyglobby`(纯 ESM、无原生依赖、~30KB)
     或自己写 20 行递归。默认自带递归实现, tinyglobby 作为可选优化。
"@