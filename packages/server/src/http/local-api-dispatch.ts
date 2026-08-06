/**
 * In-process dispatch for MCP tool self-calls.
 *
 * The MCP tools mounted on the project server (`mcp-http.ts`) historically
 * reached server capabilities by issuing HTTP requests to their own listener
 * — a full TCP + HTTP-parse round trip to a handler living in the same
 * process. With the capability services extracted (`services/*`), the
 * handlers behind those endpoints are thin marshaling layers, so the
 * self-call can collapse to a function call: run the SAME handler against a
 * synthetic req/res pair and hand the captured wire body back to the tool.
 *
 * Byte parity is structural — the handler code that writes the HTTP
 * response writes the local response, and the tool-side normalization
 * (`normalizeResponse` in `mcp/tools/shared.ts`) consumes both transports
 * through one code path. Attribution parity is structural for the same
 * reason: identity rides the request body exactly as it does over HTTP
 * (precedent #24 — identity at entry).
 *
 * The dispatch deliberately does NOT run the `/api/*` admission pipeline
 * (`api-pipeline.ts`): request-id echo, CORS, and the loopback/workspace-Host
 * mutating gates defend the network listener. A same-process caller is
 * inside that trust boundary already — a self-call over HTTP always
 * originated from loopback and passed those gates vacuously.
 *
 * Skipping the pipeline also skips its telemetry triple: the HTTP SERVER
 * span, the `http.server.request.duration{http.route}` histogram sample,
 * and the `api.access` log line. Collapsed MCP traffic therefore leaves
 * the `/api/*`-keyed observability surfaces and shows up instead on the
 * MCP tool layer (`mcp/tool-telemetry.ts`: `mcp.tool.<name>` span +
 * `ok.mcp.tool.duration` histogram + per-tool error counting), which
 * already answers per-call latency and error rate for agent traffic.
 * Anything keyed on `http.route` for these endpoints sees browser/SDK
 * traffic only once this ships.
 *
 * Scope is allowlist-gated by the resolver the api extension supplies:
 * only endpoints whose handlers are thin over a capability service
 * (or an equally thin primitive like the derived-document-index reads)
 * resolve; everything else returns `null` and the tool falls back to HTTP.
 */

import { EventEmitter } from 'node:events';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { errorResponse } from './error-response.ts';

type LocalApiMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface LocalApiRequestOptions {
  /** Pre-serialized request body (JSON string, or raw bytes for multipart). */
  body?: string | Uint8Array;
  /** `Content-Type` header value; required for multipart (carries boundary). */
  contentType?: string;
}

/** Captured wire result — what the HTTP transport would have delivered. */
interface LocalApiResult {
  status: number;
  bodyText: string;
}

/**
 * Dispatch a request in-process. Resolves `null` when the path is outside
 * the collapsed allowlist — the caller then falls back to real HTTP.
 */
export type LocalApiDispatch = (
  method: LocalApiMethod,
  pathWithQuery: string,
  options?: LocalApiRequestOptions,
) => Promise<LocalApiResult | null>;

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

export interface CreateLocalApiDispatchOptions {
  /** Allowlist-gated handler lookup (query string already stripped). */
  resolve: (pathname: string) => NodeHandler | undefined;
  /**
   * Upper bound on handler completion. Matches the MCP shim's HTTP fetch
   * timeout (`mcp/tools/shared.ts`) so both transports share the same
   * cancellation deadline and surface the same timeout error text. Like the
   * HTTP timeout, expiry rejects the caller but does NOT abort the running
   * handler — its side effects may still complete after the deadline.
   */
  timeoutMs?: number;
}

/**
 * Minimal `ServerResponse` stand-in: enough surface for the sanctioned wire
 * emitters (`successResponse` / `errorResponse` / handler-local writes) to
 * run to completion, capturing status + body instead of writing a socket.
 */
class SyntheticResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  readonly req: IncomingMessage;
  private readonly headers = new Map<string, string | number | readonly string[]>();
  private readonly chunks: Buffer[] = [];
  private settle: (() => void) | undefined;
  /**
   * Resolves when the handler ends the response. Named to avoid the real
   * `ServerResponse.finished` (a deprecated boolean) — a handler probing
   * that legacy flag must not find a truthy Promise here.
   */
  readonly settled: Promise<void>;

  constructor(req: IncomingMessage) {
    super();
    this.req = req;
    this.settled = new Promise<void>((resolve) => {
      this.settle = resolve;
    });
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  getHeader(name: string): string | number | readonly string[] | undefined {
    return this.headers.get(name.toLowerCase());
  }

  removeHeader(name: string): void {
    this.headers.delete(name.toLowerCase());
  }

  writeHead(status: number, headers?: OutgoingHttpHeaders): this {
    this.statusCode = status;
    if (headers) {
      for (const [name, value] of Object.entries(headers)) {
        if (value !== undefined) this.headers.set(name.toLowerCase(), value as string);
      }
    }
    this.headersSent = true;
    return this;
  }

  write(chunk: unknown): boolean {
    this.headersSent = true;
    this.appendChunk(chunk);
    return true;
  }

  end(chunk?: unknown): this {
    if (this.writableEnded) return this;
    if (chunk !== undefined) this.appendChunk(chunk);
    this.headersSent = true;
    this.writableEnded = true;
    this.settle?.();
    this.emit('finish');
    this.emit('close');
    return this;
  }

  private appendChunk(chunk: unknown): void {
    if (typeof chunk === 'string') {
      this.chunks.push(Buffer.from(chunk, 'utf8'));
    } else if (chunk instanceof Buffer) {
      this.chunks.push(chunk);
    } else if (chunk instanceof Uint8Array) {
      this.chunks.push(Buffer.from(chunk));
    }
  }

  bodyText(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function syntheticRequest(
  method: LocalApiMethod,
  pathWithQuery: string,
  options: LocalApiRequestOptions,
): IncomingMessage {
  const bodyBytes =
    options.body === undefined
      ? []
      : [
          typeof options.body === 'string'
            ? Buffer.from(options.body, 'utf8')
            : Buffer.from(options.body),
        ];
  const req = Readable.from(bodyBytes) as unknown as IncomingMessage;
  req.method = method;
  req.url = pathWithQuery;
  // The full body is buffered before dispatch, so the request is complete by
  // construction. Handlers that guard the client-disconnect race (`'close'`
  // with `!req.complete`, e.g. the upload spine) must not read the stream's
  // natural end-of-data close as an abort.
  req.complete = true;
  req.headers = {
    host: 'localhost',
    ...(options.contentType !== undefined ? { 'content-type': options.contentType } : {}),
  };
  return req;
}

export function createLocalApiDispatch(opts: CreateLocalApiDispatchOptions): LocalApiDispatch {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return async (method, pathWithQuery, options = {}) => {
    const queryStart = pathWithQuery.indexOf('?');
    const pathname = queryStart === -1 ? pathWithQuery : pathWithQuery.slice(0, queryStart);
    const handler = opts.resolve(pathname);
    if (handler === undefined) return null;

    const req = syntheticRequest(method, pathWithQuery, options);
    const res = new SyntheticResponse(req);

    const run = (async () => {
      try {
        await handler(req, res as unknown as ServerResponse);
      } catch (err) {
        // Mirror the admission pipeline's last-resort envelope: a throw that
        // escaped the handler's own error boundary becomes a typed RFC 9457
        // 500 (guarded against double-write), so the tool sees the same wire
        // body either transport delivers. `errorResponse` logs with `cause`,
        // covering the logging the pipeline's re-throw path provides.
        //
        // `BridgeMergeContentLossError` gets the SAME treatment, on purpose,
        // and that is not a violation of the one-RECOVERY-catch STOP rule
        // (Observer A Path B in `server-observers.ts`): this catch detects
        // and recovers nothing — like the pipeline's terminal catch it turns
        // the escape into the standard 500 envelope, and the `cause`-logged
        // `errorResponse` carries the same observability signal the pipeline
        // emits for it over HTTP. The pipeline additionally re-throws, but
        // only because Hocuspocus request logging sits above it; no such
        // layer exists here, and a re-throw would reach the tool's generic
        // text catch instead — an UNlogged flatten that also breaks response
        // parity with HTTP for exactly this class.
        if (!res.headersSent && !res.writableEnded && !res.destroyed) {
          errorResponse(
            res as unknown as ServerResponse,
            500,
            'urn:ok:error:internal-server-error',
            'Internal server error.',
            { handler: pathname, cause: err },
          );
        }
      }
      await res.settled;
    })();

    // Same deadline + error text the HTTP transport produces when
    // `AbortSignal.timeout` fires inside `fetch`, so the tool-side
    // `Server unreachable: <message>` diagnostic is byte-identical.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([run, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    return { status: res.statusCode, bodyText: res.bodyText() };
  };
}
