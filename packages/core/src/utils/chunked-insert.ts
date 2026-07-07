/**
 * Chunked Y.Text insertion for large pastes.
 *
 * Inserting a 1MB+ markdown string into Y.Text in one transaction freezes
 * the UI on iOS Safari and slower desktop setups. We split large inserts
 * into ~50KB segments and yield between segments via `requestAnimationFrame`,
 * keeping per-frame work well under 16ms to preserve 60fps.
 *
 * The final Observer B re-parse on the completed Y.Text is a single pass
 * of O(total-doc-size) — mitigating that is Future Work (incremental
 * re-parse). This module addresses the input-phase latency only.
 *
 * Transaction semantics: each chunk lands in its own Y.Doc transaction,
 * so the CRDT logs carry N append ops instead of one. Observer A/B
 * typing-defer still batches the downstream work to a single post-paste
 * re-parse. Origin is preserved across chunks.
 *
 * Threshold defaults are chosen to make the 500KB boundary ship the same
 * behavior as single-shot insertion (one transaction). Large inputs
 * (>500KB markdown) trigger chunking.
 *
 * Partial-failure discipline: the loop is wrapped in try/catch. If a
 * mid-stream chunk throws (Y.Text length-limit, doc destroyed, etc.) the
 * failure propagates as a `ChunkedInsertError` carrying partial-progress
 * fields (chunksCompleted, bytesWritten, etc.) so callers can surface a
 * user-facing notice instead of a silent truncation.
 *
 * Hidden-tab safety: `defaultRafYield` detects a hidden document and
 * switches to `setTimeout(0)` so the loop does not suspend indefinitely
 * under browsers that throttle rAF on background tabs.
 *
 * Concurrent-edit safety: the caller can pass `resolveOffset` to resolve
 * the next chunk's absolute write index at dispatch time. Backed by
 * `Y.createRelativePositionFromTypeIndex` in the production caller, so a
 * remote peer inserting at offset ≤ writeIndex during a rAF yield does not
 * shift our intended insertion position. Default is identity (previous
 * monotonic-writeIndex behavior).
 */

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
  /** Inclusive: payloads at-or-below this size skip chunking. Default 500KB. */
  thresholdBytes?: number;
  /** Target bytes per chunk. Default 50KB. */
  chunkSizeBytes?: number;
  /**
   * Yield function between chunks. Default `requestAnimationFrame` with a
   * hidden-tab fallback to `setTimeout(0)`.
   * Injectable for tests.
   */
  yieldFn?: () => Promise<void>;
  /**
   * Transaction origin passed to `doc.transact(..., origin)` for each chunk.
   * Callers pass their `LocalTransactionOrigin` ref so downstream observers
   * see the right identity.
   */
  origin?: unknown;
  /**
   * Resolve the absolute write index immediately before each chunk's insert.
   * Receives the next logical offset (monotonically increasing by
   * `chunkSizeBytes` from the initial `insertAt`) and returns the current
   * absolute offset in the target CRDT. Production callers back this with
   * `Y.createRelativePositionFromTypeIndex` so concurrent writes between
   * chunks do not shift the target.
   *
   * Default: identity (logical offset === absolute offset).
   */
  resolveOffset?: (logicalOffset: number) => number;
}

/**
 * Error thrown when chunked insertion fails mid-stream. Partial progress is
 * exposed so callers can surface a non-modal notice describing how many
 * chunks landed, and how many bytes of the original payload were lost.
 */
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

/**
 * Insert `text` into `ytext` starting at `insertAt`. Below threshold → one
 * transaction. Above threshold → chunked inserts separated by
 * `requestAnimationFrame` yields so the UI stays at 60fps.
 *
 * Returns a Promise that resolves when the final chunk has landed. Rejects
 * with `ChunkedInsertError` (partial-progress info) on mid-stream failure.
 */
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

  // Byte length uses UTF-16 length as a reasonable proxy — the vast majority
  // of markdown content is ASCII-ish and UTF-16 length is `string.length`.
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
    // Browsers throttle or pause `requestAnimationFrame` on background/hidden
    // tabs. If our tab is hidden, fall back to setTimeout(0) so the loop
    // still progresses instead of hanging indefinitely.
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
