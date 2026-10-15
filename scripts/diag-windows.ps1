# Enumerate all visible top-level windows with their owning process name.
# ASCII-only (powershell.exe reads .ps1 as ANSI and mangles non-ASCII).

Add-Type -ErrorAction SilentlyContinue -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class WinList {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLengthW(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

  public static List<string[]> All() {
    var res = new List<string[]>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      int n = GetWindowTextLengthW(h);
      if (n <= 0) return true;
      var sb = new StringBuilder(n + 2);
      GetWindowTextW(h, sb, n + 2);
      var cls = new StringBuilder(256);
      GetClassNameW(h, cls, 256);
      uint pid; GetWindowThreadProcessId(h, out pid);
      res.Add(new string[] { pid.ToString(), cls.ToString(), sb.ToString(), h.ToString() });
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
'@

$fg = [WinList]::GetForegroundWindow().ToString()
Write-Host "foreground hwnd = $fg"
Write-Host ""
Write-Host ("{0,-7} {1,-24} {2}" -f 'PID', 'CLASS', 'TITLE')
Write-Host ("-" * 100)
foreach ($row in [WinList]::All()) {
  $procName = ''
  try { $procName = (Get-Process -Id ([int]$row[0]) -ErrorAction Stop).ProcessName } catch { $procName = '?' }
  Write-Host ("{0,-7} {1,-24} {2}" -f $row[0], $row[1], $row[2])
  Write-Host ("        proc = {0}{1}" -f $procName, $(if ($row[3] -eq $fg) { '   <== FOREGROUND' } else { '' }))
}
