/**
 * 悬浮灯画布尺寸测试。
 *
 * ============================================================================
 * 【这个文件锁住的是一个真实发生过的 bug】
 * ============================================================================
 * 用户反馈「圆圈没有显示完整」。
 * 根因：画布高度算成 88px，而 CSS 里灯带实际内容是 93px ——
 * 上下各被裁 2px，总灯和最后一行的圆点被窗口边缘切掉。
 *
 * 所以这里最关键的一条断言是：**画布必须能容纳 CSS 内容**。
 * 它靠读取真实的 `shared.css` 来交叉验证常量，而不是自己写死一份数字
 * （那样两边一起错就测不出来了）。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  compactCanvasSize,
  resolveCanvasSize,
  resolveDock,
  screenEdgesFor,
  stripCanvasHeight,
  stripCanvasWidth,
  stripContentHeight,
  COMPACT_DOT,
  COMPACT_GAP,
  COMPACT_MASTER,
  COMPACT_PAD,
  COMPACT_SHADOW_PAD,
  DOCK_THRESHOLD,
  SINGLE_LAMP_EXTRA,
  STRIP_CONTENT_WIDTH,
  STRIP_GAP,
  STRIP_MASTER_HEIGHT,
  STRIP_PAD_X,
  STRIP_PAD_Y,
  STRIP_ROW_HEIGHT,
  STRIP_ROW_STEP,
  STRIP_ROWS_PAD_X,
  STRIP_ROWS_PAD_Y,
  STRIP_SHADOW_PAD_X,
  STRIP_SHADOW_PAD_Y,
} from '../src/main/overlay-layout';

/**
 * 去掉 CSS 注释后的正文。
 *
 * ⚠️ 必须先去掉注释再解析：注释里出现的 `}` 会让"截到第一个 }"的朴素解析器
 * 提前截断，导致属性读不到、误判成"常量与 CSS 不一致"。
 * 这个坑真实踩过 —— `.strip-rows` 加了说明注释后，padding 就读不出来了。
 */
const CSS = readFileSync(join(process.cwd(), 'src', 'renderer', 'shared.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//gu,
  '',
);

/**
 * 从 CSS 里取某个选择器块。必须锚定**行首**：否则 `.strip-dot {` 会先命中
 * `.strip-row:hover .strip-dot {` 这条后代选择器。
 */
function cssBlock(selector: string): string | undefined {
  const re = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*\\{`, 'mu');
  const m = re.exec(CSS);
  if (m === null) return undefined;
  const start = m.index;
  return CSS.slice(start, CSS.indexOf('}', start));
}

/** 取某个选择器块中某个属性的 px 值。 */
function cssPx(selector: string, prop: string): number | undefined {
  const block = cssBlock(selector);
  if (block === undefined) return undefined;
  const m = new RegExp(`(?:^|[\\s;])${prop}\\s*:\\s*([0-9.]+)px`, 'mu').exec(block);
  return m ? Number(m[1]) : undefined;
}

/**
 * 取 `body.dock-*` 那段**多选择器**规则块。
 *
 * `cssBlock` 要求选择器紧跟 `{`，而停靠规则的选择器跨了三行，所以这里单独解析。
 */
function dockRuleBlock(selectorSuffix: string): string {
  const esc = selectorSuffix.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const re = new RegExp(`^body\\.dock-left ${esc},[\\s\\S]*?\\{([^}]*)\\}`, 'mu');
  return re.exec(CSS)?.[1] ?? '';
}

describe('交叉校验：TS 常量必须与 shared.css 一致', () => {
  it('STRIP_PAD_Y 与 .lamp-strip 的上下 padding 一致', () => {
    // .lamp-strip 的 padding 是 "6px 8px"（上下 6 / 左右 8）
    const block = cssBlock('.lamp-strip');
    expect(block).toBeDefined();
    const m = /padding:\s*([0-9.]+)px\s+([0-9.]+)px/u.exec(block ?? '');
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBe(STRIP_PAD_Y);
    expect(Number(m?.[2])).toBe(STRIP_PAD_X);
  });

  it('STRIP_ROW_HEIGHT 与 .strip-dot 的 height 一致', () => {
    expect(cssPx('.strip-dot', 'height')).toBe(STRIP_ROW_HEIGHT);
  });

  it('STRIP_ROW_STEP 覆盖小灯高度 + 行间距', () => {
    // 每行有效步进必须 > 灯直径（否则行会叠在一起）
    expect(STRIP_ROW_STEP).toBeGreaterThan(STRIP_ROW_HEIGHT);
  });

  it('STRIP_ROWS_PAD_Y 与 .strip-rows 的上下 padding 一致', () => {
    // .strip-rows 是 overflow 容器，padding 决定了它的裁剪边离圆点多远。
    const block = cssBlock('.strip-rows');
    expect(block).toBeDefined();
    // 现在用的是单值简写 `padding: 6px`（四个方向都要）
    const m = /padding:\s*([0-9.]+)px\s*;/u.exec(block ?? '');
    const twoVal = /padding:\s*([0-9.]+)px\s+([0-9.]+)(?:px)?/u.exec(block ?? '');
    if (m !== null) {
      expect(Number(m[1])).toBe(STRIP_ROWS_PAD_Y);
    } else {
      expect(twoVal).not.toBeNull();
      expect(Number(twoVal?.[1])).toBe(STRIP_ROWS_PAD_Y);
      expect(Number(twoVal?.[2])).toBe(STRIP_ROWS_PAD_X);
    }
    expect(/overflow-y:\s*(auto|scroll)/u.test(block ?? '')).toBe(true);
  });

  it('★ .strip-rows 的水平内边距必须 > 0（否则圆点左侧光晕被裁）', () => {
    // 用户报的"下面圆点左侧被割掉"根因：容器只有垂直 padding，
    // 圆点紧贴裁剪边（距左 = 0），而阴影向左外扩 4px -> 被切。
    // 这里锁死"水平也要留"。
    const block = cssBlock('.strip-rows');
    const single = /padding:\s*([0-9.]+)px\s*;/u.exec(block ?? '');
    const twoVal = /padding:\s*([0-9.]+)px\s+([0-9.]+)(?:px)?/u.exec(block ?? '');
    const padX = single !== null ? Number(single[1]) : Number(twoVal?.[2] ?? -1);
    // 必须 >= 阴影向左扩散的距离，否则左侧一定被裁
    const SHADOW_SIDE = 1 + 4;
    expect(STRIP_ROWS_PAD_X).toBeGreaterThanOrEqual(SHADOW_SIDE);
    expect(padX).toBe(STRIP_ROWS_PAD_X);
  });

  it('★ 画布宽度必须把 .strip-rows 的水平内边距算进去', () => {
    // 漏算会导致：容器 padding 变宽 -> 内容变宽 -> 溢出灯带 -> 被灯带裁
    const w = stripCanvasWidth();
    const needed =
      STRIP_CONTENT_WIDTH + STRIP_ROWS_PAD_X * 2 + STRIP_PAD_X * 2 + STRIP_SHADOW_PAD_X * 2;
    expect(w).toBe(needed);
    expect(w).toBeGreaterThan(STRIP_CONTENT_WIDTH + STRIP_ROWS_PAD_X * 2 + STRIP_PAD_X * 2);
  });

  it('STRIP_MASTER_HEIGHT 覆盖总灯圆点 + 分隔线', () => {
    const dot = cssPx('.strip-master-dot', 'width') ?? cssPx('.strip-master-dot', 'height');
    expect(dot).toBe(16);
    // 23（实测反推）= 16 圆点 + 5 padding-bottom + 1 分隔线 + 1 余量
    expect(STRIP_MASTER_HEIGHT).toBeGreaterThanOrEqual(16 + 1);
  });

  it('STRIP_CONTENT_WIDTH 足够放下小灯 + 间距 + 最长端口标签', () => {
    const dot = cssPx('.strip-dot', 'width') ?? 14;
    // .strip-port 的 max-width 是标签上限
    const maxLabel = cssPx('.strip-port', 'max-width') ?? 0;
    expect(maxLabel).toBeGreaterThan(0);
    // 内容宽度必须 >= 小灯 + gap(6) + 标签上限
    expect(STRIP_CONTENT_WIDTH).toBeGreaterThanOrEqual(dot + 6 + maxLabel);
  });
});

describe('★ 回归：画布必须能容纳 CSS 内容（"圆圈显示不完整"的根因）', () => {
  it('画布高度 >= 内容 + 垂直留白', () => {
    for (const rows of [2, 3, 4, 5, 8]) {
      expect(stripCanvasHeight(rows)).toBeGreaterThanOrEqual(
        stripContentHeight(rows) + STRIP_SHADOW_PAD_Y * 2,
      );
    }
  });

  it('★ 复现历史 bug 的具体数字（实测 ground truth）', () => {
    // 用 CDP 量真实 DOM 得到的实测值（3 行灯带，未含 .strip-rows 内边距时）：
    //   灯带自然尺寸 118.48 x 93
    // 历史 bug：窗口只有 88x85，比 93 矮 -> 上下各裁 3.5px -> 圆点被切边。
    const MEASURED_CONTENT_H = 93;
    const MEASURED_CONTENT_W = 118.48;

    const h = stripCanvasHeight(3);
    const w = stripCanvasWidth();

    expect(h).toBeGreaterThanOrEqual(MEASURED_CONTENT_H + STRIP_SHADOW_PAD_Y * 2);
    expect(w).toBeGreaterThanOrEqual(Math.ceil(MEASURED_CONTENT_W) + STRIP_SHADOW_PAD_X * 2);
  });

  it('★ 内容高度公式与实测吻合（已计入 .strip-rows 内边距）', () => {
    // 这条锁的是常量：它们是从实测反推的，若有人"顺手改成理论值"这里会红。
    // 93（实测灯带高，行区无 padding）+ 12（后加的 .strip-rows 上下 padding）
    const expected = 93 + STRIP_ROWS_PAD_Y * 2;
    expect(Math.abs(stripContentHeight(3) - expected)).toBeLessThanOrEqual(1);
  });

  it('★ 垂直留白必须大于「投影向下扩散的距离」', () => {
    // "下面圆形显示不完整"的根因：窗口只留 2px，而投影向下 5px（1px 位移 + 4px 模糊）。
    // 1px 描边 + 0 1px 4px 投影 -> 向下约 5px
    const SHADOW_DOWN = 1 + 4;
    expect(STRIP_SHADOW_PAD_Y).toBeGreaterThan(SHADOW_DOWN);
    // 且留白不能全被"安全余量"占掉，必须真的比投影大
    expect(stripCanvasHeight(3) - stripContentHeight(3)).toBeGreaterThanOrEqual(SHADOW_DOWN * 2);
  });

  it('每一行灯都完整落在画布内（自下而上逐行校验）', () => {
    const rows = 3;
    const canvasH = stripCanvasHeight(rows);
    let y = STRIP_SHADOW_PAD_Y + STRIP_PAD_Y;
    y += STRIP_MASTER_HEIGHT + 6; // 总灯区 + gap
    for (let i = 0; i < rows; i += 1) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y + STRIP_ROW_HEIGHT).toBeLessThanOrEqual(canvasH);
      y += STRIP_ROW_STEP;
    }
  });

  it('留白足以容纳小灯的描边与投影（否则圆点边缘会被裁）', () => {
    // box-shadow: 0 0 0 1px（向外 1px）+ 0 1px 4px（向下约 5px）
    expect(STRIP_SHADOW_PAD_Y).toBeGreaterThanOrEqual(5);
    expect(STRIP_SHADOW_PAD_X).toBeGreaterThanOrEqual(1);
  });
});

describe('resolveCanvasSize —— 单灯与灯带两种形态', () => {
  it('任务数 < 2 时退回单灯（正方形）', () => {
    expect(resolveCanvasSize(28, 1, 900)).toEqual({ width: 52, height: 52 });
    expect(resolveCanvasSize(28, 0, 900)).toEqual({ width: 52, height: 52 });
  });

  it('单灯尺寸随 lamp.size 变化', () => {
    expect(resolveCanvasSize(40, 1, 900)).toEqual({ width: 40 + SINGLE_LAMP_EXTRA, height: 40 + SINGLE_LAMP_EXTRA });
  });

  it('lamp.size 过小时按 16 兜底（防算出 0 宽窗口）', () => {
    const { width } = resolveCanvasSize(0, 1, 900);
    expect(width).toBe(16 + SINGLE_LAMP_EXTRA);
  });

  it('任务数 >= 2 时是灯带（竖排，宽度固定）', () => {
    const two = resolveCanvasSize(28, 2, 900);
    const five = resolveCanvasSize(28, 5, 900);
    expect(two.width).toBe(stripCanvasWidth());
    expect(five.width).toBe(two.width); // 宽度不随行数变化
    expect(five.height).toBeGreaterThan(two.height); // 高度随行数增长
  });

  it('灯带形态忽略 lamp.size（那是单灯的直径）', () => {
    expect(resolveCanvasSize(28, 3, 900)).toEqual(resolveCanvasSize(64, 3, 900));
  });

  it('高度受上限约束（端口很多时不撑出屏幕）', () => {
    const capped = resolveCanvasSize(28, 100, 300);
    expect(capped.height).toBe(300);
  });

  it('灯带宽度是窄条（不该把编辑器盖掉一大块）', () => {
    const { width } = resolveCanvasSize(28, 3, 900);
    expect(width).toBeLessThan(180);
    expect(width).toBeGreaterThanOrEqual(100);
  });
});

/* ============================================================================
 * 边缘停靠（拖到侧边/顶部 -> 点阵形态）
 * ==========================================================================*/

describe('resolveDock —— 贴边判定（纯函数）', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const size = { width: 164, height: 117 };

  it('贴左边 -> left（含阈值内的近似贴边）', () => {
    expect(resolveDock({ x: 0, y: 400, ...size }, workArea)).toBe('left');
    expect(resolveDock({ x: 10, y: 400, ...size }, workArea)).toBe('left');
  });

  it('贴右边 -> right', () => {
    expect(resolveDock({ x: 1920 - 164, y: 400, ...size }, workArea)).toBe('right');
    expect(resolveDock({ x: 1920 - 164 - 12, y: 400, ...size }, workArea)).toBe('right');
  });

  it('贴顶部 -> top', () => {
    expect(resolveDock({ x: 800, y: 0, ...size }, workArea)).toBe('top');
    expect(resolveDock({ x: 800, y: 18, ...size }, workArea)).toBe('top');
  });

  it('离开边缘 -> none', () => {
    expect(resolveDock({ x: 800, y: 500, ...size }, workArea)).toBe('none');
    expect(resolveDock({ x: DOCK_THRESHOLD + 1, y: 500, ...size }, workArea)).toBe('none');
  });

  it('阈值边界：等于阈值算贴边，超出 1px 就不算', () => {
    expect(resolveDock({ x: DOCK_THRESHOLD, y: 500, ...size }, workArea)).toBe('left');
    expect(resolveDock({ x: DOCK_THRESHOLD + 1, y: 500, ...size }, workArea)).toBe('none');
  });

  it('★ 左上角并列时顶部优先（横排更自然）', () => {
    expect(resolveDock({ x: 0, y: 0, ...size }, workArea)).toBe('top');
  });

  it('贴底部不改变形态（用户只要侧边与顶部）', () => {
    expect(resolveDock({ x: 800, y: 1080 - 117, ...size }, workArea)).toBe('none');
  });

  it('★ 在屏幕边上继续外推（窗口探出屏幕）**仍然**算贴边', () => {
    // 用户实测报上来的 bug：「顶层可以，左右侧不行」。
    // 根因：拖到左右边缘时鼠标被屏幕边挡住，窗口必然探出去一点 ——
    // 他的灯实测停在 x=3702，而屏幕 3840、窗口 164，右边缘本该 3676，探出 26px。
    // 第一版把"距离为负"一律判成不贴边，于是左右侧全失效
    // （顶部只是因为他没探出屏幕才侥幸能用）。
    const screen = { x: 0, y: 0, width: 3840, height: 1040 };
    const allEdges = { top: true, left: true, right: true };
    expect(resolveDock({ x: 3702, y: 62, ...size }, screen, allEdges)).toBe('right');
    expect(resolveDock({ x: -26, y: 400, ...size }, screen, allEdges)).toBe('left');
    expect(resolveDock({ x: 800, y: -26, ...size }, screen, allEdges)).toBe('top');
  });

  it('★ 跨屏摆放（探出的是屏内交界）不算贴边', () => {
    // 灯在 x=1768、宽 164 -> 右边缘 1932，越过主屏右边界 1920 探进隔壁屏 12px。
    // 此时主屏右边缘**不是**屏幕边（外面还有副屏），所以不算贴边。
    const straddling = { x: 1768, y: 169, width: 164, height: 135 };
    const d1IsNotRightmost = { top: true, left: true, right: false };
    expect(resolveDock(straddling, workArea, d1IsNotRightmost)).toBe('none');
    // 同样是"探出"，但边外没有别的屏（真屏幕边）就该贴 —— 区别只在这一点
    expect(resolveDock(straddling, workArea, { top: true, left: true, right: true })).toBe('right');
  });

  it('工作区有偏移（任务栏/多屏负坐标）时按相对距离判定', () => {
    const shifted = { x: -1920, y: 40, width: 1920, height: 1040 };
    expect(resolveDock({ x: -1920, y: 200, ...size }, shifted)).toBe('left');
    expect(resolveDock({ x: -164, y: 200, ...size }, shifted)).toBe('right');
    expect(resolveDock({ x: -1000, y: 40, ...size }, shifted)).toBe('top');
  });
});

describe('screenEdgesFor —— 分辨"真屏幕边"与"屏内交界"', () => {
  const displays = [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 1920, y: 0, width: 1920, height: 1080 },
  ];
  const d1 = { x: 0, y: 0, width: 1920, height: 1040 };
  const d2 = { x: 1920, y: 0, width: 1920, height: 1040 };

  it('主屏：右边是屏内交界（外面还有副屏），左/上是真屏幕边', () => {
    expect(screenEdgesFor(d1, displays, { x: 900, y: 500 })).toEqual({
      top: true,
      left: true,
      right: false,
    });
  });

  it('副屏：左边是屏内交界，右/上是真屏幕边', () => {
    expect(screenEdgesFor(d2, displays, { x: 2800, y: 500 })).toEqual({
      top: true,
      left: false,
      right: true,
    });
  });

  it('单屏时三条边都是屏幕边', () => {
    expect(screenEdgesFor(d1, [displays[0]], { x: 900, y: 500 })).toEqual({
      top: true,
      left: true,
      right: true,
    });
  });
});

describe('compactCanvasSize —— 点阵形态尺寸', () => {
  it('顶部停靠是横排（宽 > 高）；左右停靠是竖排（高 > 宽）且两则同形', () => {
    const top = compactCanvasSize(3, 'top');
    expect(top.width).toBeGreaterThan(top.height);

    const left = compactCanvasSize(3, 'left');
    expect(left.height).toBeGreaterThan(left.width);
    expect(compactCanvasSize(3, 'right')).toEqual(left);
  });

  it('主轴随行数增长，交叉轴不变', () => {
    const two = compactCanvasSize(2, 'top');
    const five = compactCanvasSize(5, 'top');
    expect(five.width).toBeGreaterThan(two.width);
    expect(five.height).toBe(two.height);

    const twoV = compactCanvasSize(2, 'left');
    const fiveV = compactCanvasSize(5, 'left');
    expect(fiveV.height).toBeGreaterThan(twoV.height);
    expect(fiveV.width).toBe(twoV.width);
  });

  it('★ 交叉轴容得下最大的圆点 + 内边距 + 投影留白', () => {
    for (const dock of ['top', 'left', 'right'] as const) {
      const size = compactCanvasSize(3, dock);
      const cross = dock === 'top' ? size.height : size.width;
      expect(cross).toBeGreaterThanOrEqual(COMPACT_MASTER + COMPACT_PAD * 2 + COMPACT_SHADOW_PAD * 2);
    }
  });

  it('★ 主轴容得下 总灯 + 间距 + n 个圆点与它们之间的间距', () => {
    const n = 4;
    const needed =
      COMPACT_MASTER +
      STRIP_GAP +
      (n * COMPACT_DOT + (n - 1) * COMPACT_GAP) +
      COMPACT_PAD * 2 +
      COMPACT_SHADOW_PAD * 2;
    for (const dock of ['top', 'left', 'right'] as const) {
      const size = compactCanvasSize(n, dock);
      const main = dock === 'top' ? size.width : size.height;
      expect(main).toBeGreaterThanOrEqual(needed);
    }
  });

  it('点阵明比常规灯带窄得多（这正是它的意义）', () => {
    const strip = resolveCanvasSize(28, 3, 900);
    const compact = resolveCanvasSize(28, 3, 900, 'left');
    expect(compact.width).toBeLessThan(strip.width / 2);
  });

  it('resolveCanvasSize 传 dock 时走点阵；行数 < 2 仍是单灯（点阵无意义）', () => {
    expect(resolveCanvasSize(28, 3, 900, 'top')).toEqual(compactCanvasSize(3, 'top'));
    expect(resolveCanvasSize(28, 1, 900, 'top')).toEqual({ width: 52, height: 52 });
  });

  it('★ 交叉校验：COMPACT_PAD 与 dock 形态的 .lamp-strip padding 一致', () => {
    const block = dockRuleBlock('.lamp-strip');
    expect(block).not.toBe('');
    const m = /padding:\s*([0-9.]+)px/u.exec(block);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBe(COMPACT_PAD);
  });

  it('★ 交叉校验：dock 形态下 .strip-rows 的 padding 必须归零（几何才能精确预测）', () => {
    const block = dockRuleBlock('.strip-rows');
    expect(block).not.toBe('');
    expect(/padding:\s*0/u.test(block)).toBe(true);
    // 点阵不滚动：留着 overflow 裁剪边只会白白切掉投影
    expect(/overflow:\s*visible/u.test(block)).toBe(true);
  });

  it('★ 交叉校验：COMPACT_DOT / COMPACT_MASTER 与 CSS 圆点尺寸一致', () => {
    expect(cssPx('.strip-dot', 'width')).toBe(COMPACT_DOT);
    expect(cssPx('.strip-master-dot', 'width')).toBe(COMPACT_MASTER);
  });

  it('★ 点阵形态必须把文字标签与徽标藏起来（"没有那些后面的信号描述"）', () => {
    // 这条锁的是需求本身：点阵形态只留灯
    for (const cls of ['.strip-port', '.strip-master-label']) {
      const re = new RegExp(`body\\.dock-left ${cls.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u');
      expect(re.test(CSS)).toBe(true);
    }
    // 横排时整条要转向
    expect(/body\.dock-top \.lamp-strip\s*\{[^}]*flex-direction:\s*row/u.test(CSS)).toBe(true);
  });
});
