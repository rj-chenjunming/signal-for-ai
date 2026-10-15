/**
 * 进程枚举脚本的生成测试（回归防护）。
 *
 * ============================================================================
 * 【为什么需要这个文件 —— 一个真实的、非常隐蔽的 bug】
 * ============================================================================
 * `buildCimScript()` 原来用**空格**把多行拼成单行传给 `powershell -Command`：
 *
 *   `$ErrorActionPreference = "Stop" while ($true) { ... }`
 *
 * 这在 PowerShell 里是**语法错误**（赋值语句与 `while` 之间必须有语句
 * 终结符，即换行或 `;`）。后果：
 *   - 长驻枚举子进程一启动就 `exit code=1` 死掉
 *   - 监控器重启 5 次后判定「监控源失联」
 *   - 那盏灯**永远不反映真实进程** —— 用户看到的是"workbuddy 没被监控"
 *
 * 而它之所以难查，是因为退出处理只记了 `exit code=1`、**丢掉了 stderr**，
 * 日志里看不到 PowerShell 的 `UnexpectedToken: while`。
 *
 * 这个模块在此之前**完全没有测试**，所以 bug 顺利出厂。
 * 下面这几条断言就是为它设的护栏。
 */

import { describe, expect, it } from 'vitest';
import {
  buildCimScript,
  parseCimPayload,
  parseTasklistPayload,
} from '../src/main/monitors/process-enum';

describe('buildCimScript —— 生成的脚本必须是 PowerShell 能解析的', () => {
  const script = buildCimScript(2000);

  it('★ 不能把语句用空格拼在一起（那样 PowerShell 报 UnexpectedToken）', () => {
    // 这是 bug 的原貌：赋值结尾紧跟 while，中间没有语句终结符。
    // ⚠️ 用 [^\S\n]+ 而不是 \s+ —— \s 会匹配换行，那样连**正确**的
    // 换行拼接也会被误判成 bug（我第一版就写错了）。
    expect(script).not.toMatch(/"Stop"[^\S\n]+while/u);
    expect(script).not.toMatch(/"[^\S\n]+while/u);
  });

  it('★ 管道不能跨行（否则报 EmptyPipeElement）', () => {
    // 实测：`Get-CimInstance X\n  | Select-Object Y` 在 -Command 下报
    // EmptyPipeElement（"不能使用空管道元素"）——以 | 开头的续行不被当续行。
    // -EncodedCommand 也一样失败，所以必须整条管道在同一行。
    for (const line of script.split('\n')) {
      expect(line.trimStart().startsWith('|')).toBe(false);
    }
    // 该管道确实存在，且没有被换行拆开
    expect(script).toContain(
      'Get-CimInstance Win32_Process | Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress',
    );
  });

  it('★ 每条语句独占一行（换行是合法终结符）', () => {
    const lines = script.split('\n').map((l) => l.trim());
    expect(lines).toContain('$ErrorActionPreference = "Stop"');
    expect(lines).toContain('while ($true) {');
    expect(lines).toContain('}');
    // 不该有任何一行同时含两条语句的迹象（赋值 + 关键字）
    expect(script).not.toMatch(/"[^\S\n]+(while|if|foreach)/u);
  });

  it('★ 多行之间用换行分隔（换行本身就是合法的语句终结符）', () => {
    expect(script).toContain('\n');
    expect(script.split('\n').length).toBeGreaterThan(5);
  });

  it('赋值语句独占一行', () => {
    const firstLine = script.split('\n')[0];
    expect(firstLine?.trim()).toBe('$ErrorActionPreference = "Stop"');
  });

  it('包含必要的三个环节：CIM 枚举 / JSON 压缩 / 轮询间隔', () => {
    expect(script).toContain('Get-CimInstance Win32_Process');
    expect(script).toContain('ConvertTo-Json -Compress');
    expect(script).toContain('Select-Object ProcessId, Name, CommandLine');
  });

  it('长驻循环由 while ($true) 包裹，且 try/catch 在里面', () => {
    expect(script).toContain('while ($true) {');
    expect(script).toContain('try {');
    expect(script).toContain('} catch {');
  });

  it('轮询间隔被写进 Start-Sleep', () => {
    expect(script).toContain('Start-Sleep -Milliseconds 2000');
    expect(buildCimScript(5000)).toContain('Start-Sleep -Milliseconds 5000');
  });

  it('间隔过小时按 500ms 兜底（防止把 CPU 打满）', () => {
    expect(buildCimScript(0)).toContain('Start-Sleep -Milliseconds 500');
    expect(buildCimScript(100)).toContain('Start-Sleep -Milliseconds 500');
  });

  it('括号配对（不平衡的脚本必然解析失败）', () => {
    const open = (script.match(/\{/gu) ?? []).length;
    const close = (script.match(/\}/gu) ?? []).length;
    expect(open).toBe(close);
    expect(open).toBeGreaterThanOrEqual(2); // while 一个 + try 一个
  });

  it('★ 真正拿 powershell.exe 解析一遍（语法断言，不是文本匹配）', async () => {
    // 【为什么需要这条】上面那些都是文本级断言，只能防"已知的两种写法"。
    // 直接让 PowerShell 解析一次才是权威结论。
    //
    // 做法：用 -Command 传脚本，但把长驻循环换成一次性输出 ——
    // 这样进程会退出，能拿到退出码。若脚本有语法错，退出码为 1
    // 且 stderr 带 ParserError。
    //
    // 与 process.ts 同源的调用方式：-NoProfile -NonInteractive -Command
    const probeScript = script
      // 去掉长驻循环，改成只跑一轮，让进程能自己结束
      .replace('while ($true) {', 'if ($true) {')
      .replace('Start-Sleep -Milliseconds 2000', 'Write-Output "PARSE_OK"');

    const { execFile } = await import('node:child_process');
    const result = await new Promise<{ err: Error | null; stdout: string; stderr: string }>(
      (resolve) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', probeScript],
          { timeout: 20_000, windowsHide: true, encoding: 'utf8' },
          (err, stdout, stderr) => resolve({ err, stdout, stderr }),
        );
      },
    );

    // 解析失败时 PowerShell 会写 ParserError 到 stderr
    expect(String(result.stderr)).not.toMatch(/ParserError|UnexpectedToken|EmptyPipeElement/u);
    expect(result.err).toBeNull();
    expect(String(result.stdout)).toContain('PARSE_OK');
  }, 30_000);
});

describe('parseCimPayload —— 兼容数组/单对象两种形状', () => {
  it('数组（进程数 > 1）', () => {
    const json = JSON.stringify([
      { ProcessId: 1, Name: 'a.exe', CommandLine: 'a' },
      { ProcessId: 2, Name: 'b.exe', CommandLine: null },
    ]);
    const out = parseCimPayload(json);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ pid: 1, name: 'a.exe', commandLine: 'a' });
    // null 命令行要被规范成空串，避免后续匹配时到处判空
    expect(out[1]?.commandLine).toBe('');
  });

  it('单对象（进程数 = 1 时 ConvertTo-Json 会输出对象）', () => {
    const json = JSON.stringify({ ProcessId: 7, Name: 'solo.exe', CommandLine: 'x' });
    const out = parseCimPayload(json);
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe('solo.exe');
  });

  it('空/畸形输入不抛错，返回空数组（防御式）', () => {
    for (const bad of ['', '   ', 'null', '{}', 'not json', '[]']) {
      expect(() => parseCimPayload(bad)).not.toThrow();
    }
    expect(parseCimPayload('')).toEqual([]);
  });
});

describe('parseTasklistPayload —— 降级路径只拿得到进程名', () => {
  it('解析 CSV 行（多行都要解析出来）', () => {
    const csv = '"smss.exe","632","Services","0","1,084 K"\n"csrss.exe","824","Services","0","5,308 K"';
    const out = parseTasklistPayload(csv);
    expect(out).toHaveLength(2);
    expect(out[0]?.name).toBe('smss.exe');
    expect(out[0]?.pid).toBe(632);
    expect(out[1]?.name).toBe('csrss.exe');
  });

  it('★ 过滤掉 pid<=0 的伪进程（System Idle Process / System）', () => {
    // 这两条在 tasklist 里 pid 是 0，它们不是"任务进程"，
    // 留着会污染进程名单（尤其做进程名匹配时）
    const csv = '"System Idle Process","0","Services","0","8 K"\n"smss.exe","632","Services","0","1,084 K"';
    const out = parseTasklistPayload(csv);
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe('smss.exe');
  });

  it('降级路径的 commandLine 为空（因此 cmdlineContains 匹配必然失效）', () => {
    const out = parseTasklistPayload('"a.exe","1","Console","1","1 K"');
    expect(out[0]?.commandLine).toBe('');
  });

  it('空输入返回空数组', () => {
    expect(parseTasklistPayload('')).toEqual([]);
  });

  it('字段不足的畸形行被跳过而非抛错', () => {
    expect(() => parseTasklistPayload('garbage\n"onlyname"')).not.toThrow();
    expect(parseTasklistPayload('garbage\n"onlyname"')).toEqual([]);
  });
});
