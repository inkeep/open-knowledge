/**
 * Client ↔ collab keep-alive WebSocket primitive.
 *
 * A long-lived client (MCP shim, desktop main process) holds a single
 * persistent WebSocket to `/collab/keepalive` for the lifetime of the
 * client process. The WS carries no traffic — its sole purpose is to
 * register as an `/collab*` upgrade on the collab server so the idle-
 * shutdown primitive (`packages/server/src/idle-shutdown.ts`) counts it
 * as an active client. As long as the keepalive is up, the server's
 * WS-client count stays ≥ 1 and the 30-min idle timer cannot fire.
 *
 * Without this channel, HTTP-only clients (MCP `fetch()` tool calls,
 * desktop renderer non-collab HTTP) don't touch `httpServer.on('upgrade')`,
 * so an otherwise-live session is invisible to idle-shutdown. The failure
 * mode this prevents: idle-shutdown kills the collab server while a client
 * is mid-session; every subsequent tool/editor call returns
 * `Server unreachable: fetch failed` until the user manually reconnects.
 *
 * Server-side intercept: `packages/cli/src/commands/start.ts` routes
 * `/collab/keepalive` upgrades to a bare WS handshake (no Hocuspocus, no
 * Y.Doc) — the socket exists purely as an idle-shutdown signal.
 *
 * Reconnect semantics: on close (including server restart) we retry with
 * exponential backoff (1s → 2s → 4s → … max 30s), re-reading `server.lock`
 * via the injected `resolveWsUrl` callback on each attempt — a server that
 * respawned on a different port is picked up transparently.
 *
 * Presence visibility:
 *   - When ALL three identity fields (`displayName`, `clientName`,
 *     `colorSeed`) are supplied alongside a `connectionId`, the server
 *     bootstraps a presence entry on WS upgrade — surfacing the agent
 *     in the presence bar immediately.
 *   - When any identity field is omitted, the WS still counts for
 *     idle-shutdown but contributes no presence entry — used by the
 *     desktop's main process to opt out of presence (it's "you", not
 *     a peer to display alongside agents).
 */

/** Minimal scheduler shape — injectable for deterministic tests (precedent #13b). */
export interface KeepaliveScheduler {
  setTimeout: (cb: () => void, ms: number) => ReturnType<typeof globalThis.setTimeout>;
  clearTimeout: (handle: ReturnType<typeof globalThis.setTimeout>) => void;
}

/**
 * Minimal shape of what the keep-alive needs from a WebSocket. We accept this
 * instead of the full DOM WebSocket type so tests can pass a fake without
 * needing to satisfy every method/event in the spec.
 */
export interface MinimalWebSocket {
  readyState: number;
  close: () => void;
  addEventListener: (type: 'open' | 'close' | 'error', listener: () => void) => void;
}

/**
 * Structural logger interface — both the server-side `McpLogger` class
 * and any compatible logger (pino-style, console-style) satisfy this
 * shape without requiring a server import in core.
 */
export interface KeepaliveLogger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  debug(msg: string, ctx?: Record<string, unknown>): void;
}

export interface KeepaliveOptions {
  /**
   * Called on each connect attempt. Returns a WebSocket base URL
   * (`ws://localhost:<port>`) or `undefined` if the server is not yet
   * reachable (in which case the keep-alive schedules a retry with
   * backoff rather than failing outright).
   *
   * Typically wired to a `server.lock`-reading resolver — but the keep-
   * alive needs the `ws://` form. Callers pass a small adapter.
   */
  resolveWsUrl: () => Promise<string | undefined>;
  /**
   * Stable per-client-process identity. Included in the keepalive URL
   * query so the server can (a) correlate this WS with the agent's
   * DirectConnection sessions and (b) deterministically clear the agent's
   * presence entry on WS close. Typically a UUID generated once per
   * client subprocess lifetime.
   */
  connectionId?: string;
  /**
   * Process identifier, surfaced as `?pid=` purely for server-side log
   * correlation — the server never uses it for the idle-shutdown count, so
   * the keepalive behaves identically with or without it. Node clients
   * (desktop main, MCP shim) pass `process.pid`; the browser omits it because
   * `process` is undefined in a Vite build. Keeping it an opt-in field (rather
   * than reading `process.pid` here) is what makes this primitive browser-safe.
   */
  pid?: number | string;
  /**
   * Human-readable identity for the connecting agent. When all three of
   * `displayName` + `clientName` + `colorSeed` are supplied alongside
   * `connectionId`, the server bootstraps a presence entry on WS upgrade
   * — surfacing the agent in the presence bar as soon as the client
   * connects, rather than only after the first mutating HTTP write.
   * Without these, the WS still serves its idle-shutdown role but
   * presence stays empty until something else fires `setPresence`. The
   * desktop's main process intentionally omits these (presence-invisible
   * mode — the user IS the desktop, not a peer to render).
   */
  displayName?: string;
  clientName?: string;
  colorSeed?: string;
  /**
   * Structured logger. When provided, lifecycle events emit JSON with
   * url, backoff, and error context. Falls back to `log` callback.
   * Structurally compatible with `McpLogger` and any logger exposing
   * info/warn/error/debug.
   */
  logger?: KeepaliveLogger;
  /**
   * Legacy log callback. Used when `logger` is not provided.
   */
  log?: (msg: string) => void;
  /** Injectable scheduler for deterministic tests (precedent #13b). */
  scheduler?: KeepaliveScheduler;
  /** Override the initial backoff (default 1000ms). Tests pass a small value. */
  initialBackoffMs?: number;
  /** Override the max backoff (default 30000ms). */
  maxBackoffMs?: number;
  /**
   * Override the WebSocket constructor. Defaults to `globalThis.WebSocket`.
   * Tests pass a factory that returns a controllable fake.
   */
  createWebSocket?: (url: string) => MinimalWebSocket;
  /**
   * Override the jitter source for reconnect backoff. Returns a value in
   * `[0, 1)` — applied to the scheduled wait as `wait * (1 - factor/2)`
   * so each reconnect picks a sleep in `[wait/2, wait)`. Prevents
   * thundering-herd reconnects when many clients (e.g. multiple agent
   * harnesses) lose their server simultaneously. Defaults to
   * `Math.random`. Tests pass a deterministic fn for repeatable timing.
   */
  rng?: () => number;
}

export interface KeepaliveHandle {
  /** Stop reconnect attempts and close the underlying WS. Idempotent. */
  close: () => void;
  /** For tests — `true` while the WS is open and in `OPEN` state. */
  isConnected: () => boolean;
}

const DEFAULT_INITIAL_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

export function startKeepalive(opts: KeepaliveOptions): KeepaliveHandle {
  const scheduler: KeepaliveScheduler = opts.scheduler ?? {
    setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h),
  };
  const initialBackoffMs = opts.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const rng = opts.rng ?? Math.random;

  const createWebSocket: (url: string) => MinimalWebSocket =
    opts.createWebSocket ?? ((url: string) => new WebSocket(url));
  const log = opts.logger ?? null;
  const legacyLog = opts.log;
  let ws: MinimalWebSocket | null = null;
  let reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let stopped = false;
  let backoffMs = initialBackoffMs;

  function emit(
    level: 'info' | 'warn' | 'error' | 'debug',
    msg: string,
    ctx?: Record<string, unknown>,
  ): void {
    try {
      if (log) {
        log[level](msg, ctx);
      } else {
        legacyLog?.(msg);
      }
    } catch {
      // best-effort observer
    }
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    if (reconnectTimer !== null) {
      scheduler.clearTimeout(reconnectTimer);
    }
    // Decorrelated jitter on the scheduled wait: pick a value in
    // `[wait/2, wait)`. Without jitter, a population of clients that all
    // lose their server in the same tick (server restart, network hiccup)
    // would all reconnect on the same `1s, 2s, 4s, …` ladder, producing
    // synchronized reconnect storms. The factor is bounded so jitter
    // never delays past the contract's max backoff.
    const ceil = backoffMs;
    backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    const factor = rng();
    const wait = Math.max(1, Math.floor(ceil * (1 - factor / 2)));
    emit('debug', 'scheduling reconnect', { backoffMs: wait, ceilMs: ceil });
    reconnectTimer = scheduler.setTimeout(() => {
      reconnectTimer = null;
      connect().catch((err) => emit('warn', 'reconnect failed', { error: String(err) }));
    }, wait);
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    let baseUrl: string | undefined;
    try {
      baseUrl = await opts.resolveWsUrl();
    } catch (err) {
      emit('warn', 'resolveWsUrl threw', { error: String(err) });
      scheduleReconnect();
      return;
    }
    if (!baseUrl) {
      scheduleReconnect();
      return;
    }

    // Query params are assembled into an array and joined so the URL stays
    // well-formed whichever optional fields are present (no dangling `?&`).
    // `pid` is browser-unsafe (`process` is undefined in a Vite build), so it
    // is opt-in — Node callers pass `pid: process.pid`, the browser passes
    // nothing. The primitive itself never references `process`.
    const params: string[] = [];
    if (opts.pid !== undefined) {
      params.push(`pid=${encodeURIComponent(String(opts.pid))}`);
    }
    if (opts.connectionId) {
      params.push(`connectionId=${encodeURIComponent(opts.connectionId)}`);
    }
    // Identity params: only attached when a connectionId is also present —
    // the server's presence-bootstrap requires the broadcaster key, which is
    // derived from connectionId. Sending displayName without connectionId
    // would dead-end on the server side. Omitting all three (the desktop's and
    // the browser's presence-invisible mode) yields a counting-only WS with no
    // presence bootstrap.
    if (
      opts.connectionId &&
      opts.displayName !== undefined &&
      opts.clientName !== undefined &&
      opts.colorSeed !== undefined
    ) {
      params.push(`displayName=${encodeURIComponent(opts.displayName)}`);
      params.push(`clientName=${encodeURIComponent(opts.clientName)}`);
      params.push(`colorSeed=${encodeURIComponent(opts.colorSeed)}`);
    }
    const query = params.length > 0 ? `?${params.join('&')}` : '';
    const url = `${baseUrl}/collab/keepalive${query}`;
    try {
      ws = createWebSocket(url);
    } catch (err) {
      emit('warn', 'WebSocket constructor failed', { url, error: String(err) });
      ws = null;
      scheduleReconnect();
      return;
    }

    ws.addEventListener('open', () => {
      emit('info', 'connected', { url: baseUrl });
      backoffMs = initialBackoffMs;
    });

    ws.addEventListener('close', () => {
      if (stopped) return;
      emit('info', 'disconnected', { url: baseUrl });
      ws = null;
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // `close` fires after every error that kills the socket; reconnect
      // logic lives there. Emit a debug breadcrumb first so operators can
      // correlate the close/retry with the socket that faulted.
      emit('debug', 'websocket error observed', {
        url: baseUrl,
        readyState: ws?.readyState,
        reason: 'error-event',
      });
    });
  }

  // Fire the first connect on a microtask to let the caller finish wiring.
  queueMicrotask(() => {
    connect().catch((err) => emit('warn', 'initial connect failed', { error: String(err) }));
  });

  return {
    close: () => {
      if (stopped) return;
      stopped = true;
      if (reconnectTimer !== null) {
        scheduler.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        try {
          ws.close();
        } catch {
          // best-effort
        }
        ws = null;
      }
    },
    isConnected: () => ws !== null && ws.readyState === 1 /* OPEN */,
  };
}
