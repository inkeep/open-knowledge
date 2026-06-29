export interface KeepaliveScheduler {
  setTimeout: (cb: () => void, ms: number) => ReturnType<typeof globalThis.setTimeout>;
  clearTimeout: (handle: ReturnType<typeof globalThis.setTimeout>) => void;
}

export interface MinimalWebSocket {
  readyState: number;
  close: () => void;
  addEventListener: (type: 'open' | 'close' | 'error', listener: () => void) => void;
}

export interface KeepaliveLogger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  debug(msg: string, ctx?: Record<string, unknown>): void;
}

export interface KeepaliveOptions {
  resolveWsUrl: () => Promise<string | undefined>;
  connectionId?: string;
  pid?: number | string;
  displayName?: string;
  clientName?: string;
  colorSeed?: string;
  logger?: KeepaliveLogger;
  log?: (msg: string) => void;
  scheduler?: KeepaliveScheduler;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  createWebSocket?: (url: string) => MinimalWebSocket;
  rng?: () => number;
}

export interface KeepaliveHandle {
  close: () => void;
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
    } catch {}
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    if (reconnectTimer !== null) {
      scheduler.clearTimeout(reconnectTimer);
    }
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

    const params: string[] = [];
    if (opts.pid !== undefined) {
      params.push(`pid=${encodeURIComponent(String(opts.pid))}`);
    }
    if (opts.connectionId) {
      params.push(`connectionId=${encodeURIComponent(opts.connectionId)}`);
    }
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
      emit('debug', 'websocket error observed', {
        url: baseUrl,
        readyState: ws?.readyState,
        reason: 'error-event',
      });
    });
  }

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
        } catch {}
        ws = null;
      }
    },
    isConnected: () => ws !== null && ws.readyState === 1 /* OPEN */,
  };
}
