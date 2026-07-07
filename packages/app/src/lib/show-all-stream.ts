/**
 * Client consumer for the `GET /api/documents?showAll=true` NDJSON stream
 * The server streams the on-demand disk walk one `DocumentListEntry`
 * per line so it never buffers the whole listing in heap; this module reads that
 * stream incrementally and validates each entry as it arrives.
 *
 * Wire shape (one JSON value per `\n`-terminated line):
 *   - entry lines  — a bare `DocumentListEntry` (always carries `kind`, never
 *     `type`), validated per-line via `DocumentListEntrySchema`.
 *   - terminal line — `{ type: 'complete', truncated, count }`: the entry cap
 *     verdict the per-entry lines can't carry.
 *   - error line    — `{ type: 'error', problem }`: an RFC 9457 problem the
 *     server emits when the walk fails mid-stream (status already on the wire,
 *     so it can't fall back to an HTTP error response).
 *
 * Per-entry validation lives here (not server-side) on purpose: the buffered
 * path's whole-array `safeParse` is one of the three live copies the streaming
 * design removes, so validation moves to the consumer where it stays O(1) and
 * incremental.
 */

import { type DocumentListEntry, DocumentListEntrySchema } from '@inkeep/open-knowledge-core';

/** `Accept` header that opts a showAll request into the NDJSON stream. */
export const SHOW_ALL_NDJSON_ACCEPT = { Accept: 'application/x-ndjson, application/json' } as const;

interface ShowAllStreamResult {
  entries: DocumentListEntry[];
  /** True when the server's walk hit its entry cap and the stream is a prefix. */
  truncated: boolean;
}

/**
 * True when `res` is a consumable NDJSON stream. A non-streaming server, an
 * error response (problem+json), or a mocked JSON fixture all fail this and
 * route the caller to its buffered JSON fallback, so streaming is back-compatible.
 */
export function isNdjsonResponse(res: Response): boolean {
  if (!res.ok || !res.body) return false;
  const contentType = res.headers.get('content-type') ?? '';
  return contentType.includes('application/x-ndjson');
}

/** Raised when the server emits a mid-stream `{ type: 'error', problem }` line. */
export class ShowAllStreamError extends Error {}

type ControlEvent =
  | { type: 'complete'; truncated?: unknown; count?: unknown }
  | { type: 'error'; problem?: { title?: unknown } };

function isControlEvent(value: unknown): value is ControlEvent {
  return typeof value === 'object' && value !== null && 'type' in value;
}

export interface ConsumeShowAllStreamOptions {
  /**
   * Invoked with the entries decoded from each network chunk as the stream
   * arrives, so a caller can paint incrementally instead of waiting for the
   * whole walk. Batched per chunk (not per line) to keep React state churn
   * bounded. Never called with an empty array. The full validated set is still
   * returned at completion for the authoritative reconcile; `onBatch` is purely
   * additive progress. A throw from `onBatch` propagates out of the consumer.
   */
  onBatch?: (batch: DocumentListEntry[]) => void;
}

/**
 * Consume an NDJSON showAll stream to completion, returning the validated
 * entries and the truncation verdict. Malformed or schema-divergent entry lines
 * are warned and skipped (one bad line never aborts the listing); a `type:
 * 'error'` line throws `ShowAllStreamError`. Aborting the originating fetch
 * rejects the underlying read, which propagates out for the caller to treat as
 * a deliberate cancel.
 *
 * Pass `onBatch` to observe entries as each network chunk is decoded (for
 * incremental paint); the complete validated set is always returned regardless.
 */
export async function consumeShowAllStream(
  res: Response,
  options: ConsumeShowAllStreamOptions = {},
): Promise<ShowAllStreamResult> {
  const body = res.body;
  if (!body) throw new ShowAllStreamError('Show All Files stream had no response body.');

  const { onBatch } = options;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const entries: DocumentListEntry[] = [];
  // Entries decoded since the last onBatch flush — emitted per network chunk.
  let pendingBatch: DocumentListEntry[] = [];
  let truncated = false;
  let buffer = '';

  // Returns true once the terminal `complete` line is seen so the caller can
  // stop early. Throws on an `error` line.
  const ingestLine = (rawLine: string): boolean => {
    const line = rawLine.trim();
    if (line.length === 0) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A single corrupt line (e.g. a truncated chunk that slipped the framing)
      // shouldn't sink the whole listing — drop it and keep reading. The
      // bounded excerpt distinguishes truncated framing from server garbage.
      console.warn('[show-all-stream] dropping unparseable NDJSON line:', line.slice(0, 200));
      return false;
    }
    if (isControlEvent(parsed)) {
      if (parsed.type === 'error') {
        const title =
          typeof parsed.problem?.title === 'string'
            ? parsed.problem.title
            : 'Show All Files stream failed.';
        throw new ShowAllStreamError(title);
      }
      // type === 'complete'
      truncated = parsed.truncated === true;
      return true;
    }
    const result = DocumentListEntrySchema.safeParse(parsed);
    if (result.success) {
      entries.push(result.data);
      pendingBatch.push(result.data);
    } else {
      console.warn('[show-all-stream] dropping schema-divergent entry line:', result.error.issues);
    }
    return false;
  };

  // Emit the entries decoded since the last flush, once per network chunk.
  const flushBatch = (): void => {
    if (!onBatch || pendingBatch.length === 0) return;
    const batch = pendingBatch;
    pendingBatch = [];
    onBatch(batch);
  };

  try {
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const completed = ingestLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        if (completed) {
          done = true;
          break;
        }
        newlineIndex = buffer.indexOf('\n');
      }
      // One batch per chunk — bounds React state churn vs. a per-line flush.
      flushBatch();
    }
    // Flush any final line the server didn't newline-terminate (defensive — the
    // server always ends entries + the complete line with `\n`).
    buffer += decoder.decode();
    if (!buffer.includes('\n')) ingestLine(buffer);
    flushBatch();
  } finally {
    reader.releaseLock();
  }

  return { entries, truncated };
}
