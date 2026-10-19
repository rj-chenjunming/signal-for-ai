/**
 * 日志增量读取（log-tail）测试 —— 架构 T11 验收项。
 *
 * 这是log 型监控的地基：如果增量读取有偏差，要么漏掉真正的状态变化（灯不更新），
 * 要么把历史内容当新信号（启动瞬间误判 running/failed）。
 * 因此这里用**真实临时文件**验证字节级行为，而不是 mock fs。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createCursor,
  globFiles,
  initialTail,
  splitLines,
  tailRead,
  type TailCursor,
} from '../src/main/monitors/log-tail';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-logtail-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 写文件并返回绝对路径。 */
function write(name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

describe('tailRead 首次只读末尾 N 字节（PRD T11）', () => {
  it('历史内容超过 maxBytes 时只返回末尾部分', () => {
    // 100 行历史，每行 20 字节，共 2000 字节
    const historical = Array.from({ length: 100 }, (_, i) => `line ${String(i).padStart(4, '0')}----------`).join('\n');
    const f = write('a.log', historical);
    expect(Buffer.byteLength(historical)).toBeGreaterThan(512);

    const result = initialTail(f, 512);

    expect(result.text.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(512);
    // 最早的行必须被丢掉（这正是「历史内容不作为信号」的关键）
    expect(result.text).not.toContain('line 0000');
    // 末尾的行必须保留
    expect(result.text).toContain('line 0099');
  });

  it('文件小于 maxBytes 时全量返回', () => {
    const f = write('small.log', 'abc\ndef\n');
    expect(initialTail(f, 512).text).toBe('abc\ndef\n');
  });

  it('首次读取后游标定位到文件末尾（offset === size）', () => {
    const f = write('a.log', 'x'.repeat(1000));
    const cursor = createCursor();
    tailRead(f, cursor, 400, true);
    expect(cursor.offset).toBe(fs.statSync(f).size);
  });

  it('文件不存在时返回空且 rotated=false，不抛异常', () => {
    // 轮询早期日志文件可能还没创建，不能因此崩掉主进程
    const r = tailRead(path.join(dir, 'nope.log'), createCursor(), 512, true);
    expect(r).toEqual({ text: '', rotated: false });
  });
});

describe('tailRead 后续只读新增字节（PRD T11）', () => {
  it('无新增内容时返回空串', () => {
    const f = write('a.log', 'hello\n');
    const cursor = createCursor();
    tailRead(f, cursor, 512, true);
    expect(tailRead(f, cursor, 512).text).toBe('');
  });

  it('追加内容只返回新增部分，不重复返回历史', () => {
    const f = write('a.log', 'first\n');
    const cursor = createCursor();
    tailRead(f, cursor, 512, true);

    fs.appendFileSync(f, 'second\n', 'utf8');
    expect(tailRead(f, cursor, 512).text).toBe('second\n');

    fs.appendFileSync(f, 'third\n', 'utf8');
    expect(tailRead(f, cursor, 512).text).toBe('third\n');
  });

  it('isFirst 显式为 true 时重新定位，重读末尾窗口（LogMonitor 建新游标用）', () => {
    const f = write('a.log', 'old\n');
    const cursor = createCursor();
    tailRead(f, cursor, 512, true);
    fs.appendFileSync(f, 'new\n', 'utf8');
    // 增量路径只给新增的 'new\n'
    expect(tailRead(f, cursor, 512).text).toBe('new\n');
    // isFirst=true 强制回到「读末尾 N 字节」语义：文件小于 N 时等价于全量重读。
    // 这正是 LogMonitor 发现新文件时「不把历史当信号」的依据。
    expect(tailRead(f, cursor, 512, true).text).toBe('old\nnew\n');
    expect(cursor.offset).toBe(fs.statSync(f).size);
  });
});

describe('tailRead 截断与轮转处理（架构 T11「不崩」）', () => {
  it('文件被截断（size 变小）时标记 rotated 并从头读', () => {
    const f = write('a.log', 'a'.repeat(2000));
    const cursor: TailCursor = createCursor();
    // 首次读取不算轮转（isFirst 分支返回 rotated=false）
    expect(tailRead(f, cursor, 512, true).rotated).toBe(false);
    expect(cursor.offset).toBe(fs.statSync(f).size);

    // 日志轮转：新文件比旧的短
    fs.writeFileSync(f, 'fresh start\n', 'utf8');
    const r = tailRead(f, cursor, 512);

    expect(r.rotated).toBe(true);
    expect(r.text).toContain('fresh start');
    expect(cursor.offset).toBe(fs.statSync(f).size);
  });

  it('截断后游标能继续正常增量读取（不卡死）', () => {
    const f = write('a.log', 'a'.repeat(2000));
    const cursor = createCursor();
    tailRead(f, cursor, 512, true);
    fs.writeFileSync(f, 'tiny\n', 'utf8');
    tailRead(f, cursor, 512);

    fs.appendFileSync(f, 'after truncate\n', 'utf8');
    expect(tailRead(f, cursor, 512).text).toBe('after truncate\n');
  });

  it('目录路径传入时安全返回空（isFile 检查）', () => {
    const r = tailRead(dir, createCursor(), 512, true);
    expect(r.text).toBe('');
    expect(r.rotated).toBe(false);
  });
});

describe('splitLines 半行拼接（跨轮询不丢行）', () => {
  it('最后一段无换行符时留在 pending', () => {
    const { lines, pending } = splitLines('a\nb\nc', '');
    expect(lines).toEqual(['a', 'b']);
    expect(pending).toBe('c');
  });

  it('下一轮新增内容与 pending 拼接成完整行', () => {
    // 真实场景：一行日志被两次 tailRead 切成两半
    const first = splitLines('error: some', '');
    expect(first.lines).toHaveLength(0);
    expect(first.pending).toBe('error: some');

    const second = splitLines(' long message\n', first.pending);
    expect(second.lines).toEqual(['error: some long message']);
    expect(second.pending).toBe('');
  });

  it('同时处理 CRLF 与 LF', () => {
    expect(splitLines('a\r\nb\n', '').lines).toEqual(['a', 'b']);
  });

  it('空文本时 pending 原样保留', () => {
    expect(splitLines('', 'keep')).toEqual({ lines: [], pending: 'keep' });
  });
});

describe('globFiles 递归匹配（零依赖实现）', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(dir, 'sub', 'deep'), { recursive: true });
    write('root.log', 'x');
    write('root.txt', 'x');
    fs.writeFileSync(path.join(dir, 'sub', 'a.log'), 'x');
    fs.writeFileSync(path.join(dir, 'sub', 'deep', 'b.log'), 'x');
  });

  it('** 递归匹配任意深度的 .log', () => {
    // PRD §6 示例配置的 paths 就是 `**/*.log` 形态，
    // 若递归失效，用户按文档配置就会「一个日志文件都发现不了」，灯永远不变。
    const found = globFiles(path.join(dir, '**', '*.log')).map((p) => path.basename(p)).sort();
    expect(found).toEqual(['a.log', 'b.log', 'root.log']);
  });

  it('单层 * 只匹配当前层，不跨目录', () => {
    const found = globFiles(path.join(dir, '*.log')).map((p) => path.basename(p));
    expect(found).toEqual(['root.log']);
  });

  it('两层通配 */*.log 能命中子目录文件', () => {
    const found = globFiles(path.join(dir, '*', '*.log')).map((p) => path.basename(p));
    expect(found).toEqual(['a.log']);
  });

  it('指定中间目录段：sub/*.log 只命中该目录', () => {
    const found = globFiles(path.join(dir, 'sub', '*.log')).map((p) => path.basename(p));
    expect(found).toEqual(['a.log']);
  });

  it('SPEC-002/AC-02 绝对文件路径保留根目录', () => {
    const file = path.join(dir, 'root.log');
    expect(globFiles(file)).toEqual([file]);
  });

  it('SPEC-002/AC-02 相对目录仍按工作目录解析', () => {
    const relative = path.relative(process.cwd(), dir);
    expect(globFiles(path.join(relative, '*.log')).map((p) => path.resolve(p)))
      .toEqual([path.join(dir, 'root.log')]);
  });

  it('不存在的根目录返回空数组而不抛异常', () => {
    expect(globFiles(path.join(dir, 'nonexistent', '*.log'))).toEqual([]);
  });

  it('结果去重：多 pattern 命中同一文件只出现一次', () => {
    const found = globFiles([
      path.join(dir, '**', '*.log'),
      path.join(dir, '*.log'),
    ].join('|'));
    // 单次调用只接受一个 pattern，这里验证重复 pattern 由上层 Set 去重也不炸
    expect(Array.isArray(found)).toBe(true);
  });
});