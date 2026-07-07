/**
 * Web/browser client-log forwarder. Captures renderer `console` output
 * (`log`/`info`/`warn`/`error`) plus uncaught `error` / `unhandledrejection`
 * and POSTs batches to `POST /api/client-logs`, which writes them to the
 * server `renderer` pino log so they reach the diagnostics bundle. This is the
 * only way client-side events (e.g. provider-pool's "Failed to connect") get
 * persisted in the web / `ok ui` distribution.
 *
 * Gated OFF in the Electron app: there the main process captures the renderer
 * console directly via `console-message` (see
 * `packages/desktop/src/main/renderer-console-capture.ts`), so running the
 * forwarder too would double-log.
 *
 * Safety: the patched console always calls the original first; an `inForward`
 * re-entrancy guard plus a swallow-everything flush path ensure the forwarder
 * can never recurse through its own (or a transitive) console call, and a
 * failed POST is dropped silently — diagnostics must never surface to the user.
 *
 * The `console` / `window` / `document` / `now` collaborators are injectable
 * (defaulting to the real globals) so the logic is unit-testable without a DOM.
 */

import {
  type ClientLogEntry,
  parseStructuredConsoleMessage,
  RENDERER_LOG_MAX_BATCH_BYTES,
  RENDERER_LOG_MAX_ENTRIES,
  RENDERER_LOG_MAX_MESSAGE_BYTES,
  truncateLogMessage,
} from '@inkeep/open-knowledge-core';

const FORWARDER_MARKER = Symbol.for('ok.client.logForwarder');

const DEFAULT_FLUSH_INTERVAL_MS = 2000;

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error';
const CONSOLE_METHODS: readonly ConsoleMethod[] = ['log', 'info', 'warn', 'error'];
const LEVEL_BY_METHOD: Record<ConsoleMethod, ClientLogEntry['level']> = {
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

type ConsoleLike = Record<ConsoleMethod, (...args: unknown[]) => void>;

/** Narrow `window` subset — gate flag, transport, listener registration. */
interface ForwarderWindowLike {
  okDesktop?: unknown;
  fetch: typeof fetch;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/** Narrow `document` subset — unload-flush trigger. */
interface ForwarderDocumentLike {
  readonly visibilityState: string;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface ClientLogForwarderHandle {
  /** Flush the current queue immediately (used on unload + in tests). */
  flushNow(): void;
  /** Restore the original console + remove listeners + clear the marker. */
  uninstall(): void;
}

export interface InstallClientLogForwarderOptions {
  /** Override the POST transport (tests). Defaults to the resolved window `fetch`. */
  fetchImpl?: typeof fetch;
  /** Trailing-edge flush debounce. Defaults to 2000ms. */
  flushIntervalMs?: number;
  /** Console to patch + restore. Defaults to the global `console`. */
  consoleObj?: ConsoleLike;
  /** Window-like for the gate, transport, and listeners. Defaults to global `window`. */
  windowObj?: ForwarderWindowLike & { [FORWARDER_MARKER]?: true };
  /** Document-like for the visibility/unload flush. Defaults to global `document`. */
  documentObj?: ForwarderDocumentLike | null;
  /** Timestamp source. Defaults to `Date.now`. */
  now?: () => number;
}

function stringifyArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

/** Cheap upper-bound byte estimate for an entry's JSON payload. */
function estimateEntryBytes(entry: ClientLogEntry): number {
  let n = entry.message.length + 80;
  if (entry.event) n += entry.event.length;
  if (entry.fields) {
    try {
      n += JSON.stringify(entry.fields).length;
    } catch {
      // Non-serializable fields shouldn't reach here (they came from JSON.parse),
      // but never let estimation throw.
    }
  }
  return n;
}

/**
 * Install the forwarder. No-op (returns `undefined`) when there is no window,
 * when running inside Electron (`window.okDesktop` present), or when already
 * installed. Idempotent via a marker symbol (guards React StrictMode double
 * invoke + HMR).
 */
export function installClientLogForwarder(
  options: InstallClientLogForwarderOptions = {},
): ClientLogForwarderHandle | undefined {
  const resolvedWin =
    options.windowObj ??
    (typeof window !== 'undefined' ? (window as unknown as ForwarderWindowLike) : undefined);
  if (!resolvedWin) return undefined;
  if (resolvedWin.okDesktop) return undefined; // Electron main captures the console directly.

  // Bind a non-undefined-typed local so the closures below (flush, listeners,
  // uninstall) see it as defined — TS does not carry top-level narrowing into
  // nested function bodies.
  const win: ForwarderWindowLike & { [FORWARDER_MARKER]?: true } = resolvedWin;
  if (win[FORWARDER_MARKER]) return undefined;
  win[FORWARDER_MARKER] = true;

  const con: ConsoleLike = options.consoleObj ?? (console as ConsoleLike);
  const doc: ForwarderDocumentLike | null =
    options.documentObj !== undefined
      ? options.documentObj
      : typeof document !== 'undefined'
        ? (document as ForwarderDocumentLike)
        : null;
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const doFetch = options.fetchImpl ?? win.fetch.bind(win);
  const now = options.now ?? Date.now;

  const queue: ClientLogEntry[] = [];
  let pendingBytes = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Set while flushing so neither the flush path nor any transitive console
  // call it triggers gets re-captured (recursion guard).
  let inForward = false;

  const original: ConsoleLike = {
    log: con.log.bind(con),
    info: con.info.bind(con),
    warn: con.warn.bind(con),
    error: con.error.bind(con),
  };

  function flushNow(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (queue.length === 0) return;
    const entries = queue.splice(0, RENDERER_LOG_MAX_ENTRIES);
    pendingBytes = 0;
    inForward = true;
    try {
      void doFetch('/api/client-logs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({ entries }),
      }).catch(() => {
        // Network failure — drop. Never surface; never console.* here (would
        // re-capture). The entries are already removed from the queue.
      });
    } catch {
      // Synchronous failure (e.g. serialization) — drop the batch.
    } finally {
      inForward = false;
    }
  }

  function enqueue(entry: ClientLogEntry): void {
    queue.push(entry);
    pendingBytes += estimateEntryBytes(entry);
    // Bounded ring — drop oldest under sustained backpressure.
    if (queue.length > RENDERER_LOG_MAX_ENTRIES) {
      const dropped = queue.shift();
      if (dropped) pendingBytes -= estimateEntryBytes(dropped);
    }
    // Flush on entry count OR byte budget — the byte cap keeps each POST under
    // the browser's ~64KB `keepalive` limit so unload-time flushes aren't
    // silently dropped.
    if (queue.length >= RENDERER_LOG_MAX_ENTRIES || pendingBytes >= RENDERER_LOG_MAX_BATCH_BYTES) {
      flushNow();
      return;
    }
    if (timer === null) timer = setTimeout(flushNow, flushIntervalMs);
  }

  function captureConsole(level: ClientLogEntry['level'], args: unknown[]): void {
    if (inForward) return;
    try {
      const message = truncateLogMessage(args.map(stringifyArg).join(' '));
      // Only attempt the structured JSON.parse on a reasonably-sized first arg —
      // a multi-MB `console.log(hugeJsonString)` would otherwise block the
      // caller's hot path parsing bytes we'd discard anyway (the message is
      // already truncated and oversized fields are dropped below).
      const firstArg = args[0];
      const firstString =
        typeof firstArg === 'string' && firstArg.length <= RENDERER_LOG_MAX_BATCH_BYTES
          ? firstArg
          : undefined;
      const structured = firstString ? parseStructuredConsoleMessage(firstString) : null;
      // Bound the lifted fields so a single oversized structured entry can't
      // blow past the batch byte budget (and the keepalive limit). Drop fields
      // when serialized over the per-message cap — the truncated `message`
      // still carries the gist.
      let fields = structured?.fields;
      if (fields) {
        try {
          if (JSON.stringify(fields).length > RENDERER_LOG_MAX_MESSAGE_BYTES) fields = undefined;
        } catch {
          fields = undefined; // non-serializable — drop rather than risk a huge/throwing payload
        }
      }
      enqueue({
        level,
        message,
        ts: now(),
        ...(structured?.event ? { event: structured.event } : {}),
        ...(fields ? { fields } : {}),
      });
    } catch {
      // Capturing must never throw back into the caller's console.* call.
    }
  }

  for (const method of CONSOLE_METHODS) {
    con[method] = (...args: unknown[]) => {
      original[method](...args);
      captureConsole(LEVEL_BY_METHOD[method], args);
    };
  }

  const onError = (event: Event): void => {
    if (inForward) return;
    const e = event as ErrorEvent;
    captureConsole('error', [
      `uncaught error: ${e.message} (${e.filename}:${e.lineno}:${e.colno})`,
    ]);
  };
  const onRejection = (event: Event): void => {
    if (inForward) return;
    captureConsole('error', [
      `unhandledrejection: ${stringifyArg((event as PromiseRejectionEvent).reason)}`,
    ]);
  };
  const onPageHide = (): void => flushNow();
  const onVisibility = (): void => {
    if (doc && doc.visibilityState === 'hidden') flushNow();
  };

  win.addEventListener('error', onError);
  win.addEventListener('unhandledrejection', onRejection);
  win.addEventListener('pagehide', onPageHide as (event: Event) => void);
  if (doc) doc.addEventListener('visibilitychange', onVisibility);

  function uninstall(): void {
    for (const method of CONSOLE_METHODS) con[method] = original[method];
    win.removeEventListener('error', onError);
    win.removeEventListener('unhandledrejection', onRejection);
    win.removeEventListener('pagehide', onPageHide as (event: Event) => void);
    if (doc) doc.removeEventListener('visibilitychange', onVisibility);
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    queue.length = 0;
    delete win[FORWARDER_MARKER];
  }

  return { flushNow, uninstall };
}
