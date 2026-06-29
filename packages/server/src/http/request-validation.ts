
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';
import { errorResponse } from './error-response.ts';

const MAX_BODY_BYTES = 1_048_576;

const REQUEST_BODY_TIMEOUT_MS = 30_000;

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return readBoundedJsonBody(req, {
    maxBytes: MAX_BODY_BYTES,
    timeoutMs: REQUEST_BODY_TIMEOUT_MS,
  });
}

export async function readBoundedJsonBody(
  req: IncomingMessage,
  opts: { readonly maxBytes: number; readonly timeoutMs: number },
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
  const onTimeout = () => req.destroy(new RequestBodyTimeoutError(opts.timeoutMs));
  timeoutSignal.addEventListener('abort', onTimeout, { once: true });
  try {
    for await (const chunk of req) {
      totalBytes += (chunk as Buffer).length;
      if (totalBytes > opts.maxBytes) {
        throw new PayloadTooLargeError(opts.maxBytes);
      }
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  } finally {
    timeoutSignal.removeEventListener('abort', onTimeout);
  }
}

export class PayloadTooLargeError extends Error {
  /** Cap that was exceeded, in bytes — carried so the log line reflects the
   *  actual per-handler bound (e.g. 4 KB for loopback POSTs) rather than
   *  hardcoding `withValidation`'s 1 MB default. Optional for back-compat
   *  with any external constructors. */
  readonly maxBytes?: number;
  constructor(maxBytes?: number) {
    super(
      maxBytes !== undefined
        ? `Request body exceeded ${formatBytes(maxBytes)} cap`
        : 'Request body exceeded cap',
    );
    this.name = 'PayloadTooLargeError';
    this.maxBytes = maxBytes;
  }
}

export class RequestBodyTimeoutError extends Error {
  /** Timeout that fired, in ms — carried so the log line reflects the actual
   *  per-handler bound (e.g. 5 000 ms for loopback POSTs) rather than
   *  hardcoding `withValidation`'s 30 000 ms default. Optional for back-compat. */
  readonly timeoutMs?: number;
  constructor(timeoutMs?: number) {
    super(
      timeoutMs !== undefined
        ? `Request body read exceeded ${timeoutMs}ms timeout`
        : 'Request body read exceeded timeout',
    );
    this.name = 'RequestBodyTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

function formatBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(0)} MB`;
  if (n >= 1_024) return `${(n / 1_024).toFixed(0)} KB`;
  return `${n} B`;
}

export interface WithValidationOptions {
  handler?: string;
  skipBodyParse?: boolean;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  preBodyGate?: (req: IncomingMessage, res: ServerResponse) => boolean;
}

export function validateBody<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  res: ServerResponse,
  options: WithValidationOptions = {},
): { ok: true; value: T } | { ok: false } {
  const parseResult = schema.safeParse(raw);
  if (parseResult.success) {
    return { ok: true, value: parseResult.data };
  }
  const detail = parseResult.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Request body is invalid.', {
    handler: options.handler,
    detail,
  });
  return { ok: false };
}

export type ValidatedHandler<T> = (
  req: IncomingMessage,
  res: ServerResponse,
  body: T,
) => Promise<void> | void;

export function withValidation<T>(
  schema: z.ZodType<T>,
  handler: ValidatedHandler<T>,
  options: WithValidationOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (options.method !== undefined && req.method !== options.method) {
      errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
        handler: options.handler,
        extraHeaders: { Allow: options.method },
      });
      return;
    }

    if (options.preBodyGate !== undefined) {
      const gateOk = options.preBodyGate(req, res);
      if (!gateOk) {
        if (!res.headersSent && !res.writableEnded && !res.destroyed) {
          errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
            handler: options.handler,
            cause: new Error('preBodyGate returned false without writing a response'),
          });
        }
        return;
      }
    }

    if (options.skipBodyParse) {
      const validated = validateBody(schema, {}, res, options);
      if (!validated.ok) return;
      await handler(req, res, validated.value);
      return;
    }

    let raw: Buffer;
    try {
      raw = await readRequestBody(req);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        errorResponse(res, 413, 'urn:ok:error:payload-too-large', 'Payload too large.', {
          handler: options.handler,
          cause: err,
        });
        return;
      }
      if (err instanceof RequestBodyTimeoutError) {
        errorResponse(res, 408, 'urn:ok:error:request-timeout', 'Request body read timed out.', {
          handler: options.handler,
          cause: err,
        });
        return;
      }
      errorResponse(
        res,
        500,
        'urn:ok:error:internal-server-error',
        'Failed to read request body.',
        {
          handler: options.handler,
          cause: err,
        },
      );
      return;
    }

    let parsed: unknown;
    try {
      parsed = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
    } catch (err) {
      errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Request body is not valid JSON.', {
        handler: options.handler,
        cause: err,
      });
      return;
    }

    const validated = validateBody(schema, parsed, res, options);
    if (!validated.ok) return;

    await handler(req, res, validated.value);
  };
}
