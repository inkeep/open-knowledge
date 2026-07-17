/**
 * `node:http` adapter for tests that stub an upstream HTTP server.
 *
 * These suites previously used `Bun.serve({ port, hostname, fetch })`, whose
 * handler receives a web `Request` and returns a web `Response`. Node 24 ships
 * both as globals, so the handler bodies port over verbatim; this wraps a
 * `node:http` server around such a handler and exposes the slice of Bun.serve's
 * return the suites actually use: `port` and `stop()`.
 *
 * `stop()` closes open connections as well as the listener so the test process
 * exits promptly — the global `fetch` client keeps sockets alive in a pool that
 * would otherwise hold the event loop open past the last assertion.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FetchTestServer {
  readonly port: number;
  stop(force?: boolean): void;
}

export interface FetchTestServerOptions {
  port?: number;
  hostname?: string;
  fetch: (request: Request) => Response | Promise<Response>;
}

async function toWebRequest(nodeReq: IncomingMessage, fallbackHost: string): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeReq.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  const method = nodeReq.method ?? 'GET';
  const host = nodeReq.headers.host ?? fallbackHost;
  const url = `http://${host}${nodeReq.url ?? '/'}`;
  // GET/HEAD carry no body; reading the stream for them would hang.
  let body: BodyInit | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks: Buffer[] = [];
    for await (const chunk of nodeReq) chunks.push(chunk as Buffer);
    if (chunks.length > 0) body = new Uint8Array(Buffer.concat(chunks)) as unknown as BodyInit;
  }
  return new Request(url, { method, headers, body });
}

async function writeWebResponse(response: Response, nodeRes: ServerResponse): Promise<void> {
  nodeRes.statusCode = response.status;
  response.headers.forEach((value, key) => {
    // Node computes content-length from the buffer end() writes; a stale value
    // copied from the web Response would conflict.
    if (key.toLowerCase() === 'content-length') return;
    nodeRes.setHeader(key, value);
  });
  const body = Buffer.from(await response.arrayBuffer());
  nodeRes.end(body);
}

/** Start a local HTTP server backed by a web-`fetch` handler. */
export function startFetchTestServer(options: FetchTestServerOptions): Promise<FetchTestServer> {
  const hostname = options.hostname ?? '127.0.0.1';
  const server = createServer((nodeReq, nodeRes) => {
    void (async () => {
      try {
        const request = await toWebRequest(nodeReq, hostname);
        const response = await options.fetch(request);
        await writeWebResponse(response, nodeRes);
      } catch (err) {
        if (!nodeRes.headersSent) nodeRes.statusCode = 500;
        nodeRes.end(err instanceof Error ? err.message : String(err));
      }
    })();
  });
  return new Promise((resolve) => {
    server.listen(options.port ?? 0, hostname, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        stop() {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}
