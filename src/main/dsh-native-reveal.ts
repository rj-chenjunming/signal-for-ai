/** Ask the already-running dsh owner to restore/show its own BrowserWindow. */
export function buildDshNativeRevealScript(pid: number, hwnd: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(hwnd) || hwnd <= 0) {
    throw new Error('Invalid dsh window identity');
  }
  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class LampDshOwner { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); }'
[uint32]$ownerPid = 0
[void][LampDshOwner]::GetWindowThreadProcessId([IntPtr]${hwnd}, [ref]$ownerPid)
if ($ownerPid -ne ${pid}) { throw 'dsh window owner changed' }
$targetProcess = Get-Process -Id ${pid} -ErrorAction Stop
if ($targetProcess.ProcessName -ine 'DeepSeek Harness' -or $targetProcess.HasExited) { throw 'dsh owner is unavailable' }
$executable = $targetProcess.Path
if ([string]::IsNullOrWhiteSpace($executable) -or ![IO.Path]::IsPathRooted($executable) -or [IO.Path]::GetFileName($executable) -ine 'DeepSeek Harness.exe' -or ![IO.File]::Exists($executable)) { throw 'dsh executable is unavailable' }
$relay = Start-Process -FilePath $executable -WorkingDirectory ([IO.Path]::GetDirectoryName($executable)) -WindowStyle Hidden -PassThru
try {
  if (!$relay.WaitForExit(3000)) { throw 'dsh single-instance handoff timed out' }
  if ($relay.ExitCode -ne 0) { throw 'dsh single-instance handoff failed' }
  Write-Output 'LAMPDSHREVEAL ok=True'
} finally {
  $relay.Dispose()
}
`.trim();
}
