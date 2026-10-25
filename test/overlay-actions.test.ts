import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { TaskStore } from '../src/main/store';
import type { Snapshot, TaskActionRequest } from '../src/shared/types';

/** 运行整个 classic script，只替代浏览器宿主，不改写/截取被测函数。 */
class Element {
  textContent = '';
  hidden = false;
  className = '';
  dataset: Record<string, string> = {};
  children: Element[] = [];
  private classes = new Set<string>();
  private listeners = new Map<string, () => void>();
  style = { setProperty: vi.fn() };
  classList = {
    add: (...names: string[]) => names.forEach(name => this.classes.add(name)),
    remove: (...names: string[]) => names.forEach(name => this.classes.delete(name)),
    toggle: (name: string, active: boolean) => active ? this.classes.add(name) : this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
  };
  appendChild(child: Element) { this.children.push(child); }
  setAttribute() { /* Accessible labels do not change the action under test. */ }
  removeAttribute() { /* SPEC-032 跳转态解除与 setAttribute 对称；本测试只断言动作序列。 */ }
  replaceChildren() { this.children = []; }
  remove() { /* 行移除不是本测试目标 */ }
  addEventListener(name: string, callback: () => void) { this.listeners.set(name, callback); }
  click() { this.listeners.get('click')?.(); }
}
const compiled = ts.transpileModule(readFileSync('src/renderer/overlay.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const settle = () => new Promise(resolve => setImmediate(resolve));
async function fixture(failure?: 'result' | 'reject', feedbackFailure = false) {
  const elements = new Map<string, Element>();
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const store = new TaskStore(['codex', 'wb'].map(id => ({ id, name: id, enabled: true, monitor: { type: 'webhook' as const, listen: '127.0.0.1', path: `/hook/${id}` } })));
  store.apply('codex', { status: 'running' });
  let onSnapshot!: (snapshot: Snapshot) => void;
  let onToast!: (message: { message: string }) => void;
  const send = vi.fn(async (request: TaskActionRequest) => {
    if (request.action === 'focus_terminal') {
      if (failure === 'reject') throw new Error('fixture IPC failure');
      if (failure === 'result') return { ok: false, message: '未找到 Codex 窗口' };
    }
    return { ok: true };
  });
  const feedback = vi.fn(async () => {
    if (feedbackFailure) throw new Error('fixture feedback IPC failure');
    return { ok: true };
  });
  runInNewContext(compiled, {
    document: { getElementById: get, createElement: () => new Element(), body: new Element() },
    window: {
      setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(), addEventListener: vi.fn(),
      aiIndicator: { getSnapshot: async () => store.getSnapshot(), onSnapshot: (fn: typeof onSnapshot) => { onSnapshot = fn; }, onToast: (fn: typeof onToast) => { onToast = fn; }, onLayout: vi.fn(), onPlaySound: vi.fn(), sendTaskAction: send, showPanelMessage: feedback },
      // SPEC-035：共享助手替身（overlay.ts 加载即解构 window.aiUi）。
      aiUi: { statusLabel: (status: string) => ({ idle: '空闲', starting: '启动中', running: '运行中', waiting: '等待授权', success: '已完成', failed: '失败', unknown: '失联' } as Record<string, string>)[status] ?? '空闲' },
    }, console,
  });
  await settle();
  return { get, store, send, feedback, update: () => onSnapshot(store.getSnapshot()), toast: (message: string) => onToast({ message }), row: () => get('strip-rows').children[0]! };
}

describe('SPEC-002 浮窗点击特征与失败反馈', () => {
  it('运行行只切换，复用行变绿后独立发送切换与确认', async () => {
    const f = await fixture(); const row = f.row(); row.click(); await settle();
    expect(f.send.mock.calls.map(([r]) => r.action)).toEqual(['focus_terminal']);
    f.store.apply('codex', { status: 'success', completionAt: 100 }); f.update();
    expect(f.row()).toBe(row); f.send.mockClear(); row.click(); await settle();
    expect(f.send.mock.calls.map(([r]) => r.action)).toEqual(['focus_terminal', 'mark_read']);
  });
  it('既有主进程一次性通知仍可显示', async () => {
    const f = await fixture(); f.toast('配置已重载');
    expect(f.get('lamp-toast').textContent).toBe('配置已重载');
    expect(f.get('lamp-toast').classList.contains('show')).toBe(true);
  });
  it.each(['result', 'reject'] as const)('SPEC-013 切换失败 %s 转面板提示，同时仍确认完成', async failure => {
    const f = await fixture(failure); f.store.apply('codex', { status: 'success', completionAt: 100 }); f.update(); f.row().click(); await settle();
    expect(f.send.mock.calls.map(([r]) => r.action)).toEqual(['focus_terminal', 'mark_read']);
    expect(f.feedback).toHaveBeenCalledWith(failure === 'result' ? '未找到 Codex 窗口' : '操作失败，请从面板查看或重试');
    expect(f.get('lamp-toast').classList.contains('show')).toBe(false);
  });
  it('SPEC-013 反馈通道失败时显示简短退化提示，无未处理异常', async () => {
    const f = await fixture('result', true); f.row().click(); await settle(); await settle();
    expect(f.feedback).toHaveBeenCalled();
    expect(f.get('lamp-toast').textContent).toBe('切换失败，请打开面板');
  });
});
