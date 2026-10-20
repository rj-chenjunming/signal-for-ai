/** Bounded read-only JSONL cursor shared by rollout and sanitized Hook events. */
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const MAX_BYTES = 512 * 1024;
const MAX_LINE_BYTES = 256 * 1024;
export interface JsonlCursor<T> {
  identity: string;
  size: number;
  fingerprint: string;
  offset: number;
  pending: Buffer;
  skippingLine: boolean;
  state: T;
  /** 新增正文尚未追平时保持上次可靠观测，不能因分块预算自造失联。 */
  publishedState?: T;
}

export async function readJsonl<T>(path: string, now: number, initial: () => T, reduce: (state: T, line: string, now: number) => T, previous?: JsonlCursor<T>): Promise<{ cursor: JsonlCursor<T>; caughtUp: boolean; reset: boolean }> {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
    // Windows 可能在关闭写句柄时才刷新 mtime。用有界首尾摘要识别同长度重写，
    // 不能仅因时间刷新就重置长回合；样本也计入每轮读取预算。
    const sample = Buffer.alloc(Math.min(info.size, 256));
    if (info.size <= 256) {
      if (sample.length) await handle.read(sample, 0, sample.length, 0);
    } else {
      await handle.read(sample, 0, 128, 0);
      await handle.read(sample, 128, 128, info.size - 128);
    }
    const fingerprint = createHash('sha256').update(sample).digest('hex');
    const reset = previous === undefined || previous.identity !== identity || info.size < previous.size ||
      (info.size === previous.size && fingerprint !== previous.fingerprint);
    const cursor: JsonlCursor<T> = reset ? {
      identity, size: info.size, fingerprint, offset: 0,
      pending: Buffer.alloc(0), skippingLine: false, state: initial(),
    } : { ...previous, size: info.size, fingerprint };
    const buffer = Buffer.alloc(Math.min(info.size - cursor.offset, MAX_BYTES - sample.length));
    const { bytesRead } = buffer.length ? await handle.read(buffer, 0, buffer.length, cursor.offset) : { bytesRead: 0 };
    cursor.offset += bytesRead;
    let start = 0;
    for (let end = buffer.indexOf(10); end >= 0 && end < bytesRead; end = buffer.indexOf(10, start)) {
      if (!cursor.skippingLine && cursor.pending.length + end - start <= MAX_LINE_BYTES) {
        const line = Buffer.concat([cursor.pending, buffer.subarray(start, end)]).toString('utf8');
        cursor.state = reduce(cursor.state, line, now);
      }
      cursor.pending = Buffer.alloc(0);
      cursor.skippingLine = false;
      start = end + 1;
    }
    // 保存短半行的原始字节，避免 UTF-8 字符在块边界被拆坏。超长正文只跳过这一行。
    if (!cursor.skippingLine) {
      if (cursor.pending.length + bytesRead - start <= MAX_LINE_BYTES) {
        cursor.pending = Buffer.concat([cursor.pending, buffer.subarray(start, bytesRead)]);
      } else {
        cursor.pending = Buffer.alloc(0);
        cursor.skippingLine = true;
      }
    }
    const caughtUp = cursor.offset === info.size;
    if (caughtUp) cursor.publishedState = cursor.state;
    return { cursor, caughtUp, reset };
  } finally { await handle.close(); }
}
