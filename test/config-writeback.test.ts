/**
 * 配置写回的两道闸。
 *
 * ============================================================================
 * 【这个文件锁的是用户实测报上来的噪音】
 * ============================================================================
 * 用户原话：「可以 但是我鼠标放上去 一直会有配置已重载 或者（新增）之类的
 * 提示词 我觉得没有必要」。
 *
 * 根因是**写回自己的回声**：
 *   拖灯 -> 窗口 moved -> 写回 lamp.x/y -> 文件监听器醒来
 *        -> 判定"配置变了" -> 弹「配置已重载」
 * 日志里 25 分钟出现 34 次写回 + 37 次重载，全是应用自己造成的。
 *
 * 这里锁住两道闸：
 *   1. **内容没变就不写盘**（连备份都不做）—— 从源头掐掉无谓的写
 *   2. `isSelfWrite()` 能认出"磁盘上就是我刚写的那份" —— 供上层决定不提示
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigManager } from '../src/main/config';

/** 测试里不需要日志噪音。 */
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

const BASE = `version: 1
lamp:
  enabled: true
  x: 100
  y: 100
  size: 28
tasks: []
`;

let dir = '';
let file = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lamp-cfg-'));
  file = join(dir, 'config.yaml');
  writeFileSync(file, BASE, 'utf8');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeManager(): ConfigManager {
  const cm = new ConfigManager(file, silent, join(dir, 'missing-example.yaml'));
  cm.load();
  return cm;
}

/** 目录里除配置文件之外的产物（写前备份）。 */
function extraFiles(): string[] {
  return readdirSync(dir).filter((n) => n !== 'config.yaml');
}

describe('配置写回：内容没变就不写盘', () => {
  it('改了值 -> 真的写盘，并留下写前备份', () => {
    const cm = makeManager();
    cm.update((cfg) => {
      cfg.lamp.x = 777;
      return cfg;
    });

    expect(readFileSync(file, 'utf8')).toContain('x: 777');
    expect(extraFiles().length).toBe(1);
  });

  it('★ 值没变 -> 不写盘（mtime 与备份都不动）', () => {
    const cm = makeManager();
    // 先真写一次，让磁盘内容 == 应用的序列化结果
    cm.update((cfg) => {
      cfg.lamp.x = 777;
      return cfg;
    });
    const mtimeBefore = statSync(file).mtimeMs;
    const backupsBefore = extraFiles().length;

    // 再"写"两次同样的值 —— 模拟渲染层每次 mouseup 都上报一次位置
    cm.update((cfg) => {
      cfg.lamp.x = 777;
      return cfg;
    });
    cm.update((cfg) => cfg);

    expect(statSync(file).mtimeMs).toBe(mtimeBefore);
    expect(extraFiles().length).toBe(backupsBefore);
  });
});

describe('isSelfWrite：分辨"我自己写的"与"用户改的"', () => {
  it('刚写回之后为 true —— 这是自回声，不该弹提示', () => {
    const cm = makeManager();
    cm.update((cfg) => {
      cfg.lamp.x = 777;
      return cfg;
    });

    expect(cm.isSelfWrite()).toBe(true);
  });

  it('用户随后改了文件 -> false —— 这才该弹提示', () => {
    const cm = makeManager();
    cm.update((cfg) => {
      cfg.lamp.x = 777;
      return cfg;
    });
    // 模拟用户在编辑器里改了配置（哪怕只是加了行注释）
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n# 用户手改\n`, 'utf8');

    expect(cm.isSelfWrite()).toBe(false);
  });

  it('从未写过盘时为 false —— 不要吞掉启动后的第一次真实改动', () => {
    expect(makeManager().isSelfWrite()).toBe(false);
  });
});
