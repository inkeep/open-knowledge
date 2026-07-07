/**
 * File-backed OTel span sink for the local diagnostics bundle.
 *
 * The exporter writes one OTLP/JSON `ResourceSpans` envelope per line to
 * `<projectDir>/.ok/local/telemetry/spans-current.jsonl`. When a write
 * would push the file past `maxBytes`, the current file is atomically
 * renamed to `spans-prev.jsonl` (replacing any prior prev) and subsequent
 * appends start a fresh current. Two-generation ring; total disk
 * footprint is bounded at roughly `2 * maxBytes` plus one in-flight
 * batch.
 *
 * Decoupled from the OTLP/HTTP push exporter — gated separately by the
 * `telemetry.localSink.enabled` config.
 */

import { statSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import type { Context } from '@opentelemetry/api';
import type { ExportResult } from '@opentelemetry/core';
import { ExportResultCode } from '@opentelemetry/core';
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import type {
  ReadableSpan,
  Span,
  SpanExporter,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';

export interface RotatingAppenderOpts {
  /** Active file path; data is always appended here. */
  currentPath: string;
  /** Previous-generation path; `currentPath` is renamed here on rotation. */
  previousPath: string;
  /**
   * Rotation threshold. Once a write pushes the file's size past this value,
   * the file is renamed to `previousPath` (replacing any prior prev) and the
   * next append starts a fresh current.
   */
  maxBytes: number;
}

/**
 * Serialized append-with-rotation primitive. Two writers calling
 * `append()` concurrently are serialized through an internal promise
 * chain so the file is never touched from two contexts at once.
 *
 * SIGKILL between an append and its rotation can leave at most one
 * partial trailing line in `currentPath`; readers should tolerate it
 * (skip lines that fail to JSON.parse). Subsequent appends on the next
 * process start join the file unchanged — repair is a reader concern.
 */
export class RotatingAppender {
  readonly #currentPath: string;
  readonly #previousPath: string;
  readonly #maxBytes: number;
  #writeChain: Promise<unknown> = Promise.resolve();
  #parentDirEnsured = false;

  constructor(opts: RotatingAppenderOpts) {
    this.#currentPath = opts.currentPath;
    this.#previousPath = opts.previousPath;
    this.#maxBytes = opts.maxBytes;
  }

  /**
   * Append `data` to `currentPath`, then check size and rotate if over cap.
   * Resolves after the append (and any rotation) settles; rejects with the
   * underlying fs error if either step fails.
   */
  append(data: string | Uint8Array): Promise<void> {
    const next = this.#writeChain
      // Swallow prior errors so one bad write doesn't deadlock the chain;
      // the rejection still surfaced to that call's awaiter via its own
      // returned promise.
      .catch(() => undefined)
      .then(() => this.#doAppend(data));
    this.#writeChain = next;
    return next;
  }

  /** Resolve once the most recent enqueued append finishes (success or failure). */
  async drain(): Promise<void> {
    await this.#writeChain.catch(() => undefined);
  }

  async #doAppend(data: string | Uint8Array): Promise<void> {
    // Raw node:fs/promises, NOT the fs-traced.ts wrappers. RotatingAppender
    // backs ONLY observability sinks (FileSpanExporter spans + PinoFileSink
    // logs), so its own writes must not create telemetry spans. For the span
    // sink under SimpleSpanProcessor this is load-bearing: a traced write ends
    // an OTel span -> SimpleSpanProcessor.onEnd -> FileSpanExporter.export ->
    // #doAppend -> another traced write -> ... an unbounded recursive chain at
    // disk-I/O speed (BatchSpanProcessor's 5s timer used to mask it to ~1
    // step/tick). Raw fs also spares the log sink a span per line. No
    // application disk writes flow through here, so the fs-traced STOP rule
    // (which governs application-level writes) is not in scope.
    if (!this.#parentDirEnsured) {
      await mkdir(dirname(this.#currentPath), { recursive: true });
      this.#parentDirEnsured = true;
    }
    await writeFile(this.#currentPath, data, { flag: 'a' });
    // Post-write rotation: if current now exceeds the cap, rename to prev.
    // Cap is a soft ceiling — current can transiently overshoot by a single
    // append (one span envelope under SimpleSpanProcessor, or one log chunk).
    let size: number;
    try {
      size = statSync(this.#currentPath).size;
    } catch {
      // The file was removed externally (e.g., manual cleanup). Drop the
      // ensured flag so the next call recreates the dir tree.
      this.#parentDirEnsured = false;
      return;
    }
    if (size > this.#maxBytes) {
      await rename(this.#currentPath, this.#previousPath);
    }
  }
}

export interface FileSpanExporterOpts {
  /**
   * Project root (where `.ok/` lives). Spans land under
   * `<projectDir>/.ok/local/telemetry/` — anchored on the project root, not
   * `content.dir`, so a sub-folder `content.dir` does not spawn a second
   * `.ok/` (it shares the project's per-machine runtime dir alongside
   * `server.lock` / `principal.json` / `state.json`).
   */
  projectDir: string;
  /** Rotation threshold for `spans-current.jsonl`. */
  maxBytes: number;
}

const TELEMETRY_SUBDIR = ['.ok', 'local', 'telemetry'] as const;
const CURRENT_FILENAME = 'spans-current.jsonl';
const PREVIOUS_FILENAME = 'spans-prev.jsonl';

/**
 * Compute the on-disk path for the active spans file under `projectDir`.
 * Exported for tests + the bundle collector (which reads these files).
 */
export function spansCurrentPath(projectDir: string): string {
  return join(projectDir, ...TELEMETRY_SUBDIR, CURRENT_FILENAME);
}

/** Companion to {@link spansCurrentPath} — the previous-generation path. */
export function spansPreviousPath(projectDir: string): string {
  return join(projectDir, ...TELEMETRY_SUBDIR, PREVIOUS_FILENAME);
}

/**
 * OTel `SpanExporter` that serializes each batch as one OTLP/JSON
 * `ResourceSpans` envelope and appends it as a single line to
 * `spans-current.jsonl`, rotating at `maxBytes`.
 *
 * The local sink wires this behind a `SimpleSpanProcessor` (see initTelemetry):
 * spans flush one at a time on span end, so `shutdownTelemetry`'s drain has
 * nothing queued behind a batch timer to race. (`BatchSpanProcessor` is used
 * for the OTLP push exporter instead, where network batching pays off.) The
 * underlying `RotatingAppender` writes with raw fs so the exporter never
 * instruments its own I/O — see `#doAppend`.
 */
export class FileSpanExporter implements SpanExporter {
  readonly #appender: RotatingAppender;
  #shutdown = false;

  constructor(opts: FileSpanExporterOpts) {
    this.#appender = new RotatingAppender({
      currentPath: spansCurrentPath(opts.projectDir),
      previousPath: spansPreviousPath(opts.projectDir),
      maxBytes: opts.maxBytes,
    });
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this.#shutdown) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error('FileSpanExporter: export called after shutdown'),
      });
      return;
    }
    if (spans.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }
    const bytes = JsonTraceSerializer.serializeRequest(spans);
    if (!bytes || bytes.byteLength === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }
    // One envelope per line — append a single \n byte after the JSON bytes.
    const payload = new Uint8Array(bytes.byteLength + 1);
    payload.set(bytes);
    payload[bytes.byteLength] = 0x0a;
    this.#appender.append(payload).then(
      () => resultCallback({ code: ExportResultCode.SUCCESS }),
      (err: unknown) =>
        resultCallback({
          code: ExportResultCode.FAILED,
          error: err instanceof Error ? err : new Error(String(err)),
        }),
    );
  }

  async shutdown(): Promise<void> {
    this.#shutdown = true;
    await this.#appender.drain();
  }

  async forceFlush(): Promise<void> {
    await this.#appender.drain();
  }
}

/** Sentinel inserted in place of any denylisted attribute value. */
export const REDACTED_SENTINEL = '[REDACTED]';

/** Default upper-bound for any single string attribute value before truncation. */
export const DEFAULT_MAX_VALUE_BYTES = 4096;

export interface ScrubbingSpanProcessorOpts {
  /**
   * Attribute keys whose values should be replaced with `[REDACTED]`. Matched
   * case-insensitively against `attribute key`.toLowerCase() — pass the
   * resolved `telemetry.localSink.attributeDenylist` config array; the
   * processor lowercases internally.
   */
  attributeDenylist: readonly string[];
  /**
   * Truncate any string attribute value whose UTF-8 byte length exceeds this
   * limit, replacing it with `[TRUNCATED:<original-size-bytes>]`. Default
   * 4096.
   */
  maxValueBytes?: number;
}

// Characters that count as key-segment boundaries when suffix-matching
// against the denylist. The set covers the three conventions that show
// up in attribute keys carrying credentials in practice:
//   - `.` — OTel canonical (`http.request.headers.authorization`)
//   - `/` — path-style header keys (`headers/authorization`)
//   - `_` — snake_case identifiers (`db_password`, `api_secret`)
// Hyphen is deliberately excluded: hyphens form compound words, so
// `unset-cookie` must NOT match a `cookie` entry, and `password-strength`
// must NOT match `password`. Operators add full variants directly to the
// denylist when the default boundaries miss something.
const KEY_BOUNDARY_CHARS = new Set<string>(['.', '/', '_']);

function keyMatchesDenylist(keyLower: string, denylist: ReadonlySet<string>): boolean {
  if (denylist.has(keyLower)) return true;
  for (const entry of denylist) {
    if (entry.length === 0 || keyLower.length <= entry.length) continue;
    if (!keyLower.endsWith(entry)) continue;
    const boundary = keyLower.charAt(keyLower.length - entry.length - 1);
    if (KEY_BOUNDARY_CHARS.has(boundary)) return true;
  }
  return false;
}

/**
 * Apply the denylist mask + oversize truncation to a single attribute bag in
 * place. Shared across the three attribute surfaces an OTel span carries —
 * `span.attributes`, each `span.events[].attributes`, and each
 * `span.links[].attributes` — so the credential invariant covers all of them
 * with one implementation.
 */
function scrubAttributes(
  attrs: Record<string, unknown>,
  denylist: ReadonlySet<string>,
  maxValueBytes: number,
): void {
  for (const key of Object.keys(attrs)) {
    const value = attrs[key];
    if (value === undefined) continue;
    if (keyMatchesDenylist(key.toLowerCase(), denylist)) {
      attrs[key] = REDACTED_SENTINEL;
      continue;
    }
    if (typeof value === 'string') {
      const size = Buffer.byteLength(value, 'utf-8');
      if (size > maxValueBytes) {
        attrs[key] = `[TRUNCATED:${size}]`;
      }
    }
  }
}

/**
 * Span processor that masks credential-shaped attribute values and truncates
 * oversized strings before downstream processors see the span.
 *
 * The processor mutates `span.attributes`, every `span.events[].attributes`,
 * and every `span.links[].attributes` in place during `onEnd`. Register
 * it BEFORE any exporter you want to keep clean — `BasicTracerProvider`
 * dispatches processors in registration order, and the BSP queues the same
 * `ReadableSpan` reference for later flush, so a scrubbed-then-queued span
 * is what the exporter eventually serializes.
 *
 * Mutation in place is intentional: every downstream consumer (file sink,
 * OTLP push, alternate processors) sees the scrubbed values. The
 * invariant — "no credential bytes ever reach a persistent surface" —
 * dominates the cost of also scrubbing the push pipeline (where the
 * collector would otherwise log the headers verbatim). Coverage extends
 * to events and links because the OTel data model lets either bag carry
 * the same credential-shaped keys as the top-level attribute map.
 *
 * `attributeDenylist` is matched case-insensitively against the
 * lowercased attribute key. A denylist entry matches if it equals the
 * key OR is a boundary-anchored suffix of it, where the boundary
 * characters are `.`, `/`, and `_`. So a denylist `cookie` masks
 * `cookie`, `http.response.headers.cookie`, and `headers/cookie`, but
 * NOT `set-cookie` (hyphen is not a boundary — different word; add it
 * separately) or `mycookie` (no boundary at all). A denylist
 * `password` also masks `db_password` via the underscore boundary.
 */
export class ScrubbingSpanProcessor implements SpanProcessor {
  readonly #denylist: ReadonlySet<string>;
  readonly #maxValueBytes: number;

  constructor(opts: ScrubbingSpanProcessorOpts) {
    this.#denylist = new Set(opts.attributeDenylist.map((k) => k.toLowerCase()));
    this.#maxValueBytes = opts.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES;
  }

  onStart(_span: Span, _parentContext: Context): void {
    // No-op — credential attributes are typically set after start, and
    // scrubbing-on-end is a single enforcement point per span lifetime.
  }

  onEnd(span: ReadableSpan): void {
    // `ReadableSpan` declares each attribute bag as a readonly `Attributes`
    // record (`Record<string, AttributeValue | undefined>`), but the maps
    // themselves are mutable. Mutating in place is the only path that doesn't
    // require synthesizing a parallel ReadableSpan implementation; the same
    // applies to the optional `event.attributes` / `link.attributes` bags.
    scrubAttributes(
      span.attributes as Record<string, unknown>,
      this.#denylist,
      this.#maxValueBytes,
    );
    for (const event of span.events) {
      if (event.attributes !== undefined) {
        scrubAttributes(
          event.attributes as Record<string, unknown>,
          this.#denylist,
          this.#maxValueBytes,
        );
      }
    }
    for (const link of span.links) {
      if (link.attributes !== undefined) {
        scrubAttributes(
          link.attributes as Record<string, unknown>,
          this.#denylist,
          this.#maxValueBytes,
        );
      }
    }
  }

  async forceFlush(): Promise<void> {
    // No state held — flushes happen in downstream processors.
  }

  async shutdown(): Promise<void> {
    // No state held — downstream processors own their own shutdown.
  }
}

const LOGS_SUBDIR = ['.ok', 'local', 'logs'] as const;
const LOGS_CURRENT_FILENAME = 'server-current.jsonl';
const LOGS_PREVIOUS_FILENAME = 'server-prev.jsonl';

/** Active log file path under `projectDir/.ok/local/logs/`. */
export function logsCurrentPath(projectDir: string): string {
  return join(projectDir, ...LOGS_SUBDIR, LOGS_CURRENT_FILENAME);
}

/** Previous-generation log file path. */
export function logsPreviousPath(projectDir: string): string {
  return join(projectDir, ...LOGS_SUBDIR, LOGS_PREVIOUS_FILENAME);
}

export interface PinoFileSinkOpts {
  /**
   * Project root (where `.ok/` lives); logs land under
   * `<projectDir>/.ok/local/logs/` — anchored on the project root, not
   * `content.dir`, so a sub-folder `content.dir` does not spawn a second
   * `.ok/`.
   */
  projectDir: string;
  /** Rotation threshold for `server-current.jsonl`. */
  maxBytes: number;
}

/**
 * Writable stream that pipes Pino JSON records into the shared
 * `RotatingAppender` primitive. Feed to `pino.multistream(streams)` to
 * fan out a logger to both stdout-pretty and disk-JSON.
 *
 * Each `.write()` from Pino is one JSON record terminated with `\n`; the
 * appender writes the bytes verbatim, so the file is line-delimited Pino
 * JSON with the same field layout as the in-memory record (including
 * `trace_id` / `span_id` / `trace_flags` from the `otelMixin`).
 *
 * Rotation contract matches `FileSpanExporter`: when a post-write size
 * check exceeds `maxBytes`, current is renamed to prev (replacing any
 * prior prev) and the next write starts a fresh current.
 */
export class PinoFileSink extends Writable {
  readonly #appender: RotatingAppender;

  constructor(opts: PinoFileSinkOpts) {
    // Pino chunks arrive as either Buffer or string depending on internal
    // routing; `decodeStrings: false` keeps strings as strings and avoids
    // an unnecessary Buffer-allocation step. RotatingAppender accepts
    // both shapes via the appender's writeFile flag: 'a'.
    super({ decodeStrings: false });
    this.#appender = new RotatingAppender({
      currentPath: logsCurrentPath(opts.projectDir),
      previousPath: logsPreviousPath(opts.projectDir),
      maxBytes: opts.maxBytes,
    });
  }

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (err?: Error | null) => void,
  ): void {
    this.#appender.append(chunk).then(
      () => callback(),
      (err: unknown) => callback(err instanceof Error ? err : new Error(String(err))),
    );
  }

  /** Resolve once any enqueued writes have settled — for tests + shutdown. */
  async drain(): Promise<void> {
    await this.#appender.drain();
  }
}
