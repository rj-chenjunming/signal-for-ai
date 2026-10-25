/**
 * 常驻 PowerShell 焦点 worker（SPEC-036）。
 *
 * ============================================================================
 * 【为什么存在】
 * ============================================================================
 * focus.ts 的 Win32 激活脚本（LampFocus）每次点击都要 spawn powershell.exe
 * 并 Add-Type 现场编译 C#（实测 1–3s），是 SPEC-022 优化后剩余 ~2s 时延的
 * 主要成分。本模块把脚本放进一个常驻 PowerShell 子进程：启动时编译一次，
 * 之后经 stdin/stdout 的 JSON-lines 协议处理请求，单次调用毫秒级。
 *
 * 【降级铁律】worker 的任何失败（启动失败/超时/进程退出/非 Windows）都
 * 以"抛出"上报，由 FocusService 回落到原有的按次 spawn 路径——那条路径
 * 与其全部测试原样保留，worker 只是快路径，绝不成为单点。
 *
 * 【协议】每行一个 JSON 对象：
 *   请求：{"id":1,"op":"activate","hwnd":100,"pid":101}
 *   响应：{"id":1,"ok":true,"detail":"ok title=..."}
 * 响应按 id 匹配；无法解析或 id 不匹配的行丢弃。应用退出必须调用 kill()。
 *
 * 【脚本本体】activate 的 Win32 序列与 focus.ts activateViaWin32 逐行同构
 * （owner 校验 → SW_MINIMIZE/SW_RESTORE → BringWindowToTop → SetForegroundWindow
 * → GetForegroundWindow 确认，'stale window' 语义一致）。改动任一侧必须
 * 同步另一侧——脚本逻辑由既有真机记录兜底，协议行为由本模块测试兜底。
 */

import { spawn, type ChildProcess } from 'node:child_process';

export interface WorkerResult {
  ok: boolean;
  detail: string;
}

/** 可注入的进程工厂（测试用假流；生产为隐藏窗口的 powershell.exe）。 */
export type WorkerSpawnFactory = (script: string) => ChildProcess | null;

export interface FocusWorkerManagerOptions {
  /** 缺省为 powershell.exe -NoProfile -NonInteractive -Command <script>。 */
  spawnFactory?: WorkerSpawnFactory;
  logger?: { warn(message: string): void; info(message: string): void };
  /** 单请求超时；超时视为 worker 故障（invalidate + 抛出，由上层回落）。 */
  requestTimeoutMs?: number;
  /** 首次启动 + ping 的超时（Add-Type 编译实测 1–3s，留足余量）。 */
  startTimeoutMs?: number;
}

/** 响应行；坏行/未知 id 由分发器丢弃。 */
interface WorkerEnvelope {
  id: number;
  ok: boolean;
  detail: string;
}

/** activate 的 Win32 序列：与 focus.ts activateViaWin32 同体（见文件头）。 */
export const FOCUS_WORKER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class LampWorker {',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);',
  '}',
  '"@',
  // SPEC-037：与 hidden-window.ts 的 LampWindowDiscovery 同体（枚举含隐藏窗口）。
  'Add-Type -TypeDefinition @\'',
  'using System;',
  'using System.Collections.Generic;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public class LampWindowDiscovery {',
  '  public delegate bool Callback(IntPtr h, IntPtr p);',
  '  [DllImport("user32.dll")] private static extern bool EnumWindows(Callback cb, IntPtr p);',
  '  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);',
  '  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr h, uint cmd);',
  '  [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr h, int index);',
  '  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out Rect r);',
  '  private struct Rect { public int Left, Top, Right, Bottom; }',
  '  public static List<object> Find(Dictionary<int,string> processes) {',
  '    var rows = new List<object>(); bool overflow = false;',
  '    bool enumerated = EnumWindows(delegate(IntPtr h, IntPtr p) {',
  '      uint pid; GetWindowThreadProcessId(h, out pid);',
  '      if (!processes.ContainsKey((int)pid)) return true;',
  '      if (rows.Count >= 256) { overflow = true; return false; }',
  '      var title = new StringBuilder(1024); GetWindowText(h, title, title.Capacity);',
  '      var cls = new StringBuilder(256); GetClassName(h, cls, cls.Capacity);',
  '      Rect r; bool bounds = GetWindowRect(h, out r);',
  '      rows.Add(new {Id=pid, ProcessName=processes[(int)pid], MainWindowHandle=h.ToInt64(), MainWindowTitle=title.ToString(), ClassName=cls.ToString(), Visible=IsWindowVisible(h), Owner=GetWindow(h,4).ToInt64(), ToolWindow=(GetWindowLong(h,-20)&128)!=0, Width=bounds ? r.Right-r.Left : 0, Height=bounds ? r.Bottom-r.Top : 0});',
  '      return true;',
  '    }, IntPtr.Zero);',
  '    if (!enumerated || overflow) throw new InvalidOperationException("Incomplete window enumeration");',
  '    return rows;',
  '  }',
  '}',
  '\'@',
  // SPEC-037：与 native-window-reveal.ts 的 LampNativeOwner 同体（单实例 handoff 恢复）。
  "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class LampNativeOwner { [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr h); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int cmd); [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern bool BringWindowToTop(IntPtr h); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport(\"user32.dll\")] public static extern bool AttachThreadInput(uint a, uint b, bool attach); [DllImport(\"kernel32.dll\")] public static extern uint GetCurrentThreadId(); }'",
  'function Invoke-Activate([long]$h, [long]$ownerCheckPid) {',
  '  [uint32]$ownerPid = 0',
  '  [void][LampWorker]::GetWindowThreadProcessId([IntPtr]$h, [ref]$ownerPid)',
  "  if ($ownerPid -ne $ownerCheckPid) { return @{ ok = $false; detail = 'stale window' } }",
  '  [void][LampWorker]::ShowWindow([IntPtr]$h, 6)',
  '  Start-Sleep -Milliseconds 120',
  '  [void][LampWorker]::ShowWindow([IntPtr]$h, 9)',
  '  [void][LampWorker]::BringWindowToTop([IntPtr]$h)',
  '  [void][LampWorker]::SetForegroundWindow([IntPtr]$h)',
  '  Start-Sleep -Milliseconds 250',
  '  $fgH = [LampWorker]::GetForegroundWindow()',
  '  $sb = New-Object System.Text.StringBuilder 300',
  '  [void][LampWorker]::GetWindowText($fgH, $sb, 300)',
  "  if ($fgH -eq [IntPtr]$h) { return @{ ok = $true; detail = ('ok title=' + $sb.ToString()) } }",
  "  return @{ ok = $false; detail = ('not foreground title=' + $sb.ToString()) }",
  '}',
  // SPEC-037：与 refreshWindows 的枚举脚本同体（空结果返回 []，语义对齐 spawn 路径）。
  'function Invoke-Enumerate {',
  '  $rows = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object Id, ProcessName, MainWindowTitle, MainWindowHandle)',
  '  ConvertTo-Json -InputObject $rows -Compress',
  '}',
  // SPEC-037：与 hidden-window.ts 的查询脚本同体（names 已是解码后的数组）。
  'function Invoke-Hidden($wantedNames) {',
  "  $processes = New-Object 'System.Collections.Generic.Dictionary[int,string]'",
  '  Get-Process | Where-Object { $wantedNames -contains $_.ProcessName.ToLowerInvariant() } | ForEach-Object { $processes[$_.Id] = $_.ProcessName }',
  "  if ($processes.Count -eq 0) { return '[]' }",
  "  if ($processes.Count -gt 128) { throw 'Too many target processes' }",
  '  $rows = @([LampWindowDiscovery]::Find($processes))',
  '  ConvertTo-Json -InputObject $rows -Compress',
  '}',
  // SPEC-037：与 native-window-reveal.ts 的恢复脚本同体（profile 表替代字符串插值）。
  'function Invoke-Reveal([string]$appKey, [long]$h, [long]$ownerCheckPid) {',
  '  $profiles = @{',
  "    dsh = @{ label = 'dsh'; processName = 'DeepSeek Harness'; executableName = 'DeepSeek Harness.exe'; marker = 'LAMPDSHREVEAL ok=True' }",
  "    workbuddy = @{ label = 'WorkBuddy'; processName = 'WorkBuddy'; executableName = 'WorkBuddy.exe'; marker = 'LAMPWORKBUDDYREVEAL ok=True' }",
  '  }',
  '  $profile = $profiles[$appKey]',
  "  if ($null -eq $profile) { throw 'Unsupported native window application' }",
  '  [uint32]$ownerPid = 0',
  '  $nativeHandle = [IntPtr]$h',
  '  [void][LampNativeOwner]::GetWindowThreadProcessId($nativeHandle, [ref]$ownerPid)',
  "  if ($ownerPid -ne $ownerCheckPid) { throw ($profile.label + ' window owner changed') }",
  '  function Set-LampForeground($h) {',
  '    [void][LampNativeOwner]::BringWindowToTop($h)',
  '    [void][LampNativeOwner]::SetForegroundWindow($h)',
  '    if ([LampNativeOwner]::GetForegroundWindow() -ne $h) {',
  '      [uint32]$fgPid = 0',
  '      [uint32]$fgThread = [LampNativeOwner]::GetWindowThreadProcessId([LampNativeOwner]::GetForegroundWindow(), [ref]$fgPid)',
  '      [uint32]$me = [LampNativeOwner]::GetCurrentThreadId()',
  '      [void][LampNativeOwner]::AttachThreadInput($fgThread, $me, $true)',
  '      [void][LampNativeOwner]::SetForegroundWindow($h)',
  '      [void][LampNativeOwner]::AttachThreadInput($fgThread, $me, $false)',
  '    }',
  '  }',
  '  $targetProcess = Get-Process -Id $ownerCheckPid -ErrorAction Stop',
  "  if ($targetProcess.ProcessName -ine $profile.processName -or $targetProcess.HasExited) { throw ($profile.label + ' owner is unavailable') }",
  '  $executable = $targetProcess.Path',
  "  if ([string]::IsNullOrWhiteSpace($executable) -or ![IO.Path]::IsPathRooted($executable) -or [IO.Path]::GetFileName($executable) -ine $profile.executableName -or ![IO.File]::Exists($executable)) { throw ($profile.label + ' executable is unavailable') }",
  '  $relay = Start-Process -FilePath $executable -WorkingDirectory ([IO.Path]::GetDirectoryName($executable)) -WindowStyle Hidden -PassThru',
  '  try {',
  "    if (!$relay.WaitForExit(3000)) { throw ($profile.label + ' single-instance handoff timed out') }",
  "    if ($relay.ExitCode -ne 0) { throw ($profile.label + ' single-instance handoff failed') }",
  '    if ([LampNativeOwner]::IsIconic($nativeHandle)) {',
  '      [void][LampNativeOwner]::ShowWindow($nativeHandle, 9)',
  '      Start-Sleep -Milliseconds 120',
  '    }',
  '    # SPEC-023：不做最小化复位；SPEC-022：前台确认并入本脚本，成功 marker 只在真实前台时输出。',
  '    $foreground = $false',
  '    for ($i = 0; $i -lt 25; $i++) {',
  '      if ([LampNativeOwner]::GetForegroundWindow() -eq $nativeHandle) { $foreground = $true; break }',
  '      Set-LampForeground $nativeHandle',
  '      Start-Sleep -Milliseconds 100',
  '    }',
  "    if (!$foreground) { throw ($profile.label + ' foreground not confirmed') }",
  '    return $profile.marker',
  '  } finally {',
  '    $relay.Dispose()',
  '  }',
  '}',
  'while ($null -ne ($line = [Console]::In.ReadLine())) {',
  "  if (-not $line.Trim()) { continue }",
  '  $req = $null',
  '  try { $req = $line | ConvertFrom-Json } catch { $req = $null }',
  '  if ($null -eq $req -or $null -eq $req.id -or $null -eq $req.op) { continue }',
  '  $id = [long]$req.id',
  '  try {',
  "    if ($req.op -eq 'ping') {",
  "      Write-Output ('{\"id\":' + $id + ',\"ok\":true,\"detail\":\"pong\"}')",
  '    } elseif ($req.op -eq \'activate\') {',
  '      $r = Invoke-Activate ([long]$req.hwnd) ([long]$req.pid)',
  '      $out = @{ id = $id; ok = [bool]$r.ok; detail = [string]$r.detail } | ConvertTo-Json -Compress',
  '      Write-Output $out',
  '    } elseif ($req.op -eq \'enumerate\') {',
  '      $out = @{ id = $id; ok = $true; detail = [string](Invoke-Enumerate) } | ConvertTo-Json -Compress',
  '      Write-Output $out',
  "    } elseif ($req.op -eq 'hidden') {",
  '      $out = @{ id = $id; ok = $true; detail = [string](Invoke-Hidden @($req.names)) } | ConvertTo-Json -Compress',
  '      Write-Output $out',
  "    } elseif ($req.op -eq 'reveal') {",
  '      $marker = Invoke-Reveal ([string]$req.app) ([long]$req.hwnd) ([long]$req.pid)',
  '      $out = @{ id = $id; ok = $true; detail = [string]$marker } | ConvertTo-Json -Compress',
  '      Write-Output $out',
  '    } else {',
  '      Write-Output (\'{"id":\' + $id + \',"ok":false,"detail":"unknown op"}\')',
  '    }',
  '  } catch {',
  '    $err = @{ id = $id; ok = $false; detail = ($_ | Out-String).Trim() } | ConvertTo-Json -Compress',
  '    Write-Output $err',
  '  }',
  '  [Console]::Out.Flush()',
  '}',
].join('\n');

const NOOP_LOGGER = { warn: () => undefined, info: () => undefined };

export class FocusWorkerManager {
  private readonly spawnFactory: WorkerSpawnFactory;
  private readonly logger: { warn(message: string): void; info(message: string): void };
  private readonly requestTimeoutMs: number;
  private readonly startTimeoutMs: number;

  private child: ChildProcess | null = null;
  private seq = 0;
  private buffer = '';
  /** 懒启动进行中；失败时置回 null，下一次 exec 重新尝试（每次调用至多一次尝试）。 */
  private starting: Promise<void> | null = null;
  private readonly pending = new Map<
    number,
    { resolve: (result: WorkerResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(options: FocusWorkerManagerOptions = {}) {
    this.spawnFactory =
      options.spawnFactory ??
      ((script) =>
        spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        }));
    this.logger = options.logger ?? NOOP_LOGGER;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    this.startTimeoutMs = options.startTimeoutMs ?? 15000;
  }

  /**
   * 执行一个 op。任何失败（未启动/启动失败/超时/进程退出/非 Windows）
   * 都抛出并 invalidate——调用方（FocusService）负责回落到按次 spawn。
   */
  async exec(op: string, params: Record<string, unknown>): Promise<WorkerResult> {
    if (process.platform !== 'win32') {
      throw new Error('焦点 worker 仅支持 Windows');
    }
    await this.ensureStarted();
    const child = this.child;
    if (!child || !child.stdin) {
      this.invalidate();
      throw new Error('焦点 worker 未运行');
    }

    const id = ++this.seq;
    const payload = JSON.stringify({ id, op, ...params });
    return new Promise<WorkerResult>((resolve, reject) => {
      const timeoutMs = op === 'ping' ? this.startTimeoutMs : this.requestTimeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.logger.warn(`焦点 worker 请求超时（op=${op}，${timeoutMs}ms），已失效并回落`);
        this.invalidate();
        reject(new Error(`焦点 worker 请求超时（op=${op}）`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin!.write(`${this.encodeLine(payload)}\n`, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          this.invalidate();
          reject(new Error(`焦点 worker 写入失败：${err.message}`));
        }
      });
    });
  }

  /** 杀掉常驻进程并拒绝全部在途请求（应用退出 / 故障失效共用）。 */
  kill(): void {
    const child = this.child;
    this.child = null;
    this.starting = null;
    this.buffer = '';
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('焦点 worker 已终止'));
    }
    this.pending.clear();
    if (child && !child.killed) {
      try {
        child.kill();
      } catch {
        /* 尽力而为 */
      }
    }
  }

  /* ---------------------------------------------------------------- 内部 */

  private ensureStarted(): Promise<void> {
    if (this.child) {
      return Promise.resolve();
    }
    if (this.starting) {
      return this.starting;
    }
    const attempt = this.start();
    this.starting = attempt;
    // 成功/失败后都清掉 starting：成功后以 this.child 判断健康；
    // 失败后允许下一次 exec 重新尝试一次（不循环重启）。
    const settled = (): void => {
      if (this.starting === attempt) {
        this.starting = null;
      }
    };
    void attempt.then(settled, settled);
    return attempt;
  }

  private async start(): Promise<void> {
    const child = this.spawnFactory(FOCUS_WORKER_SCRIPT);
    if (!child || !child.stdin || !child.stdout) {
      throw new Error('焦点 worker 启动失败（spawn 不可用）');
    }
    this.child = child;
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf('\n');
      while (index >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        this.dispatch(line);
        index = this.buffer.indexOf('\n');
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text) {
        this.logger.warn(`焦点 worker stderr：${text.slice(0, 200)}`);
      }
    });
    child.on('exit', () => {
      if (this.child === child) {
        this.logger.warn('焦点 worker 进程退出，将在下次请求时重新启动');
        this.invalidate();
      }
    });
    child.on('error', (err) => {
      this.logger.warn(`焦点 worker 进程错误：${err.message}`);
      if (this.child === child) {
        this.invalidate();
      }
    });

    // ping 兼作启动健康检查（真实场景里 Add-Type 编译发生在这段时间内）。
    const pong = await this.execRaw('ping', {});
    if (!pong.ok) {
      throw new Error(`焦点 worker ping 失败：${pong.detail}`);
    }
    this.logger.info('焦点 worker 已就绪（C# 已预编译）');
  }

  /** ensureStarted 内部使用的裸请求（ping 也走 id 匹配，但不再递归 ensureStarted）。 */
  private execRaw(op: string, params: Record<string, unknown>): Promise<WorkerResult> {
    const child = this.child;
    if (!child || !child.stdin) {
      return Promise.reject(new Error('焦点 worker 未运行'));
    }
    const id = ++this.seq;
    const payload = JSON.stringify({ id, op, ...params });
    return new Promise<WorkerResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.invalidate();
        reject(new Error(`焦点 worker 启动超时（op=${op}）`));
      }, this.startTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin!.write(`${this.encodeLine(payload)}\n`, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          this.invalidate();
          reject(new Error(`焦点 worker 写入失败：${err.message}`));
        }
      });
    });
  }

  /**
   * SPEC-037：请求行统一转义为纯 ASCII（非 ASCII → \uXXXX）。
   * worker 的 stdin 是 PS 5.1 Console.In（OEM 代码页），原始 UTF-8 中文会被
   * 读坏；JSON 规范允许 \u 转义，ConvertFrom-Json 原生解码。
   */
  private encodeLine(payload: string): string {
    return payload.replace(/[^\x20-\x7E]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  }

  private dispatch(line: string): void {
    if (!line) {
      return;
    }
    let envelope: WorkerEnvelope;
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        typeof (parsed as WorkerEnvelope).id !== 'number' ||
        typeof (parsed as WorkerEnvelope).ok !== 'boolean'
      ) {
        return;
      }
      envelope = parsed as WorkerEnvelope;
    } catch {
      return; // 坏行丢弃，不崩溃
    }
    const entry = this.pending.get(envelope.id);
    if (!entry) {
      return; // 未知/过期 id
    }
    this.pending.delete(envelope.id);
    clearTimeout(entry.timer);
    entry.resolve({ ok: envelope.ok, detail: envelope.detail });
  }

  private invalidate(): void {
    // 只回收进程与在途请求；starting 的清理交给其自身的 catch，
    // 避免 kill()（退出路径）与启动失败路径互相踩。
    const child = this.child;
    this.child = null;
    this.buffer = '';
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('焦点 worker 已失效'));
    }
    this.pending.clear();
    if (child && !child.killed) {
      try {
        child.kill();
      } catch {
        /* 尽力而为 */
      }
    }
  }
}
