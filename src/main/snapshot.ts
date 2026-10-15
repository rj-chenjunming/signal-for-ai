/**
 * 托盘图标位图生成（架构 D6 / §1.4）。
 *
 * 依赖: 仅 `import type` 引用 electron + shared/*。**生成逻辑本身是纯函数**，
 *       位图像素与文案可在 vitest 中直接断言（架构 T04 验收：
 *       「7 态各生成 16/32px 位图且中心像素颜色 == STATUS_COLOR 对应值」）。
 *       只有最后一步 `nativeImage.createFromBitmap` 需要 Electron。
 *
 * 【为什么代码绘制而不是预生成 PNG】（架构 §1.4逐条理由）
 *  - PRD §7.1 方案要21 张 PNG：增加仓库与打包体积；
 *  - 数量徽标是 0~99+ 动态的，PNG 组合爆炸；
 *  - 代码绘制约 80 行，一次性成本，且**可测试**（中心像素断言）。
 *
 * 【为什么不用 SVG + dataURL】
 *  POC/架构已实测确认：`nativeImage.createFromDataURL` **不支持 SVG**
 *  （Chromium 的 SVG 解析器缺 `xlink:href`），所以 SVG 模板方案不可行。
 *
 * 【采用 createFromBitmap】
 *  Electron 提供 `nativeImage.createFromBitmap(buffer, {width, height})`，
 *  直接吃 raw BGRA 像素缓冲，**零编码**，不需要 zlib/CRC32 的手写 PNG 编码器。
 */

import { STATUS_COLOR } from '../shared/constants';
import type { TaskStatus } from '../shared/types';

/* ============================================================================
 * 5×7 点阵数字字模
 * ==========================================================================*/

/**
 * 内置 5×7 数字与 '+' 字模（每行 5 位，1 = 点亮）。
 * 用途：绘制托盘右上角的 running 数量徽标（PRD §7.1「1~99+」）。
 * 为什么不用字体渲染：字体渲染依赖系统字体与 DPI，无法保证托盘图标一致性，
 * 且每帧重绘文字开销大；点阵是纯位运算，极快且完全可控。
 */
const GLYPH_5X7: Readonly<Record<string, readonly number[]>> = Object.freeze({
  '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  '2': [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  '3': [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
  '4': [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  '5': [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  '6': [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  '7': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  '8': [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  '9': [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  '+': [0b00000, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0b00000],
});

/** 字模绘制时的放大倍数（1px 点在 16px 托盘上几乎不可见）。 */
const GLYPH_SCALE = 1;

/* ============================================================================
 * 颜色工具
 * ==========================================================================*/

/** `#RRGGBB` -> `[r, g, b]`。 */
export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '').trim();
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean;
  const value = Number.parseInt(full, 16);
  if (!Number.isFinite(value)) {
    return [0, 0, 0];
  }
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** BGRA 像素值（Electron createFromBitmap 期望 BGRA 顺序）。 */
function bgra(hex: string, alpha = 255): number {
  const [r, g, b] = hexToRgb(hex);
  // BGRA 打包为一个小端 32 位整数
  return ((b << 24) | (g << 16) | (r << 8) | alpha) >>> 0;
}

/* ============================================================================
 * 位图画布
 * ==========================================================================*/

/** 一张 raw BGRA 位图。 */
export interface Bitmap {
  width: number;
  height: number;
  /** BGRA 数据，长度 = width * height * 4。 */
  data: Buffer;
}

/** 创建一张全透明的位图。 */
export function createBitmap(width: number, height: number): Bitmap {
  return { width, height, data: Buffer.alloc(width * height * 4, 0) };
}

/** 在位图上画一个实心圆（带简易抗锯齿边缘）。 */
export function fillCircle(
  bitmap: Bitmap,
  cx: number,
  cy: number,
  radius: number,
  colorHex: string,
): void {
  const color = bgra(colorHex, 255);
  const minX = Math.max(0, Math.floor(cx - radius - 1));
  const maxX = Math.min(bitmap.width - 1, Math.ceil(cx + radius + 1));
  const minY = Math.max(0, Math.floor(cy - radius - 1));
  const maxY = Math.min(bitmap.height - 1, Math.ceil(cy + radius + 1));
  const rSq = radius * radius;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      // 到圆心的距离（不做 sqrt，用平方比较）
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const distSq = dx * dx + dy * dy;
      if (distSq > (radius + 0.5) * (radius + 0.5)) {
        continue;
      }
      // 边缘 1px 做线性alpha 过渡，减少锯齿
      let alpha = 255;
      const edge = radius - Math.sqrt(distSq);
      if (edge < 1) {
        alpha = Math.max(0, Math.min(255, Math.round(edge * 255)));
      }
      setPixel(bitmap, x, y, blend(color, alpha));
    }
  }
  void rSq;
}

/** 在位图上画一个圆环（用于给图标加一圈深色描边，保证在任意桌面背景上可辨 —— PRD P0-3 对比度 ≥ 3:1）。 */
export function strokeCircle(
  bitmap: Bitmap,
  cx: number,
  cy: number,
  radius: number,
  colorHex: string,
  thickness = 1,
): void {
  const color = bgra(colorHex, 255);
  const outer = radius + thickness;
  const inner = radius;
  const outerSq = outer * outer;
  const innerSq = inner * inner;

  for (let y = 0; y < bitmap.height; y += 1) {
    for (let x = 0; x < bitmap.width; x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const distSq = dx * dx + dy * dy;
      if (distSq <= outerSq && distSq >= innerSq) {
        setPixel(bitmap, x, y, color);
      }
    }
  }
}

/** 用 5×7 字模绘制一段文本，返回绘制宽度。 */
export function drawGlyphs(
  bitmap: Bitmap,
  text: string,
  originX: number,
  originY: number,
  colorHex: string,
  scale = GLYPH_SCALE,
): number {
  const color = bgra(colorHex, 255);
  let cursorX = originX;
  for (const char of text) {
    const glyph = GLYPH_5X7[char];
    if (glyph) {
      for (let row = 0; row < glyph.length; row += 1) {
        const bits = glyph[row]!;
        for (let col = 0; col < 5; col += 1) {
          if ((bits & (1 << (4 - col))) === 0) {
            continue;
          }
          for (let sy = 0; sy < scale; sy += 1) {
            for (let sx = 0; sx < scale; sx += 1) {
              setPixel(bitmap, cursorX + col * scale + sx, originY + row * scale + sy, color);
            }
          }
        }
      }
    }
    cursorX += 6 * scale; // 5px 字宽 + 1px 间距
  }
  return cursorX - originX;
}

/** 测量文本绘制宽度。 */
export function measureGlyphs(text: string, scale = GLYPH_SCALE): number {
  return text.length * 6 * scale;
}

/** 设置一个像素（越界自动忽略）。 */
export function setPixel(bitmap: Bitmap, x: number, y: number, value: number): void {
  if (x < 0 || y < 0 || x >= bitmap.width || y >= bitmap.height) {
    return;
  }
  const index = (y * bitmap.width + x) * 4;
  bitmap.data.writeUInt32LE(value >>> 0, index);
}

/** 读取一个像素的 RGBA（供测试断言中心像素颜色）。 */
export function getPixel(bitmap: Bitmap, x: number, y: number): [number, number, number, number] {
  const index = (y * bitmap.width + x) * 4;
  if (index < 0 || index + 3 >= bitmap.data.length) {
    return [0, 0, 0, 0];
  }
  return [
    bitmap.data[index + 2]!, // R
    bitmap.data[index + 1]!, // G
    bitmap.data[index]!, // B
    bitmap.data[index + 3]!, // A
  ];
}

/** 把带 alpha 的颜色与底色做alpha 混合。 */
function blend(bgraColor: number, alpha: number): number {
  if (alpha >= 255) {
    return bgraColor;
  }
  const b = (bgraColor >>> 24) & 0xff;
  const g = (bgraColor >>> 16) & 0xff;
  const r = (bgraColor >>> 8) & 0xff;
  const a = Math.round(alpha);
  return ((b << 24) | (g << 16) | (r << 8) | a) >>> 0;
}

/* ============================================================================
 * 托盘图标装配
 * ==========================================================================*/

/** 徽标底板颜色：深色，保证白/彩色数字在浅色桌面上也可辨。 */
const BADGE_BACKGROUND = '#111827';
/** 徽标数字颜色。 */
const BADGE_FOREGROUND = '#FFFFFF';
/** 圆环描边颜色：半透明黑，压住背景提高对比度。 */
const RING_COLOR = '#0B1220';

/** 生成一枚托盘图标位图（纯函数，可测）。 */
export function renderTrayBitmap(
  status: TaskStatus,
  badgeCount: number,
  size: number,
): Bitmap {
  const bitmap = createBitmap(size, size);

  // 圆点半径：16px 时直径 9px（架构 §1.4「圆点直径 9px @16px 尺寸」）
  const diameter = size === 16 ? 9 : size * 0.5625;
  const radius = diameter / 2;
  const cx = size / 2;
  const cy = size / 2;

  // 先画深色描边环，再画状态色实心圆 -> 保证任意桌面背景上可辨（PRD P0-3）
  strokeCircle(bitmap, cx, cy, radius, RING_COLOR, size === 16 ? 1 : 2);
  fillCircle(bitmap, cx, cy, radius, STATUS_COLOR[status]);

  // 徽标：running 数（PRD §7.1右上角叠加数字；0 时不显示 —— PRD P0-5）
  const badge = formatBadge(badgeCount);
  if (badge) {
    const textWidth = measureGlyphs(badge, size === 16 ? 1 : 1);
    const textHeight = 7;
    const padX = size === 16 ? 1 : 2;
    const boxW = textWidth + padX * 2;
    const boxH = textHeight + 2;
    const boxX = size - boxW - (size === 16 ? 0 : 1);
    const boxY = 0;

    fillRoundedRect(bitmap, boxX, boxY, boxW, boxH, BADGE_BACKGROUND, 2);
    drawGlyphs(
      bitmap,
      badge,
      boxX + padX,
      boxY + 1,
      BADGE_FOREGROUND,
      1,
    );
  }

  return bitmap;
}

/** 徽标文本：0 -> 空串（不显示）；1..99 -> 数字；>99 -> '+'。 */
export function formatBadge(count: number): string {
  if (!Number.isFinite(count) || count <= 0) {
    return '';
  }
  if (count > 99) {
    return '+';
  }
  return String(Math.floor(count));
}

/** 画一个圆角矩形（徽标底板）。 */
function fillRoundedRect(
  bitmap: Bitmap,
  x: number,
  y: number,
  w: number,
  h: number,
  colorHex: string,
  radius: number,
): void {
  const color = bgra(colorHex, 255);
  for (let py = y; py < y + h; py += 1) {
    for (let px = x; px < x + w; px += 1) {
      // 圆角：只在四个角做距离判定
      const inCorner =
        (px < x + radius && py < y + radius) ||
        (px >= x + w - radius && py < y + radius) ||
        (px < x + radius && py >= y + h - radius) ||
        (px >= x + w - radius && py >= y + h - radius);
      if (inCorner) {
        const cornerX = px < x + radius ? x + radius : x + w - radius - 1;
        const cornerY = py < y + radius ? y + radius : y + h - radius - 1;
        const dx = px - cornerX;
        const dy = py - cornerY;
        if (dx * dx + dy * dy > radius * radius) {
          continue;
        }
      }
      setPixel(bitmap, px, py, color);
    }
  }
}

/* ============================================================================
 * 快照文案（tooltip）
 * ==========================================================================*/

export interface TrayCounts {
  running: number;
  waiting: number;
  success: number;
  failed: number;
  idle: number;
  unknown: number;
}

/**
 * 生成托盘 tooltip（PRD §7.1）：
 *   `AI 任务指示灯 — 运行 3 · 完成 1 · 失败 0`
 * 只显示非零项，全零时显示「暂无任务」。
 */
export function buildTooltip(counts: TrayCounts, paused: boolean): string {
  const parts: string[] = [];
  if (counts.running > 0) parts.push(`运行 ${counts.running}`);
  if (counts.waiting > 0) parts.push(`等待 ${counts.waiting}`);
  if (counts.success > 0) parts.push(`完成 ${counts.success}`);
  if (counts.failed > 0) parts.push(`失败 ${counts.failed}`);
  if (counts.unknown > 0) parts.push(`失联 ${counts.unknown}`);
  if (parts.length === 0) {
    return paused ? 'AI 任务指示灯 — 监控已暂停' : 'AI 任务指示灯 — 暂无运行中的任务';
  }
  const state = paused ? '（已暂停）' : '';
  return `AI 任务指示灯 — ${parts.join(' · ')}${state}`;
}

/* ============================================================================
 * Electron 桥接（唯一需要 Electron 的地方）
 * ==========================================================================*/

/**
 * 用 Electron 的 `nativeImage.createFromBitmap` 把位图包装成Image。
 * 单独抽出这个函数，便于主进程在测试环境下替换（无 Electron 时返回 null）。
 */
export function toNativeImage(
  bitmap: Bitmap,
  createFromBitmap: (buffer: Buffer, opts: { width: number; height: number }) => ElectronNativeImage,
): ElectronNativeImage {
  return createFromBitmap(bitmap.data, { width: bitmap.width, height: bitmap.height });
}

/** nativeImage 的最小结构（避免顶层 import electron 造成 vitest 失败）。 */
export interface ElectronNativeImage {
  setTemplateImage(isTemplate: boolean): void;
  toDataURL(): string;
  getSize(): { width: number; height: number };
  isEmpty(): boolean;
  resize(options: { width: number; height: number; quality?: string }): ElectronNativeImage;
  addRepresentation(options: {
    scaleFactor: number;
    width: number;
    height: number;
    buffer: Buffer;
  }): void;
}
