/**
 * Attribution parity is structural for the same reason: identity rides the request body exactly as
 * it does over HTTP (precedent #24 — identity at entry).
 */

import { EventEmitter } from 'node:events';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { errorResponse } from './error-response.ts';

type LocalApiMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface LocalApiRequestOptions {
  body?: string | Uint8Array;
  contentType?: string;
}

interface LocalApiResult {
  status: number;
  bodyText: string;
}

export type LocalApiDispatch = (
  method: LocalApiMethod,
  pathWithQuery: string,
  options?: LocalApiRequestOptions,
) => Promise<LocalApiResult | null>;

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

export interface CreateLocalApiDispatchOptions {
  resolve: (pathname: string) => NodeHandler | undefined;
  timeoutMs?: number;
}

class SyntheticResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  readonly req: IncomingMessage;
  private readonly headers = new Map<string, string | number | readonly string[]>();
  private readonly chunks: Buffer[] = [];
  private settle: (() => void) | undefined;
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
