/**
 * 渲染层全局类型声明（ambient）。
 *
 * ============================================================================
 * 【为什么需要这个文件 —— 重要】
 * ============================================================================
 * 渲染层被 HTML 以 `<script src="overlay.js">`（**非** type="module"）加载。
 * 实测（tsc 5.9）：只要一个 .ts 文件含有**任何** import（含 `import type`），
 * tsc 就会在产物末尾追加 `export {}`，而 classic script 执行到 `export` 会直接抛
 * SyntaxError: Unexpected token 'export' —— 整个渲染层白屏。
 *
 * 因此渲染层的三个 .ts 文件必须保持**零 import**，类型全部通过本文件的
 * `declare global` 提供。这是「渲染层用原生 TS + DOM，不引入打包器」（架构 D1/D2）
 * 的必然代价，不是可以随意更改的风格问题。
 *
 * 共享层类型在这里用 `import type` 引入是**安全的** —— .d.ts 不产生 JS 产物。
 */

import type {
  FocusResult,
  LampDock,
  LampLayout,
  NotifyActionId,
  ProbeTerminalResponse,
  Snapshot,
  TaskAction,
  TaskActionRequest,
  TaskActionResponse,
  TaskState,
  TaskStatus,
} from '../shared/types';
import type { RendererApi } from '../shared/ipc-contract';

/** preload 通过 contextBridge 注入的音效接口（audio.ts 提供）。 */
interface AiIndicatorAudio {
  playStatusSound: (status: TaskStatus) => void;
  primeAudio: () => void;
  isAudioAvailable: () => boolean;
}

declare global {
  interface Window {
    /** preload 暴露的白名单 API（键名见 shared/ipc-contract.ts 的 IPC_GLOBAL_KEY）。 */
    aiIndicator?: RendererApi;
    /** audio.js 挂载的音效接口。 */
    aiIndicatorAudio?: AiIndicatorAudio;
  }

  /**
   * 供渲染层复用的全局类型别名。
   *
   * 【为什么必须写在 declare global 块内 —— 重要】
   * 本文件顶部有 `import type`，因此它是一个**模块**。模块作用域里的 type 声明
   * 不是全局的，overlay.ts / panel.ts 这些 classic script 访问不到。
   * 只有 `declare global { }` 块内的声明才会注入到全局作用域。
   *
   * 这些别名是渲染层「零 import」约束的关键：.ts 文件里不能 import（否则产物带
   * export {}，classic script 白屏），但类型仍要与 shared/types.ts 保持同一来源，
   * 因此通过本 .d.ts 做桥接。
   */
  type AiTaskStatus = TaskStatus;
  type AiTaskAction = TaskAction;
  type AiTaskState = TaskState;
  type AiSnapshot = Snapshot;
  type AiTaskActionRequest = TaskActionRequest;
  type AiTaskActionResponse = TaskActionResponse;
  type AiFocusResult = FocusResult;
  type AiNotifyActionId = NotifyActionId;
  type AiProbeTerminalResponse = ProbeTerminalResponse;
  type AiLampDock = LampDock;
  type AiLampLayout = LampLayout;
}
