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
    }
    try {
      clientSocket.destroy();
    } catch {
    }
  };

  upstreamSocket.once('connect', () => {
    upstreamSocket.setTimeout(0);

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

  upstreamSocket.on('error', (err) => cleanup({ event: 'proxy-upgrade-upstream-error', err }));
  clientSocket.on('error', (err) => cleanup({ event: 'proxy-upgrade-client-error', err }));
  upstreamSocket.once('close', () => cleanup());
  clientSocket.once('close', () => cleanup());
}

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
  const upgradeSockets = new Set<Duplex>();
  const httpServer: HttpServer = createHttpServer((req, res) => {
    if (rejectIfNotLoopbackApi(req, res)) return;
    forwardRequest(req, res, opts.upstreamHost, opts.upstreamPort, timeoutMs);
  });

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
        for (const sock of upgradeSockets) {
          try {
            sock.destroy();
          } catch {
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
  upstreamTimeoutMs?: number;
}

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
  const headers: IncomingHttpHeaders = { ...req.headers };
  delete headers.host;
  for (const name of HOP_BY_HOP_HEADERS) {
    delete headers[name];
  }

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
      }
    } else {
      try {
        res.end();
      } catch {
      }
    }
    try {
      req.socket?.destroy();
    } catch {
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
        }
      });
    },
  );

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
        }
      }
      upstreamReq.destroy();
    });
  }

  upstreamReq.on('error', () => {
    if (!res.headersSent) {
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
      }
    }
  });

  req.on('error', () => {
    upstreamReq.destroy();
  });

  req.pipe(upstreamReq);
}
