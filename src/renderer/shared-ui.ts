/**
 * 渲染层共享助手（SPEC-035）。
 *
 * ============================================================================
 * 【classic script 约束 —— 与 ui.ts / 各窗口文件相同】
 * ============================================================================
 * 本文件被三张 HTML 以 `<script src="shared-ui.js">`（**非** module）加载，
 * 且必须先于窗口脚本（overlay.js / panel.js / goals.js）：
 *  - 禁止 import / export（会产生 `export {}`，classic script 遇之即白屏）；
 *  - 类型由 globals.d.ts 注入（AiTaskStatus 等），共享接口挂 `window.aiUi`。
 *
 * 【为什么收敛】formatTime / 状态文案此前在各窗口文件各存一份，并且已经
 * 实际漂移过一次（SPEC-034：渲染层与主进程时间格式不一致）；新增窗口再
 * 复制只会继续制造漂移面。共享助手让「口径」只有一份。
 *
 * 【刻意不收敛】toast（三个窗口的 DOM 结构与计时刻度不同，合并即行为
 * 变更，见 SPEC-035 §2）；formatDuration（仅 panel 使用，无重复）。
 */

(() => {
  /** 内部用宽松键型：主进程来的未知状态按「空闲」处理（与原 overlay switch 的 default 一致）。 */
  const STATUS_LABEL: Record<string, string> = {
    idle: '空闲',
    starting: '启动中',
    running: '运行中',
    waiting: '等待授权',
    success: '已完成',
    failed: '失败',
    unknown: '失联',
  };

  /** 七态的用户可读文案。 */
  function statusLabel(status: AiTaskStatus): string {
    return STATUS_LABEL[status] ?? '空闲';
  }

  /**
   * 时间线显示时间：同年紧凑 `MM/DD HH:mm`，跨年 `YYYY-MM-DD HH:mm`。
   * SPEC-034：跨年分支必须与主进程 formatGoalTime（goals-store.ts）同构——
   * classic script 约束下两份实现并存，任何一处改动都要同步另一处
   * （锚：check:ui goalsFixture 的 2025-10-19 14:03 断言 + goals-store.test.ts）。
   */
  function formatTime(at: number): string {
    const date = new Date(at);
    const now = new Date();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    if (date.getFullYear() !== now.getFullYear()) {
      return `${date.getFullYear()}-${mm}-${dd} ${hh}:${mi}`;
    }
    return `${mm}/${dd} ${hh}:${mi}`;
  }

  /** 创建带类名/文本的元素（原 goals.ts 的本地助手，供各窗口复用）。 */
  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  window.aiUi = { statusLabel, formatTime, el };
})();
