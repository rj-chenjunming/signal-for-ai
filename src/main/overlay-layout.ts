/**
 * 悬浮灯画布尺寸计算 —— **纯函数，不依赖 electron**。
 *
 * ============================================================================
 * 【为什么单独成文件】
 * ============================================================================
 * 这里的常量必须与 `src/renderer/shared.css` 的 `.lamp-strip` 布局保持一致。
 * 一旦不同步，症状是"**圆圈显示不完整**"——内容比画布高，边缘的灯被窗口裁掉。
 * 这个 bug 真实发生过：初版高度公式算出 88px，而 CSS 实际内容是 93px，
 * 上下各被裁 2px，总灯和最后一行的圆点看起来被切了边。
 *
 * 抽成纯函数才能被单测锁住（`test/overlay-layout.test.ts` 里有一条
 * "画布必须能容纳 CSS 内容"的断言）。`OverlayWindow` 本身依赖 electron，测不了。
 *
 * ============================================================================
 * 【对齐口径】
 * ============================================================================
 * 改 CSS 时请把这里的常量一起改，对应关系：
 *   STRIP_PAD_X / STRIP_PAD_Y  ->  .lamp-strip 的 padding: 6px 8px
 *   STRIP_GAP                  ->  .lamp-strip 的 gap: 6px
 *   MASTER_H                   ->  .strip-master-dot(16) + padding-bottom(5) + border(1)
 *   ROWS_GAP                   ->  .strip-rows 的 gap: 5px
 *   ROW_H                      ->  .strip-dot 的 height: 14px
 *   CONTENT_W                  ->  小灯(14) + gap(6) + 最长端口标签宽度
 *
 * @module overlay-layout
 */

import type { LampDock } from '../shared/types';

/** 单灯模式的正方形画布 = 灯直径 + 24（给徽标与 hover 提示留余量）。 */
export const SINGLE_LAMP_EXTRA = 24;

/**
 * 灯带内容宽度：小灯 14 + gap 6 + 最长端口标签。
 *
 * 实测（CDP 量真实 DOM）：3 行灯带的**自然宽度 118.48px**，
 * 减去左右 padding(8*2) 得内容 102.5px。
 * 这里取 120 留出余量（长端口名由 `.strip-port` 的 ellipsis 兜底）。
 */
export const STRIP_CONTENT_WIDTH = 120;

/** 灯带内边距（左右），对应 .lamp-strip padding 的 8px。 */
export const STRIP_PAD_X = 8;
/** 灯带内边距（上下），对应 .lamp-strip padding 的 6px。 */
export const STRIP_PAD_Y = 6;
/** 总灯区与端口行区之间的 gap，对应 .lamp-strip gap。 */
export const STRIP_GAP = 6;
/**
 * 总灯行高度（含分隔线）。
 *
 * ⚠️ 这个值是从**实测**反推的，不是纯理论计算：
 *   实测 3 行灯带自然高度 = 93px，每行步进 18px（见 STRIP_ROW_STEP），
 *   扣掉上下 padding(12) + gap(6) + 3 行(54)，得总灯区 = 21px。
 * 理论值（16 圆点 + 5 padding-bottom + 1 线 = 22）与实测差 1px ——
 * 以**实测**为准，因为 CSS 的取整行为不总是与理论一致。
 */
export const STRIP_MASTER_HEIGHT = 21;
/**
 * 单个端口行的**有效高度（含行间距）**。
 *
 * ⚠️ 从实测反推，不是 .strip-dot 的 14px：
 *   实测 3 行灯带自然高度 = 93px
 *   减去固定部分（上下 padding 12 + 总灯区 23 + gap 6 = 41）= 52px
 *   52 / 3 ≈ 17.33px/行
 * 为什么比 14 大：`.strip-rows` 的 gap(5) 摊到每行，且行内文字行高、
 * flex 对齐会产生取整余量。用 18 而非 17.33 是**刻意向上取整** ——
 * 宁可每行多留 0.67px，也不能让圆点被裁（少 1px 就是切边）。
 */
export const STRIP_ROW_STEP = 18;
/** 端口小灯高度，对应 .strip-dot height（仅用于逐行边界校验）。 */
export const STRIP_ROW_HEIGHT = 14;
/**
 * `.strip-rows` 的四周内边距（CSS 里是 `padding: 6px`）。
 *
 * 它同时起两个作用：
 *   1. 让 `overflow-y: auto` 这个滚动容器的裁剪边退到圆点描边之外
 *      —— **四个方向都要**，因为小灯的投影左右各外扩 4px。
 *      只留垂直 padding 会让圆点左侧被切（这个 bug 真实发生过）。
 *   2. 滚动时首尾行不会紧贴裁剪边
 */
export const STRIP_ROWS_PAD_X = 6;
export const STRIP_ROWS_PAD_Y = 6;

/**
 * 垂直/水平方向的额外留白。
 *
 * 【为什么必须是 12px 而不是 8px —— 这是"圆圈显示不完整"的真正最后一层】
 * 小灯的 `box-shadow: 0 0 0 1px, 0 1px 4px` 中，**投影向下约 5px**，
 * 而这些像素画在 border box **之外**。窗口只在内容外留 2px 时，
 * 底部那圈的投影就被窗口边缘切掉 —— 表现为"下面的圆圈不完整"。
 *
 * 对称留白 12px 后，上下各有 12px 余量，向下的 5px 投影完全落在窗口内。
 * 多出来的空白是透明的、看不见的，所以"宁可多留"没有代价。
 */
export const STRIP_SHADOW_PAD_X = 8;
export const STRIP_SHADOW_PAD_Y = 12;

/**
 * 额外的安全余量（高度）。
 *
 * 为什么不能只靠"精确计算"：CSS 的取整、字体度量、`backdrop-filter`
 * 都可能让实际渲染比公式多出 1–2px。差 1px 的表现就是**圆点边缘被切**，
 * 而多 3px 是完全看不见的。所以这里刻意偏向"宁可多点"。
 */
export const STRIP_SAFETY_PAD = 6;

/**
 * 灯带内容自然高度（不含额外留白）。
 *
 * 组成：灯带上下 padding + 总灯区 + 区间距 + `.strip-rows` 上下内边距 + 各行。
 */
export function stripContentHeight(rows: number): number {
  const n = Math.max(0, rows);
  return (
    STRIP_PAD_Y * 2 +
    STRIP_MASTER_HEIGHT +
    STRIP_GAP +
    STRIP_ROWS_PAD_Y * 2 +
    n * STRIP_ROW_STEP
  );
}

/** 灯带画布宽度（含内边距与水平留白）。 */
export function stripCanvasWidth(): number {
  // `.strip-rows` 的水平内边距也要算进来（它撑宽了灯带内容）
  return STRIP_CONTENT_WIDTH + STRIP_ROWS_PAD_X * 2 + STRIP_PAD_X * 2 + STRIP_SHADOW_PAD_X * 2;
}

/** 灯带画布高度（含额外留白），按端口数增长。 */
export function stripCanvasHeight(rows: number): number {
  return stripContentHeight(rows) + STRIP_SHADOW_PAD_Y * 2 + STRIP_SAFETY_PAD;
}

/**
 * 计算透明画布尺寸。
 *
 * @param lampSize  单灯直径（来自 lamp.size 设置）
 * @param taskCount 启用的任务数；< 2 时退回单灯形态
 * @param maxHeight 高度上限（超出由 .strip-rows 自己滚动），默认 70vh
 * @param dock      停靠方向；非 none 时改用点阵形态（见下方「边缘停靠」）
 */
export function resolveCanvasSize(
  lampSize: number,
  taskCount: number,
  maxHeight: number,
  dock: LampDock = 'none',
): { width: number; height: number } {
  const base = Math.max(16, Math.round(lampSize));

  if (taskCount < 2) {
    const square = base + SINGLE_LAMP_EXTRA;
    return { width: square, height: square };
  }

  if (dock !== 'none') {
    return compactCanvasSize(taskCount, dock);
  }

  return {
    width: stripCanvasWidth(),
    height: Math.min(stripCanvasHeight(taskCount), maxHeight),
  };
}

/* ============================================================================
 * 边缘停靠 —— 拖到屏幕侧边/顶部时切成"点阵"形态（只要灯，不要文字）
 * ==========================================================================*/

/**
 * 判定"贴边"的距离阈值（px）。
 *
 * 取 24 的理由：小于它时窗口边缘已经明显贴着屏幕边；
 * 再大就容易被"只是放在旁边"的位置误触发。
 */
export const DOCK_THRESHOLD = 24;

/** 点阵模式的圆点直径（与灯带里的小灯一致，视觉上不跳）。 */
export const COMPACT_DOT = 14;
/** 点阵模式里总灯（聚合态）的直径。 */
export const COMPACT_MASTER = 16;
/** 点阵模式的圆点间距。 */
export const COMPACT_GAP = 5;
/**
 * 点阵模式的灯带内边距（四周）。
 *
 * 比常规灯带的 `6px 8px` 更紧：点阵形态追求"只剩一排灯"，
 * 留白越少越不挡事（这些留白是透明的，但仍会吃掉鼠标事件）。
 */
export const COMPACT_PAD = 4;
/** 点阵模式的额外留白：给 `box-shadow`（左右各外扩约 4px）留出不被裁的余量。 */
export const COMPACT_SHADOW_PAD = 6;
/** 点阵模式的安全余量：CSS 取整/字体度量可能多出 1–2px，宁可多留。 */
export const COMPACT_SAFETY = 4;

/**
 * 点阵形态的画布尺寸。
 *
 * 主轴长度 = 总灯 + 间距 + n 个圆点 + (n-1) 个圆点间距；
 * `top` 停靠时主轴是**水平**的（横排），左右停靠时是**垂直**的（竖排）。
 *
 * ⚠️ 这些常量必须与 `shared.css` 里 `body.dock-*` 那段保持一致。
 * 与常规灯带同理：算小了就切圆点，算大了只是多一点看不见的透明边。
 */
export function compactCanvasSize(
  rows: number,
  dock: LampDock,
): { width: number; height: number } {
  const n = Math.max(0, rows);
  const taskAxis = n > 0 ? n * COMPACT_DOT + (n - 1) * COMPACT_GAP : 0;
  const mainAxis = taskAxis > 0 ? COMPACT_MASTER + STRIP_GAP + taskAxis : COMPACT_MASTER;

  const horizontal = dock === 'top';
  const contentW = horizontal ? mainAxis : Math.max(COMPACT_MASTER, COMPACT_DOT);
  const contentH = horizontal ? COMPACT_MASTER : mainAxis;

  return {
    width: contentW + COMPACT_PAD * 2 + COMPACT_SHADOW_PAD * 2,
    height: contentH + COMPACT_PAD * 2 + COMPACT_SHADOW_PAD * 2 + COMPACT_SAFETY,
  };
}

/** 一个屏幕矩形（工作区或显示器边界都用它）。 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 工作区三条边里，哪些是"真正的屏幕边"（边外没有另一块显示器）。 */
export interface ScreenEdges {
  top: boolean;
  left: boolean;
  right: boolean;
}

/**
 * 判断工作区的上/左/右三条边里，哪些是**真正的屏幕边**。
 *
 * 【为什么必须区分 —— 这是用户实测报上来的 bug】
 * "距离为负"（窗口探出这条边）有两种完全不同的情形：
 *
 *  1. **在屏幕边上继续往外推**：鼠标被屏幕边挡住，窗口必然探出去一点
 *     （实测用户把灯拖到右边缘时 x=3702，而屏幕 3840、窗口 164 ——
 *      右边缘本该 3676，实际探出 26px）。这是**正常**的贴边动作。
 *  2. **跨屏摆放**：窗口一半在主屏、一半在副屏，压在**两块屏的交界**上。
 *     这不是贴边，用户只是把灯放在了两屏之间。
 *
 * 只看距离正负分不开这两者 —— 必须看这条边外面**还有没有别的屏**。
 * 第一版没做这个区分，先误判了情形 2（D90），修完又把情形 1 一起误杀了，
 * 表现就是用户报的"顶部可以、左右侧不行"。
 */
export function screenEdgesFor(
  workArea: Rect,
  displays: Rect[],
  center: { x: number; y: number },
): ScreenEdges {
  /** 该点是否落在任何一块显示器上。 */
  const covered = (x: number, y: number): boolean =>
    displays.some((d) => x >= d.x && x < d.x + d.width && y >= d.y && y < d.y + d.height);

  return {
    // 探出这条边的那个点若被别的屏覆盖，说明它是屏内交界，不是屏幕边
    left: !covered(workArea.x - 1, center.y),
    right: !covered(workArea.x + workArea.width, center.y),
    top: !covered(center.x, workArea.y - 1),
  };
}

/**
 * 由窗口位置判定停靠方向（纯函数，可单测）。
 *
 * 只看**上 / 左 / 右**三条边（用户要的是"侧边或顶部"；贴底部不改变形态）。
 * 距离取最近的一条；**并列时顶部优先** —— 左上角那种情况横排更自然也更好认。
 *
 * @param screenEdges 这三条边哪些是真正的屏幕边（见 `screenEdgesFor`）。
 *   默认三条都是 —— 单屏用户就是这个情况。
 *
 * 判据：距离 ≤ 阈值即可贴边；但**距离为负**（窗口探出这条边）时，
 * 只有该边确实是屏幕边才算 —— 否则那是"跨屏摆放"，不该改形态。
 */
export function resolveDock(
  bounds: Rect,
  workArea: Rect,
  screenEdges: ScreenEdges = { top: true, left: true, right: true },
  threshold: number = DOCK_THRESHOLD,
): LampDock {
  const candidates: Array<{ dock: 'top' | 'left' | 'right'; distance: number }> = [
    { dock: 'top', distance: bounds.y - workArea.y },
    { dock: 'left', distance: bounds.x - workArea.x },
    { dock: 'right', distance: workArea.x + workArea.width - (bounds.x + bounds.width) },
  ];

  let best: LampDock = 'none';
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const { distance } = candidate;
    // 探出这条边（距离为负）时，只有真屏幕边才算贴边
    const overshootAllowed = distance >= 0 || screenEdges[candidate.dock];
    // 严格小于 => 并列时先出现的（top）胜出
    if (overshootAllowed && distance <= threshold && distance < bestDistance) {
      bestDistance = distance;
      best = candidate.dock;
    }
  }
  return best;
}
