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
  currentPath: string;
  previousPath: string;
  maxBytes: number;
}

interface PathWriteState {
  chain: Promise<unknown>;
  parentDirEnsured: boolean;
}

const pathWriteState = new Map<string, PathWriteState>();

function getPathWriteState(currentPath: string): PathWriteState {
  let state = pathWriteState.get(currentPath);
  if (!state) {
    state = { chain: Promise.resolve(), parentDirEnsured: false };
    pathWriteState.set(currentPath, state);
  }
  return state;
}

export class RotatingAppender {
  readonly #currentPath: string;
  readonly #previousPath: string;
  readonly #maxBytes: number;
  readonly #state: PathWriteState;

  constructor(opts: RotatingAppenderOpts) {
    this.#currentPath = opts.currentPath;
    this.#previousPath = opts.previousPath;
    this.#maxBytes = opts.maxBytes;
    this.#state = getPathWriteState(opts.currentPath);
  }

  append(data: string | Uint8Array): Promise<void> {
    const next = this.#state.chain.catch(() => undefined).then(() => this.#doAppend(data));
    this.#state.chain = next;
    return next;
  }

  async drain(): Promise<void> {
    await this.#state.chain.catch(() => undefined);
  }

  async #doAppend(data: string | Uint8Array): Promise<void> {
    if (!this.#state.parentDirEnsured) {
      await mkdir(dirname(this.#currentPath), { recursive: true });
      this.#state.parentDirEnsured = true;
    }
    await writeFile(this.#currentPath, data, { flag: 'a' });
    let size: number;
    try {
      size = statSync(this.#currentPath).size;
    } catch {
      this.#state.parentDirEnsured = false;
      return;
    }
    if (size > this.#maxBytes) {
      try {
        await rename(this.#currentPath, this.#previousPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
      }
    }
  }
}

export interface FileSpanExporterOpts {
  projectDir: string;
  maxBytes: number;
}

const TELEMETRY_SUBDIR = ['.ok', 'local', 'telemetry'] as const;
const CURRENT_FILENAME = 'spans-current.jsonl';
const PREVIOUS_FILENAME = 'spans-prev.jsonl';

export function spansCurrentPath(projectDir: string): string {
  return join(projectDir, ...TELEMETRY_SUBDIR, CURRENT_FILENAME);
}

export function spansPreviousPath(projectDir: string): string {
  return join(projectDir, ...TELEMETRY_SUBDIR, PREVIOUS_FILENAME);
}

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

export const REDACTED_SENTINEL = '[REDACTED]';

export const DEFAULT_MAX_VALUE_BYTES = 4096;

export interface ScrubbingSpanProcessorOpts {
  attributeDenylist: readonly string[];
  maxValueBytes?: number;
}

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

export class ScrubbingSpanProcessor implements SpanProcessor {
  readonly #denylist: ReadonlySet<string>;
  readonly #maxValueBytes: number;

  constructor(opts: ScrubbingSpanProcessorOpts) {
    this.#denylist = new Set(opts.attributeDenylist.map((k) => k.toLowerCase()));
    this.#maxValueBytes = opts.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES;
  }

  onStart(_span: Span, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
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

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}

const LOGS_SUBDIR = ['.ok', 'local', 'logs'] as const;
const LOGS_CURRENT_FILENAME = 'server-current.jsonl';
const LOGS_PREVIOUS_FILENAME = 'server-prev.jsonl';

export function logsCurrentPath(projectDir: string): string {
  return join(projectDir, ...LOGS_SUBDIR, LOGS_CURRENT_FILENAME);
}

export function logsPreviousPath(projectDir: string): string {
  return join(projectDir, ...LOGS_SUBDIR, LOGS_PREVIOUS_FILENAME);
}

export interface PinoFileSinkOpts {
  projectDir: string;
  maxBytes: number;
}

export class PinoFileSink extends Writable {
  readonly #appender: RotatingAppender;
  #lastFailureLogAt = 0;
  #suppressedFailures = 0;

  constructor(opts: PinoFileSinkOpts) {
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
      (err: unknown) => {
        this.#reportWriteFailure(err);
        callback();
      },
    );
  }

  #reportWriteFailure(err: unknown): void {
    const now = Date.now();
    if (now - this.#lastFailureLogAt < 5_000) {
      this.#suppressedFailures++;
      return;
    }
    this.#emitWriteFailure(err instanceof Error ? err.message : String(err), now);
  }

  #emitWriteFailure(error: string, now: number): void {
    const suppressed = this.#suppressedFailures;
    this.#suppressedFailures = 0;
    this.#lastFailureLogAt = now;
    console.error(JSON.stringify({ event: 'pino-file-sink-write-dropped', error, suppressed }));
  }

  async drain(): Promise<void> {
    await this.#appender.drain();
    if (this.#suppressedFailures > 0) {
      this.#emitWriteFailure('flushed at drain', Date.now());
    }
  }
}
