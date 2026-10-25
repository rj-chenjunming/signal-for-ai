export const NATIVE_WINDOW_APPS = {
  dsh: { label: 'dsh', processName: 'DeepSeek Harness', executableName: 'DeepSeek Harness.exe', marker: 'LAMPDSHREVEAL ok=True' },
  workbuddy: { label: 'WorkBuddy', processName: 'WorkBuddy', executableName: 'WorkBuddy.exe', marker: 'LAMPWORKBUDDYREVEAL ok=True' },
  // SPEC-042：ZCode 桌面端（Electron）。app.asar 已验证 requestSingleInstanceLock，
  // 与 dsh 同走"重新拉起 exe → second-instance 原生恢复"，绝不做 SW_MINIMIZE 往返。
  zcode: { label: 'ZCode', processName: 'ZCode', executableName: 'ZCode.exe', marker: 'LAMPZCODEREVEAL ok=True' },
} as const;
export type NativeWindowApp = keyof typeof NATIVE_WINDOW_APPS;

/** Only these known installed applications may receive an argument-free single-instance handoff. */
export function buildNativeWindowRevealScript(pid: number, hwnd: number, app: NativeWindowApp): string {
  if (!Object.hasOwn(NATIVE_WINDOW_APPS, app)) throw new Error('Unsupported native window application');
  const profile = NATIVE_WINDOW_APPS[app];
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(hwnd) || hwnd <= 0) {
    throw new Error(`Invalid ${profile.label} window identity`);
  }
  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class LampNativeOwner { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach); [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId(); }'
[uint32]$ownerPid = 0
$nativeHandle = [IntPtr]${hwnd}
[void][LampNativeOwner]::GetWindowThreadProcessId($nativeHandle, [ref]$ownerPid)
if ($ownerPid -ne ${pid}) { throw '${profile.label} window owner changed' }
function Set-LampForeground($h) {
  [void][LampNativeOwner]::BringWindowToTop($h)
  [void][LampNativeOwner]::SetForegroundWindow($h)
  if ([LampNativeOwner]::GetForegroundWindow() -ne $h) {
    [uint32]$fgPid = 0
    [uint32]$fgThread = [LampNativeOwner]::GetWindowThreadProcessId([LampNativeOwner]::GetForegroundWindow(), [ref]$fgPid)
    [uint32]$me = [LampNativeOwner]::GetCurrentThreadId()
    [void][LampNativeOwner]::AttachThreadInput($fgThread, $me, $true)
    [void][LampNativeOwner]::SetForegroundWindow($h)
    [void][LampNativeOwner]::AttachThreadInput($fgThread, $me, $false)
  }
}
$targetProcess = Get-Process -Id ${pid} -ErrorAction Stop
if ($targetProcess.ProcessName -ine '${profile.processName}' -or $targetProcess.HasExited) { throw '${profile.label} owner is unavailable' }
$executable = $targetProcess.Path
if ([string]::IsNullOrWhiteSpace($executable) -or ![IO.Path]::IsPathRooted($executable) -or [IO.Path]::GetFileName($executable) -ine '${profile.executableName}' -or ![IO.File]::Exists($executable)) { throw '${profile.label} executable is unavailable' }
$relay = Start-Process -FilePath $executable -WorkingDirectory ([IO.Path]::GetDirectoryName($executable)) -WindowStyle Hidden -PassThru
try {
  if (!$relay.WaitForExit(3000)) { throw '${profile.label} single-instance handoff timed out' }
  if ($relay.ExitCode -ne 0) { throw '${profile.label} single-instance handoff failed' }
  if ([LampNativeOwner]::IsIconic($nativeHandle)) {
    [void][LampNativeOwner]::ShowWindow($nativeHandle, 9)
    Start-Sleep -Milliseconds 120
  }
  # SPEC-023：不做最小化复位；可见但未聚焦时用温和的前台补齐。
  # SPEC-022：前台确认并入本脚本，成功 marker 只在真实前台时输出。
  # 轮询最多约 2.5s：handoff 与前台切换可能异步完成，单次 SetForegroundWindow
  # 失败时重试（含 AttachThreadInput），但不做任何 minimize/restore 往返。
  $foreground = $false
  for ($i = 0; $i -lt 25; $i++) {
    if ([LampNativeOwner]::GetForegroundWindow() -eq $nativeHandle) { $foreground = $true; break }
    Set-LampForeground $nativeHandle
    Start-Sleep -Milliseconds 100
  }
  if (!$foreground) { throw '${profile.label} foreground not confirmed' }
  Write-Output '${profile.marker}'
} finally {
  $relay.Dispose()
}
`.trim();
}
