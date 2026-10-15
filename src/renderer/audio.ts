/**
 * Web Audio 音效合成（架构 D5 / §1.5）。
 *
 * 依赖:仅浏览器 Web Audio API。**零资源、零版权、零分发体积**。
 *
 * 【为什么不用系统默认通知音】（PRD Q5 原本的假设）
 *  PRD §5.1 要求 waiting / success / failed **三种不同音色**，
 *  而系统音做不到区分 —— 这是 PRD 内部的自相矛盾，架构 D5 选择了合成。
 *
 * 合成参数表（架构 §1.5 逐字落地）：
 *  | waiting | 短促「叮」  | 880Hz 正弦，80ms 起音 + 200ms 衰减，音量 0.25 |
 *  | success | 上扬双音    | 660Hz→990Hz 各 120ms，间隔 60ms，音量 0.3|
 *  | failed  | 低沉双音    | 320Hz→220Hz 各 180ms，间隔 80ms，音量 0.35    |
 *  | unknown | 极轻单音    | 440Hz，60ms，音量 0.15（P1，仅托盘）           |
 *
 * ============================================================================
 * 【Classic Script 约束 —— 重要】
 * ============================================================================
 * 本文件被 overlay.html 以 `<script src="audio.js">`（**非** type="module"）加载。
 * 因此：
 *  - **禁止任何 import / export语句**（tsc 会把 `export` 原样保留在产物里，
 *    而 classic script 执行到 `export` 会直接抛 SyntaxError）；
 *  - 只允许 `import type`（编译期完全擦除，已实测确认）；
 *  - 对外接口统一挂到 `window.aiIndicatorAudio`。
 *
 * 注意本文件**不 import 任何值**，因此单独编译也不会产生 import 语句。
 */

(() => {

type TaskStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'success'
  | 'failed'
  | 'unknown';

type ToneSpec = {
  /** 频率序列，按顺序演奏。 */
  frequencies: number[];
  /** 每个音的时长（毫秒）。 */
  durationsMs: number[];
  /** 相邻两音之间的间隔（毫秒）。 */
  gapMs: number;
  /** 峰值音量 0..1。 */
  peakGain: number;
  /** 起音时长（毫秒），避免爆音（click）。 */
  attackMs: number;
  /** 波形。 */
  waveform: OscillatorType;
};

/**
 * 音效规格表 —— 与架构 §1.5 的参数表一一对应。
 * 注意：这里**不涉及任何颜色**，与 shared/constants.ts 无耦合。
 */
const SOUND_SPECS: Partial<Record<TaskStatus, ToneSpec>> = {
  // 短促「叮」
  waiting: {
    frequencies: [880],
    durationsMs: [280],
    gapMs: 0,
    peakGain: 0.25,
    attackMs: 8,
    waveform: 'sine',
  },
  // 上扬双音
  success: {
    frequencies: [660, 990],
    durationsMs: [120, 120],
    gapMs: 60,
    peakGain: 0.3,
    attackMs: 10,
    waveform: 'sine',
  },
  // 低沉双音
  failed: {
    frequencies: [320, 220],
    durationsMs: [180, 180],
    gapMs: 80,
    peakGain: 0.35,
    attackMs: 12,
    waveform: 'triangle',
  },
  // 极轻单音（P1：失联时只给托盘一点提示）
  unknown: {
    frequencies: [440],
    durationsMs: [60],
    gapMs: 0,
    peakGain: 0.15,
    attackMs: 5,
    waveform: 'sine',
  },
};

let audioContext: AudioContext | null = null;

/**
 * 提前激活音频上下文。
 * 架构 §1.5 说明：Electron 渲染层无自动播放限制，但仍稳妥地在挂载时先resume 一次。
 */
function primeAudio(): void {
  try {
    getContext();
  } catch (err) {
    // 音频不可用不影响主功能（托盘/列表/弹窗通知都独立工作）
    console.warn('[audio] 无法初始化音频上下文', err);
  }
}

function getContext(): AudioContext | null {
  if (audioContext) {
    return audioContext;
  }
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) {
    return null;
  }
  audioContext = new Ctor();
  return audioContext;
}

/** 播放某个状态对应的音效。无对应规格时静默返回。 */
function playStatusSound(status: TaskStatus): void {
  const spec = SOUND_SPECS[status];
  if (!spec) {
    return; // idle / starting / running 不响（PRD §5.1 默认通知列为「否」）
  }
  try {
    const ctx = getContext();
    if (!ctx) {
      return;
    }
    // 浏览器策略下 context 可能处于 suspended
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => undefined);
    }
    scheduleSpec(ctx, spec);
  } catch (err) {
    console.warn('[audio] 播放音效失败（已隔离）', err);
  }
}

/** 按规格排布一组振荡器。 */
function scheduleSpec(ctx: AudioContext, spec: ToneSpec): void {
  const now = ctx.currentTime;
  let cursor = now;

  spec.frequencies.forEach((frequency, index) => {
    const durationMs = spec.durationsMs[index] ?? spec.durationsMs[0] ?? 120;
    const durationSec = durationMs / 1000;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = spec.waveform;
    osc.frequency.setValueAtTime(frequency, cursor);

    // 包络：attack 起音 -> 峰值 -> 指数衰减到 0
    // 用 exponentialRampToValueAtTime 而不是 linear，避免在 0 处产生非法值
    const attackSec = Math.max(0.001, spec.attackMs / 1000);
    gain.gain.setValueAtTime(0.0001, cursor);
    gain.gain.exponentialRampToValueAtTime(spec.peakGain, cursor + attackSec);
    gain.gain.exponentialRampToValueAtTime(0.0001, cursor + durationSec);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(cursor);
    osc.stop(cursor + durationSec + 0.02);

    cursor += durationSec + spec.gapMs / 1000;
  });
}

/** 供调试：当前是否有可用的音频输出。 */
function isAudioAvailable(): boolean {
  return audioContext !== null;
}

/* ============================================================================
 * 对外接口（挂到 window，供 overlay.js 读取）
 * ============================================================================
 * 走 window 而非 ES module 的原因见文件头「Classic Script 约束」。
 *
 * 注意：本文件刻意**不import 任何值**（否则 tsc 会产出 import 语句），
 * 因此它不是 TS module，不能用 `declare global`，改为接口合并 + 局部类型断言。
 */

interface AudioBridge {
  playStatusSound: (status: TaskStatus) => void;
  primeAudio: () => void;
  isAudioAvailable: () => boolean;
}

interface WindowWithAudio extends Window {
  aiIndicatorAudio?: AudioBridge;
}

if (typeof window !== 'undefined') {
  (window as WindowWithAudio).aiIndicatorAudio = {
    playStatusSound,
    primeAudio,
    isAudioAvailable,
  };
}

})();