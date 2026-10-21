import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { TaskConfig } from '../../shared/types';
import { MonitorAdapter, type MonitorContext, type MonitorEvent, type MonitorSink } from './base';
import { parseTasklistPayload } from './process-enum';

export type PresenceReader = (fresh?: boolean) => Promise<readonly string[]>;
const normalize = (name: string): string => name.trim().toLowerCase().replace(/\.exe$/, '');

/** Explicit desktop routes only. Remote/web/CLI sources keep their existing lifecycle. */
export function desktopProcessNames(task: TaskConfig): readonly string[] {
  const monitor = task.monitor;
  if (!['dsh', 'sqlite', 'codex'].includes(monitor.type)) return [];
  if (monitor.type === 'dsh') {
    if (monitor.sshHost) return [];
    if (monitor.authority !== 'auto') {
      try {
        const host = new URL(`http://${monitor.authority}`).hostname.toLowerCase();
        if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return [];
      } catch { return []; }
    }
  }
  const route = task.jump?.terminal;
  return route?.type === 'windowProcess' || route?.type === 'windowTitle'
    ? [...new Set((route.processNames ?? []).map(normalize).filter(Boolean))].sort() : [];
}

export function parsePresenceNames(stdout: string): readonly string[] {
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  // A partial/error payload must not be mistaken for a complete process inventory.
  if (!lines.length || lines.some(line => !/^"[^"]+","\d+","[^"]*","\d+","[^"]*"$/.test(line))) {
    throw new Error('tasklist 返回了不完整或无法识别的进程列表');
  }
  const names = parseTasklistPayload(stdout).map(process => process.name);
  if (!names.length) throw new Error('tasklist 没有返回有效进程');
  return names;
}

async function readWindowsProcesses(): Promise<string> {
  return new Promise((resolve, reject) => {
    const exe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tasklist.exe');
    execFile(exe, ['/fo', 'csv', '/nh'], { windowsHide: true, timeout: 3000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

/** Share a bounded read across all desktop tasks; a failure is never cached as absence. */
export function createPresenceReader(read = readWindowsProcesses, now = Date.now): PresenceReader {
  let cached: readonly string[] | undefined;
  let cachedAt = 0;
  let pending: Promise<readonly string[]> | undefined;
  return (fresh = false) => {
    if (pending) return pending;
    if (!fresh && cached && now() - cachedAt < 1000) return Promise.resolve(cached);
    pending = read().then(parsePresenceNames).then(names => {
      cached = names; cachedAt = now(); return names;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}

interface PresenceOptions {
  names: readonly string[];
  reader: PresenceReader;
  intervalMs: number;
  source: (sink: MonitorSink) => MonitorAdapter;
}

/** A healthy waiting guard owns no data adapter while the application is absent. */
export class ProcessPresenceMonitor extends MonitorAdapter {
  private timer: NodeJS.Timeout | undefined;
  private pending: Promise<void> | undefined;
  private source: MonitorAdapter | undefined;
  private generation = 0;
  private revision = 0;
  private present: boolean | undefined;
  private checks = new Set<Promise<void>>();
  constructor(ctx: MonitorContext, private readonly options: PresenceOptions) { super(ctx); }

  override async start(): Promise<void> {
    if (this.isRunning || this.isDisposed) return;
    this.setRunning(true);
    await this.pollOnce();
    if (!this.isRunning) return;
    this.timer = setInterval(() => { void this.pollOnce(); }, Math.max(1000, this.options.intervalMs));
    this.timer.unref?.();
  }

  pollOnce(): Promise<void> {
    if (!this.isRunning) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.reconcile().catch(error => {
      if (!this.isRunning) return;
      this.log.warn(`进程存在性检查失败，保留上次观测：${error instanceof Error ? error.message : String(error)}`);
      if (this.present === undefined) this.emitStatus('unknown', '无法检查程序是否运行，请查看日志');
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async exists(fresh = false): Promise<boolean> {
    const names = await this.options.reader(fresh);
    const wanted = new Set(this.options.names.map(normalize));
    return names.some(name => wanted.has(normalize(name)));
  }

  private setPresence(present: boolean): void {
    if (this.present === present || !this.isRunning) return;
    this.present = present;
    this.log.info(present ? '程序已运行，恢复数据监控' : '程序未运行，停止数据监控并等待启动');
    this.emit({ kind: 'presence', present, at: Date.now() });
  }

  private async absent(): Promise<void> {
    ++this.generation;
    const old = this.source; this.source = undefined;
    this.setPresence(false);
    if (old) {
      try { await old.stop(); } catch (error) { this.log.logError('停止已退出工具的数据监控失败', error); }
    }
  }

  private async reconcile(): Promise<void> {
    const present = await this.exists();
    if (!this.isRunning) return;
    if (!present) { await this.absent(); return; }
    this.setPresence(true);
    if (this.source) return;
    const generation = ++this.generation;
    const source = this.options.source((_id, event) => this.forward(generation, event));
    this.source = source;
    try { await source.start(); }
    catch (error) {
      if (this.isRunning && generation === this.generation) {
        this.emitStatus('unknown', '数据监控启动失败，请查看日志');
        this.log.logError('数据监控启动失败', error);
      }
      if (this.source === source) this.source = undefined;
      await source.stop();
    }
  }

  private forward(generation: number, event: MonitorEvent): void {
    if (!this.isRunning || generation !== this.generation) return;
    const revision = event.kind === 'status' ? ++this.revision : this.revision;
    if (event.kind !== 'status' || !['failed', 'unknown'].includes(event.status)) {
      this.emit(event); return;
    }
    // Source errors often race normal application exit. Recheck without the short cache.
    const check = (async () => {
      let present = true;
      try { present = await this.exists(true); }
      catch (error) { this.log.logError('错误上报前的进程复查失败，保留原始错误', error); }
      if (!this.isRunning || generation !== this.generation) return;
      if (!present) { await this.absent(); return; }
      if (revision === this.revision) this.emit(event);
    })().catch(error => { this.log.logError('处理数据源状态失败', error); });
    this.checks.add(check);
    void check.finally(() => this.checks.delete(check));
  }

  override async stop(): Promise<void> {
    this.setRunning(false); this.markDisposed(); ++this.generation;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
    await Promise.all([...this.checks]);
    const old = this.source; this.source = undefined;
    if (old) await old.stop();
  }
  get hasActiveSource(): boolean { return this.source !== undefined; }
  override isHealthy(): boolean {
    return super.isHealthy() && (!this.source || this.source.isHealthy());
  }
}
