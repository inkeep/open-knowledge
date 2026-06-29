
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

interface ForwarderWindowLike {
  okDesktop?: unknown;
  fetch: typeof fetch;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

interface ForwarderDocumentLike {
  readonly visibilityState: string;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface ClientLogForwarderHandle {
  flushNow(): void;
  uninstall(): void;
}

export interface InstallClientLogForwarderOptions {
  fetchImpl?: typeof fetch;
  flushIntervalMs?: number;
  consoleObj?: ConsoleLike;
  windowObj?: ForwarderWindowLike & { [FORWARDER_MARKER]?: true };
  documentObj?: ForwarderDocumentLike | null;
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

function estimateEntryBytes(entry: ClientLogEntry): number {
  let n = entry.message.length + 80;
  if (entry.event) n += entry.event.length;
  if (entry.fields) {
    try {
      n += JSON.stringify(entry.fields).length;
    } catch {
    }
  }
  return n;
}

export function installClientLogForwarder(
  options: InstallClientLogForwarderOptions = {},
): ClientLogForwarderHandle | undefined {
  const resolvedWin =
    options.windowObj ??
    (typeof window !== 'undefined' ? (window as unknown as ForwarderWindowLike) : undefined);
  if (!resolvedWin) return undefined;
  if (resolvedWin.okDesktop) return undefined; // Electron main captures the console directly.

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
      });
    } catch {
    } finally {
      inForward = false;
    }
  }

  function enqueue(entry: ClientLogEntry): void {
    queue.push(entry);
    pendingBytes += estimateEntryBytes(entry);
    if (queue.length > RENDERER_LOG_MAX_ENTRIES) {
      const dropped = queue.shift();
      if (dropped) pendingBytes -= estimateEntryBytes(dropped);
    }
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
      const firstArg = args[0];
      const firstString =
        typeof firstArg === 'string' && firstArg.length <= RENDERER_LOG_MAX_BATCH_BYTES
          ? firstArg
          : undefined;
      const structured = firstString ? parseStructuredConsoleMessage(firstString) : null;
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
