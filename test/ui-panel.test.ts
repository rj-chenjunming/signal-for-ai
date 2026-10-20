import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { TaskStore } from '../src/main/store';
import type { Snapshot } from '../src/shared/types';

// Minimal DOM host; execute the complete renderer, with real tree queries and bubbling.
class Element {
  children: Element[] = [];
  parent: Element | null = null;
  className = ''; textContent = ''; hidden = false; disabled = false; open = false;
  dataset: Record<string, string> = {}; style: Record<string, unknown> = {};
  listeners: Record<string, ((event: any) => unknown)[]> = {};
  constructor(public tag = 'div') {}
  classList = {
    add: (name: string) => { this.className += ` ${name}`; },
    remove: (name: string) => { this.className = this.className.split(' ').filter(x => x !== name).join(' '); },
    toggle: (name: string, on: boolean) => on ? this.classList.add(name) : this.classList.remove(name),
  };
  setAttribute(name: string, value: string) {
    if (name === 'class') this.className = value;
    if (name.startsWith('data-')) this.dataset[name.slice(5)] = value;
    if (name === 'hidden') this.hidden = true;
  }
  set innerHTML(html: string) {
    this.children = []; const stack: Element[] = [this];
    for (const match of html.matchAll(/<(\/)?([\w-]+)([^>]*)>/g)) {
      if (match[1]) { if (stack.length > 1) stack.pop(); continue; }
      const child = new Element(match[2]);
      for (const attr of match[3].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) child.setAttribute(attr[1], attr[2] ?? '');
      stack.at(-1)!.appendChild(child);
      if (!['br', 'input', 'hr'].includes(child.tag) && !match[3].endsWith('/')) stack.push(child);
    }
  }
  get firstChild() { return this.children[0] ?? null; }
  get nextSibling(): Element | null { return this.parent?.children[this.parent.children.indexOf(this) + 1] ?? null; }
  appendChild(child: Element) { child.remove(); child.parent = this; this.children.push(child); return child; }
  insertBefore(child: Element, cursor: Element | null) { child.remove(); child.parent = this; const i = cursor ? this.children.indexOf(cursor) : -1; if (i < 0) this.children.push(child); else this.children.splice(i, 0, child); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); this.parent = null; }
  matches(selector: string) {
    const cls = selector.match(/\.([\w-]+)/)?.[1]; const action = selector.match(/data-action="([^"]+)"/)?.[1];
    return (!cls || this.className.split(' ').includes(cls)) && (!action || this.dataset.action === action)
      && (!selector.startsWith('details') || this.tag === 'details') && (!selector.includes('[open]') || this.open);
  }
  querySelectorAll(selector: string): Element[] { return this.children.flatMap(c => [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)]); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(name: string, fn: (e: any) => unknown) { (this.listeners[name] ??= []).push(fn); }
  dispatch(name: string, event: any = {}) { let stopped = false; event.stopPropagation ??= () => { stopped = true; }; event.preventDefault ??= () => {}; for (const fn of this.listeners[name] ?? []) void fn(event); if (!stopped) this.parent?.dispatch(name, event); }
  click() { if (!this.disabled) this.dispatch('click'); }
}
const settle = () => new Promise(resolve => setImmediate(resolve));
async function fixture(fail = false, pendingMessage?: string) {
  const root = new Element(); const els = new Map<string, Element>();
  const get = (id: string) => { if (!els.has(id)) { const el = new Element(); els.set(id, el); root.appendChild(el); } return els.get(id)!; };
  const store = new TaskStore([{ id: 'codex', name: '<b>Codex</b>', enabled: true, monitor: { type: 'codex', sessionsDir: '/fixture' } }]);
  let update!: (s: Snapshot) => void;
  const pause = vi.fn(async () => ({ ok: !fail, message: fail ? '切换失败' : undefined }));
  const send = vi.fn(async () => ({ ok: true })); const toggle = vi.fn();
  const document = { getElementById: get, createElement: (tag: string) => new Element(tag), body: root, querySelector: root.querySelector.bind(root), querySelectorAll: root.querySelectorAll.bind(root), addEventListener: root.addEventListener.bind(root) };
  runInNewContext(ts.transpileModule(readFileSync('src/renderer/panel.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    document, console, window: { setInterval: vi.fn(), setTimeout: vi.fn(), clearTimeout: vi.fn(), aiIndicator: { getSnapshot: async () => store.getSnapshot(), onSnapshot: (fn: typeof update) => { update = fn; }, onToast: vi.fn(), takePanelMessage: async () => ({ message: pendingMessage }), sendTaskAction: send, togglePanel: toggle, setMonitoringPaused: pause } },
  });
  await settle(); return { get, root, pause, send, toggle, store, update: () => update(store.getSnapshot()) };
}
it('pause/resume calls IPC and waits for snapshot; failures remain actionable', async () => {
  const f = await fixture(true); f.get('btn-pause').click(); f.get('btn-pause').click();
  expect(f.pause).toHaveBeenCalledTimes(1); expect(f.get('btn-pause').disabled).toBe(true);
  await settle(); expect(f.get('btn-pause').disabled).toBe(false); expect(f.root.querySelector('.panel-toast')?.textContent).toBe('切换失败');
  f.store.setPaused(true); f.update(); f.get('btn-pause').click(); await settle(); expect(f.pause).toHaveBeenLastCalledWith(false);
});
it('primary focus stays visible; secondary capabilities and Esc respect menu state', async () => {
  const f = await fixture(); const row = f.get('panel-list').children[0];
  const primary = row.querySelector('[data-action="focus_terminal"]')!;
  expect(primary.textContent).toBe('切回工具'); primary.click(); await settle(); expect(f.send).toHaveBeenCalledTimes(1);
  expect(row.querySelector('[data-action="open_log"]')?.hidden).toBe(true);
  expect(row.querySelector('[data-action="open_dir"]')?.hidden).toBe(true);
  expect(row.querySelector('[data-action="mark_read"]')?.hidden).toBe(true);
  const more = row.querySelector('details')!; expect(more).not.toBeNull(); expect(more.open).toBe(false);
  more.open = true; f.root.dispatch('keydown', { key: 'Escape' }); expect(more.open).toBe(false); expect(f.toggle).not.toHaveBeenCalled();
  f.root.dispatch('keydown', { key: 'Escape' }); expect(f.toggle).toHaveBeenCalledTimes(1);
});
it('global pause labels held task states and prevents retry until resumed', async () => {
  const f = await fixture(); f.store.setPaused(true); f.update();
  const row = f.get('panel-list').children[0];
  expect(row.querySelector('.task-status-label')?.textContent).toBe('监控已暂停');
  expect(row.querySelector('[data-action="retry"]')?.disabled).toBe(true);
  f.store.setPaused(false); f.update();
  expect(row.querySelector('[data-action="retry"]')?.disabled).toBe(false);
});
it('SPEC-013 first-open pending feedback appears as plain text', async () => {
  const f = await fixture(false, '未找到 dsh 主窗口 <b>请先打开工具</b>');
  expect(f.root.querySelector('.panel-toast')?.textContent).toBe('未找到 dsh 主窗口 <b>请先打开工具</b>');
  expect(f.root.querySelector('.panel-toast')?.children).toHaveLength(0);
});
