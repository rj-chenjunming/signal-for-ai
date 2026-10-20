import type { TerminalWindow } from './focus';

const normalize = (name: string): string => name.toLowerCase().replace(/\.exe$/u, '');

/** Read-only, process-scoped discovery; unlike MainWindowHandle, EnumWindows includes hidden windows. */
export function buildHiddenWindowScript(processNames: readonly string[]): string {
  const names = Buffer.from(JSON.stringify(processNames.map(normalize)), 'utf8').toString('base64');
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$wantedNames = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${names}')) | ConvertFrom-Json
$processes = New-Object 'System.Collections.Generic.Dictionary[int,string]'
Get-Process | Where-Object { $wantedNames -contains $_.ProcessName.ToLowerInvariant() } | ForEach-Object { $processes[$_.Id] = $_.ProcessName }
if ($processes.Count -eq 0) { Write-Output '[]'; exit 0 }
if ($processes.Count -gt 128) { throw 'Too many target processes' }
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class LampWindowDiscovery {
  public delegate bool Callback(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] private static extern bool EnumWindows(Callback cb, IntPtr p);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out Rect r);
  private struct Rect { public int Left, Top, Right, Bottom; }
  public static List<object> Find(Dictionary<int,string> processes) {
    var rows = new List<object>(); bool overflow = false;
    bool enumerated = EnumWindows(delegate(IntPtr h, IntPtr p) {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!processes.ContainsKey((int)pid)) return true;
      if (rows.Count >= 256) { overflow = true; return false; }
      var title = new StringBuilder(1024); GetWindowText(h, title, title.Capacity);
      var cls = new StringBuilder(256); GetClassName(h, cls, cls.Capacity);
      Rect r; bool bounds = GetWindowRect(h, out r);
      rows.Add(new {Id=pid, ProcessName=processes[(int)pid], MainWindowHandle=h.ToInt64(), MainWindowTitle=title.ToString(), ClassName=cls.ToString(), Visible=IsWindowVisible(h), Owner=GetWindow(h,4).ToInt64(), ToolWindow=(GetWindowLong(h,-20)&128)!=0, Width=bounds ? r.Right-r.Left : 0, Height=bounds ? r.Bottom-r.Top : 0});
      return true;
    }, IntPtr.Zero);
    if (!enumerated || overflow) throw new InvalidOperationException("Incomplete window enumeration");
    return rows;
  }
}
'@
$rows = @([LampWindowDiscovery]::Find($processes))
ConvertTo-Json -InputObject $rows -Compress
`.trim();
}

/** Fail closed: a tray host/helper or an ambiguous set must never become a focus target. */
export function parseHiddenWindow(
  stdout: string, processNames: readonly string[], titleContains: string,
): TerminalWindow | null {
  if (stdout.length > 256 * 1024) return null;
  const raw: unknown = JSON.parse(stdout);
  const rows: unknown[] = Array.isArray(raw) ? raw : [raw];
  if (rows.length > 256) return null;
  const wanted = processNames.map(normalize);
  const matches: TerminalWindow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.Id !== 'number' || !Number.isSafeInteger(r.Id) || r.Id <= 0 ||
        typeof r.MainWindowHandle !== 'number' || !Number.isSafeInteger(r.MainWindowHandle) || r.MainWindowHandle <= 0 ||
        typeof r.ProcessName !== 'string' || !wanted.includes(normalize(r.ProcessName)) ||
        typeof r.MainWindowTitle !== 'string' || !r.MainWindowTitle.trim() ||
        r.Visible !== false || r.Owner !== 0 || r.ToolWindow !== false ||
        r.ClassName !== 'Chrome_WidgetWin_1' ||
        typeof r.Width !== 'number' || !Number.isFinite(r.Width) || r.Width <= 0 ||
        typeof r.Height !== 'number' || !Number.isFinite(r.Height) || r.Height <= 0) continue;
    const titleGuard = titleContains || normalize(r.ProcessName);
    if (!r.MainWindowTitle.toLowerCase().includes(titleGuard.toLowerCase())) continue;
    matches.push({ pid: r.Id, hwnd: r.MainWindowHandle, processName: r.ProcessName,
      title: r.MainWindowTitle, isWindowsTerminal: false });
  }
  return matches.length === 1 ? matches[0]! : null;
}
