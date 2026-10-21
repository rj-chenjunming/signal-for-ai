export const NATIVE_WINDOW_APPS = {
  dsh: { label: 'dsh', processName: 'DeepSeek Harness', executableName: 'DeepSeek Harness.exe', marker: 'LAMPDSHREVEAL ok=True' },
  workbuddy: { label: 'WorkBuddy', processName: 'WorkBuddy', executableName: 'WorkBuddy.exe', marker: 'LAMPWORKBUDDYREVEAL ok=True' },
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
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class LampNativeOwner { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }'
[uint32]$ownerPid = 0
$nativeHandle = [IntPtr]${hwnd}
[void][LampNativeOwner]::GetWindowThreadProcessId($nativeHandle, [ref]$ownerPid)
if ($ownerPid -ne ${pid}) { throw '${profile.label} window owner changed' }
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
  # SPEC-022：前台确认并入本脚本，成功 marker 只在真实前台时输出。
  # 轮询最多约 1s，避免 handoff 后前台切换尚未完成就误判失败。
  $foreground = $false
  for ($i = 0; $i -lt 20; $i++) {
    if ([LampNativeOwner]::GetForegroundWindow() -eq $nativeHandle) { $foreground = $true; break }
    Start-Sleep -Milliseconds 50
  }
  if (!$foreground) { throw '${profile.label} foreground not confirmed' }
  Write-Output '${profile.marker}'
} finally {
  $relay.Dispose()
}
`.trim();
}
