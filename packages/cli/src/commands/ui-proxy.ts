/**
 * Minimal reverse HTTP proxy for `ok ui` lock-collision fallback and for
 * forwarding `ok ui`'s `/api/*` traffic to the collab server.
 *
 * Two modes:
 *   1. **Standalone** — `startProxyServer(opts)` spins up an HTTP listener that
 *      forwards every request to an upstream host:port. Used for Claude
 *      Code's `autoPort:true` lock-collision scenario (the listener holds the
 *      autoPort-resolved port; requests get forwarded to the lock-holder's
 *      port).
 *   2. **Embedded** — `proxyRequest(req, res, opts)` is called directly from
 *      an existing `http.Server` request handler to forward a single request
 *      to an upstream. Used by `ok ui` so that React's same-origin REST
 *      calls (`/api/pages`, `/api/backlinks`, etc.) transparently reach the
 *      collab server on a different port without per-caller URL rewriting.
 *
 * Uses only `node:http` — no new 3P dependency.
 */
import type {
  Server as HttpServer,
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from 'node:http';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import type { Duplex } from 'node:stream';
import {
  isAllowedApiOrigin,
  isAllowedWorkspaceHostHeader,
  isLoopbackAddress,
} from '@inkeep/open-knowledge-server';
import { emitProblem } from './ui-problem.ts';

export interface ProxyServerHandle {
  httpServer: HttpServer;
  port: number;
  close: () => Promise<void>;
}

interface StartProxyOptions {
  listenPort: number;
  host: string;
  upstreamHost: string;
  upstreamPort: number;
  /** Per-request upstream timeout in milliseconds. Default 10_000. Upstream
   * hang past this deadline produces a 504 Gateway Timeout. Set to 0 to
   * disable (not recommended — Node's default is no timeout). */
  upstreamTimeoutMs?: number;
}

/** Default: 10s. Long enough for legitimate slow loads, short enough that a
 * hung upstream doesn't keep browser connections open indefinitely. */
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;

/**
 * Reject requests to the proxy that did not arrive over a loopback peer with a
 * loopback Host header and (when present) a loopback Origin. This proxy
 * rewrites the upstream Host header to `localhost:<port>` and the upstream
 * sees the proxy's own loopback peer address — without this gate, a request
 * that arrived over a non-loopback bind, a DNS-rebound hostname, or a
 * cross-origin browser context would launder all three signals before the
 * collab server's own gate (api-extension.ts) could see them.
 *
 * Returns `true` when the request was rejected and the response already
 * written; the caller must return without further work. Returns `false` when
 * the request is safe to forward.
 */
export function rejectIfNotLoopbackApi(req: IncomingMessage, res: ServerResponse): boolean {
  const peerAddress = req.socket?.remoteAddress;
  if (peerAddress !== undefined && !isLoopbackAddress(peerAddress)) {
    emitProblem(
      res,
      403,
      'urn:ok:error:loopback-required',
      'Request must originate from a loopback address.',
    );
    return true;
  }
  if (!isAllowedWorkspaceHostHeader(req.headers.host)) {
    emitProblem(
      res,
      403,
      'urn:ok:error:host-not-allowed',
      'Host header is not in the loopback allowlist.',
    );
    return true;
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !isAllowedApiOrigin(origin)) {
    emitProblem(
      res,
      403,
      'urn:ok:error:invalid-origin',
      'Origin header is not in the loopback allowlist.',
    );
    return true;
  }
  return false;
}

/** Per-request client-side deadline — prevents a malicious/local slow-loris peer
 * from pinning the proxy socket indefinitely. 30s leaves ample margin over the
 * upstream timeout above so we never time out a healthy request. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Upgrade-flow analogue of `rejectIfNotLoopbackApi`. The HTTP/1.1 upgrade
 * exchange has no `ServerResponse` to write a structured error into, so on
 * rejection we destroy the raw socket — the client surfaces this as a failed
 * WebSocket handshake. Same three-gate defense (peer + Host + Origin).
 *
 * Returns `true` when the upgrade was rejected; the caller must return.
 */
export function rejectUpgradeIfNotLoopback(req: IncomingMessage, clientSocket: Duplex): boolean {
  const peerAddress = req.socket?.remoteAddress;
  if (peerAddress !== undefined && !isLoopbackAddress(peerAddress)) {
    clientSocket.destroy();
    return true;
  }
  if (!isAllowedWorkspaceHostHeader(req.headers.host)) {
    clientSocket.destroy();
    return true;
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string' && !isAllowedApiOrigin(origin)) {
    clientSocket.destroy();
    return true;
  }
  return false;
}

/**
 * Forward an HTTP/1.1 upgrade (e.g. WebSocket) to an upstream and bridge the
 * two sockets once the upstream responds with `101 Switching Protocols`.
 *
 * Uses a raw TCP connection rather than `http.request({ headers: { upgrade
 * ... } })`. Node's HTTP client agent can interfere with the upgrade flow
 * (and Bun's compatibility layer is even less reliable for this case);
 * reconstructing the request bytes ourselves keeps the forward path
 * deterministic across runtimes.
 *
 * Caller is responsible for the loopback / origin gate (see
 * `rejectUpgradeIfNotLoopback`). `clientSocket` is the inbound socket Node
 * detached on the upgrade event. `head` is any prefix bytes Node captured
 * between the request line and the event firing (usually empty for WS).
 *
 * The pair of sockets is added to `upgradeSockets` so a parent server's
 * shutdown can tear them down promptly — `httpServer.close()` does not
 * track sockets detached by upgrade.
 */
export function proxyUpgrade(
  req: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  upstreamHost: string,
  upstreamPort: number,
  upgradeSockets: Set<Duplex>,
): void {
  upgradeSockets.add(clientSocket);
  clientSocket.once('close', () => upgradeSockets.delete(clientSocket));

  // Connect timeout — matches the HTTP path's `DEFAULT_UPSTREAM_TIMEOUT_MS`
  // (10s) so a Hocuspocus that accepts TCP but never responds doesn't pin a
  // socket pair indefinitely. Cleared in the `connect` callback below so the
  // bridge isn't subject to an idle-activity timeout once it's live.
  const upstreamSocket = netConnect({
    host: upstreamHost,
    port: upstreamPort,
    timeout: DEFAULT_UPSTREAM_TIMEOUT_MS,
  });
  upgradeSockets.add(upstreamSocket);
  upstreamSocket.once('close', () => upgradeSockets.delete(upstreamSocket));

  let cleaned = false;
  const cleanup = (reason?: { event: string; err?: unknown }): void => {
    if (cleaned) return;
    cleaned = true;
    if (reason !== undefined) {
      const err = reason.err;
      console.warn(
        JSON.stringify({
          event: reason.event,
          upstreamHost,
          upstreamPort,
          url: req.url,
          code: err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined,
          message: err instanceof Error ? err.message : undefined,
        }),
      );
    }
    try {
      upstreamSocket.destroy();
    } catch {
      // best-effort
    }
    try {
      clientSocket.destroy();
    } catch {
      // best-effort
    }
  };

  upstreamSocket.once('connect', () => {
    // Bridge is live — drop the connect timeout so long-running WS sessions
    // aren't capped by it. (Hocuspocus connections are intentionally
    // long-lived; an activity-based timeout would need its own design.)
    upstreamSocket.setTimeout(0);

    // Reconstruct the upgrade request: request line + headers + CRLF CRLF.
    // `req.headers` arrives lowercase-keyed (per Node parser); HTTP header
    // names are case-insensitive so verbatim serialisation is fine.
    const lines: string[] = [
      `${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`,
      `host: ${upstreamHost}:${upstreamPort}`,
    ];
    for (const [name, value] of Object.entries(req.headers)) {
      if (name.toLowerCase() === 'host') continue;
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) lines.push(`${name}: ${v}`);
      } else {
        lines.push(`${name}: ${value}`);
      }
    }
    try {
      upstreamSocket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstreamSocket.write(head);
    } catch (err) {
      cleanup({ event: 'proxy-upgrade-handshake-write-failed', err });
      return;
    }

    // Bidirectional forwarding via manual `data` handlers — `stream.pipe`
    // semantics on upgrade-detached sockets are inconsistent under Bun
    // (spurious `end` events before any payload flows). Manual forwarding
    // sidesteps that.
    upstreamSocket.on('data', (chunk: Buffer) => {
      if (clientSocket.writable) clientSocket.write(chunk);
    });
    clientSocket.on('data', (chunk: Buffer) => {
      if (upstreamSocket.writable) upstreamSocket.write(chunk);
    });
  });

  upstreamSocket.once('timeout', () => {
    cleanup({ event: 'proxy-upgrade-upstream-connect-timeout' });
  });

  // `on('error')` rather than `once('error')` — `cleanup` is idempotent via
  // the `cleaned` flag, and a stray write-after-destroy in the `data`
  // forwarders can fire a second `error` we must still catch (an
  // unhandled-error event would throw at the process level). `close` is the
  // authoritative full-teardown signal; `end` is intentionally NOT listened
  // for because under Bun 1.3 a freshly-connected `net.Socket` can emit a
  // spurious `end` before any payload flows.
  upstreamSocket.on('error', (err) => cleanup({ event: 'proxy-upgrade-upstream-error', err }));
  clientSocket.on('error', (err) => cleanup({ event: 'proxy-upgrade-client-error', err }));
  upstreamSocket.once('close', () => cleanup());
  clientSocket.once('close', () => cleanup());
}

/**
 * Hop-by-hop headers per RFC 7230 §6.1 — these MUST NOT be forwarded by a
 * proxy. Additionally we drop `Cookie` / `Set-Cookie` because `ok ui` does
 * not set cookies and there is no legitimate reason for localhost peers to
 * flow cookies through our reverse proxy.
 *
 * `Upgrade` is stripped on the plain-HTTP request path only. WebSocket
 * upgrades are routed through `proxyUpgrade` above, which preserves
 * `Connection` / `Upgrade` / `Sec-WebSocket-*` verbatim so the upstream can
 * complete the handshake.
 */
const HOP_BY_HOP_HEADERS: readonly string[] = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'cookie',
  'set-cookie',
];

export async function startProxyServer(opts: StartProxyOptions): Promise<ProxyServerHandle> {
  const timeoutMs = opts.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  // Track upgrade-pipe sockets so `close()` can drain them. `httpServer.close()`
  // does not track sockets detached by an upgrade event; without explicit
  // draining a long-lived WS would hold the close-callback open indefinitely.
  const upgradeSockets = new Set<Duplex>();
  const httpServer: HttpServer = createHttpServer((req, res) => {
    // Standalone proxy mode (lock-collision fallback) forwards every URL — not
    // just /api/*. Apply the gate to every request because we have no way to
    // distinguish state-mutating from read-only paths without parsing every
    // upstream's route table; loopback is the only sound default.
    if (rejectIfNotLoopbackApi(req, res)) return;
    forwardRequest(req, res, opts.upstreamHost, opts.upstreamPort, timeoutMs);
  });

  // WebSocket upgrades — forward to the same upstream the HTTP path goes to.
  // Without this, browsers loaded from this proxy port that try to open a WS
  // here (the same-origin case: Electron utility upstream
  // serves the shell + Hocuspocus on a single port) get their connection
  // dropped — the kernel resets the socket because Node has no listener for
  // the `upgrade` event. The upstream then handles the upgrade natively
  // (Hocuspocus is wired into its HTTP server in both `ok ui` and the
  // Electron utility paths).
  httpServer.on('upgrade', (req, clientSocket, head) => {
    if (rejectUpgradeIfNotLoopback(req, clientSocket)) return;
    proxyUpgrade(req, clientSocket, head, opts.upstreamHost, opts.upstreamPort, upgradeSockets);
  });

  await new Promise<void>((done, fail) => {
    const onError = (err: Error) => fail(err);
    httpServer.once('error', onError);
    httpServer.listen(opts.listenPort, opts.host, () => {
      httpServer.off('error', onError);
      done();
    });
  });

  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : opts.listenPort;

  return {
    httpServer,
    port,
    close: () =>
      new Promise<void>((done) => {
        // `httpServer.close(cb)` only invokes the callback once every existing
        // connection has finished — including idle HTTP keep-alive sockets
        // left over from prior `fetch()` calls. Without evicting those, the
        // promise hangs until the OS times out the socket (~10s+), which
        // shows up as flaky test-suite `afterEach` timeouts. Destroy live
        // upgrade pipes first (they own their own sockets post-upgrade and
        // wouldn't be tracked by `closeIdleConnections`), then close idle
        // keep-alives.
        for (const sock of upgradeSockets) {
          try {
            sock.destroy();
          } catch {
            // best-effort — the socket may already be torn down.
          }
        }
        upgradeSockets.clear();
        httpServer.close(() => done());
        httpServer.closeIdleConnections();
      }),
  };
}

interface ProxyRequestOptions {
  upstreamHost: string;
  upstreamPort: number;
  /** Per-request upstream timeout in ms. Default 10_000. 0 disables. */
  upstreamTimeoutMs?: number;
}

/**
 * Forward a single incoming request to an upstream. Shared between
 * `startProxyServer` (which wires it as the request handler) and embedded
 * callers like `ok ui` that thread a targeted `/api/*` proxy into their
 * existing request router without running a second HTTP listener.
 *
 * Handles: header forwarding (minus Host), request-body piping, response
 * status/headers/body piping, 504 on upstream timeout, 502 on upstream
 * error, and client-abort propagation so no upstream sockets leak.
 */
export function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ProxyRequestOptions,
): void {
  forwardRequest(
    req,
    res,
    opts.upstreamHost,
    opts.upstreamPort,
    opts.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
  );
}

function forwardRequest(
  req: IncomingMessage,
  res: ServerResponse,
  upstreamHost: string,
  upstreamPort: number,
  upstreamTimeoutMs: number,
): void {
  // Strip hop-by-hop headers (RFC 7230 §6.1) + Cookie / Set-Cookie. Drop the
  // inbound Host header so we can rewrite it to the upstream authority —
  // keeping the browser's Host would surface the proxy port in upstream logs
  // and confuse vhost-routing upstreams.
  const headers: IncomingHttpHeaders = { ...req.headers };
  delete headers.host;
  for (const name of HOP_BY_HOP_HEADERS) {
    delete headers[name];
  }

  // Per-request deadline — destroy the upstream + response on elapse so a
  // slow-loris client or hung upstream can't pin sockets past DEFAULT_REQUEST_TIMEOUT_MS.
  req.setTimeout(DEFAULT_REQUEST_TIMEOUT_MS, () => {
    if (!res.headersSent) {
      try {
        emitProblem(
          res,
          408,
          'urn:ok:error:request-timeout',
          'Proxy request exceeded the per-request deadline.',
          `Slow-loris-class: client did not finish within ${DEFAULT_REQUEST_TIMEOUT_MS / 1000}s.`,
        );
      } catch {
        // already closed
      }
    } else {
      try {
        res.end();
      } catch {
        // already closed
      }
    }
    try {
      req.socket?.destroy();
    } catch {
      // best-effort
    }
  });

  const upstreamReq = httpRequest(
    {
      host: upstreamHost,
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers: { ...headers, host: `${upstreamHost}:${upstreamPort}` },
    },
    (upstreamRes) => {
      // Strip hop-by-hop headers + Set-Cookie on the response path too —
      // same rationale as the inbound direction.
      const resHeaders = { ...upstreamRes.headers };
      for (const name of HOP_BY_HOP_HEADERS) {
        delete resHeaders[name];
      }
      res.writeHead(upstreamRes.statusCode ?? 502, resHeaders);
      upstreamRes.pipe(res);
      upstreamRes.once('error', () => {
        try {
          res.end();
        } catch {
          // Already closed — nothing to do.
        }
      });
    },
  );

  // Bounded upstream timeout — without this a hung `ok ui` (GC pause, deadlock,
  // anything non-crashing) leaves browsers waiting indefinitely. On deadline we
  // destroy the upstream socket and respond 504 ourselves (headers-not-sent path
  // is the common case; if upstream already started streaming, we just end).
  if (upstreamTimeoutMs > 0) {
    upstreamReq.setTimeout(upstreamTimeoutMs, () => {
      if (!res.headersSent) {
        emitProblem(
          res,
          504,
          'urn:ok:error:gateway-timeout',
          'Upstream did not respond before the gateway deadline.',
          `Upstream timeout: ${upstreamTimeoutMs / 1000}s elapsed without a response.`,
        );
      } else {
        try {
          res.end();
        } catch {
          // Already closed.
        }
      }
      upstreamReq.destroy();
    });
  }

  upstreamReq.on('error', () => {
    if (!res.headersSent) {
      // 502 Bad Gateway → reuse `collab-server-not-running` since the
      // proxy's upstream IS the collab server (`ok start`); a connection
      // error here means the upstream socket couldn't be established or
      // dropped mid-request.
      emitProblem(
        res,
        502,
        'urn:ok:error:collab-server-not-running',
        'Collab server is unreachable.',
        'Upstream connection failed or dropped before a response was received.',
      );
    } else {
      try {
        res.end();
      } catch {
        // Already closed.
      }
    }
  });

  // Propagate client aborts so we don't leak an upstream socket.
  req.on('error', () => {
    upstreamReq.destroy();
  });

  req.pipe(upstreamReq);
}
