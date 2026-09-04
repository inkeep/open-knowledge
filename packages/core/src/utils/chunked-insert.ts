export const DEFAULT_CHUNK_THRESHOLD_BYTES = 500 * 1024;
export const DEFAULT_CHUNK_SIZE_BYTES = 50 * 1024;

export interface InsertableYText {
  insert(index: number, text: string): void;
  length: number;
}

export interface InsertableYDoc {
  transact<T>(fn: () => T, origin?: unknown): T;
}

interface ChunkedInsertOptions {
  thresholdBytes?: number;
  chunkSizeBytes?: number;
  yieldFn?: () => Promise<void>;
  origin?: unknown;
  resolveOffset?: (logicalOffset: number) => number;
}

export class ChunkedInsertError extends Error {
  readonly chunksCompleted: number;
  readonly totalChunks: number;
  readonly bytesWritten: number;
  readonly bytesRemaining: number;
  readonly cause: unknown;

  constructor(
    cause: unknown,
    info: {
      chunksCompleted: number;
      totalChunks: number;
      bytesWritten: number;
      bytesRemaining: number;
    },
  ) {
    const msg =
      cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'unknown error';
    super(
      `chunked insert failed after ${info.chunksCompleted}/${info.totalChunks} chunks (${info.bytesWritten} bytes written, ${info.bytesRemaining} bytes lost): ${msg}`,
    );
    this.name = 'ChunkedInsertError';
    this.chunksCompleted = info.chunksCompleted;
    this.totalChunks = info.totalChunks;
    this.bytesWritten = info.bytesWritten;
    this.bytesRemaining = info.bytesRemaining;
    this.cause = cause;
  }
}

export async function chunkedYTextInsert(
  ydoc: InsertableYDoc,
  ytext: InsertableYText,
  insertAt: number,
  text: string,
  options: ChunkedInsertOptions = {},
): Promise<void> {
  const threshold = options.thresholdBytes ?? DEFAULT_CHUNK_THRESHOLD_BYTES;
  const chunkSize = options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
  const origin = options.origin;
  const yieldFn = options.yieldFn ?? defaultRafYield;
  const resolveOffset = options.resolveOffset ?? ((n: number) => n);

  if (text.length <= threshold) {
    ydoc.transact(() => {
      ytext.insert(insertAt, text);
    }, origin);
    return;
  }

  const totalChunks = Math.ceil(text.length / chunkSize);
  let offset = 0;
  let logicalWriteIndex = insertAt;
  let chunksCompleted = 0;
  let bytesWritten = 0;

  while (offset < text.length) {
    const end = Math.min(offset + chunkSize, text.length);
    const chunk = text.slice(offset, end);
    try {
      const absoluteIndex = resolveOffset(logicalWriteIndex);
      ydoc.transact(() => {
        ytext.insert(absoluteIndex, chunk);
      }, origin);
    } catch (err) {
      throw new ChunkedInsertError(err, {
        chunksCompleted,
        totalChunks,
        bytesWritten,
        bytesRemaining: text.length - offset,
      });
    }
    chunksCompleted++;
    bytesWritten += chunk.length;
    logicalWriteIndex += chunk.length;
    offset = end;
    if (offset < text.length) {
      await yieldFn();
    }
  }
}

function defaultRafYield(): Promise<void> {
  return new Promise((resolve) => {
    const g = globalThis as {
      requestAnimationFrame?: (cb: () => void) => void;
      document?: { hidden?: boolean };
    };
    const hidden = g.document?.hidden === true;
    if (!hidden && typeof g.requestAnimationFrame === 'function') {
      g.requestAnimationFrame(() => resolve());
    } else {
      setTimeout(() => resolve(), 0);
    }
  });
}
