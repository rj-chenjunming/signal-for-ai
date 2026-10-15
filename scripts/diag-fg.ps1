# Switch focus to a NON-target window first, then let the caller click,
# then report the foreground. This proves the click can actually STEAL focus
# (not merely keep the window that was already in front).
# ASCII-only (powershell.exe reads .ps1 as ANSI).

param(
  [string]$StealTo = '',   # substring of the window title to bring to front first
  [switch]$CheckOnly       # only report the current foreground
)

Add-Type -ErrorAction SilentlyContinue -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class Ws {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLengthW(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

  public static string Title(IntPtr h) {
    int n = GetWindowTextLengthW(h); if (n <= 0) return "";
    var sb = new StringBuilder(n + 2); GetWindowTextW(h, sb, n + 2); return sb.ToString();
  }
  public static IntPtr Find(string part) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      string t = Title(h);
      if (t.Length > 0 && t.IndexOf(part, StringComparison.OrdinalIgnoreCase) >= 0) {
        found = h; return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static void ForceFocus(IntPtr h) {
    ShowWindow(h, 6); System.Threading.Thread.Sleep(120);
    ShowWindow(h, 9); BringWindowToTop(h); SetForegroundWindow(h);
  }
}
'@

function Show-Fg($label) {
  $h = [Ws]::GetForegroundWindow()
  $t = [Ws]::Title($h)
  $proc = '?'
  try {
    $pid2 = 0
    [void][Ws]::GetWindowThreadProcessId($h, [ref]$pid2)
    $proc = (Get-Process -Id $pid2 -ErrorAction Stop).ProcessName
  } catch { }
  Write-Host ("  [{0}] '{1}'  (proc={2})" -f $label, $t, $proc)
}

if ($CheckOnly) { Show-Fg 'now'; exit 0 }

if ($StealTo -ne '') {
  $h = [Ws]::Find($StealTo)
  if ($h -eq [IntPtr]::Zero) { Write-Host "window containing '$StealTo' not found"; exit 1 }
  [Ws]::ForceFocus($h)
  Start-Sleep -Milliseconds 500
  Show-Fg "stolen to '$StealTo'"
} else {
  Show-Fg 'start'
}
