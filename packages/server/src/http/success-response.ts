
import type { ServerResponse } from 'node:http';
import type { z } from 'zod';
import { getLogger } from '../logger.ts';
import { apiErrorCounter, errorResponse } from './error-response.ts';

const log = (): ReturnType<typeof getLogger> => getLogger('http');

type HttpSuccessStatus = 200 | 201 | 202;

interface SuccessResponseOptions {
  handler?: string;
  extraHeaders?: Record<string, string>;
}

export function successResponse(
  res: ServerResponse,
  status: HttpSuccessStatus,
  schema: z.ZodType,
  body: unknown,
  options: SuccessResponseOptions = {},
): void {
  if (res.headersSent || res.writableEnded || res.destroyed) {
    log().error(
      {
        event: 'api.success.double-write',
        status,
        handler: options.handler,
      },
      'successResponse called after headers already sent — suppressed',
    );
    apiErrorCounter().add(1, {
      type: 'urn:ok:error:internal-server-error',
      ...(options.handler ? { handler: options.handler } : {}),
    });
    return;
  }

  const validated = schema.safeParse(body);
  if (!validated.success) {
    log().error(
      {
        event: 'api.success.malformed-body',
        issues: validated.error.issues,
        bodyKeys: typeof body === 'object' && body !== null ? Object.keys(body) : null,
        handler: options.handler,
        originalStatus: status,
      },
      'successResponse produced an invalid body for the supplied schema — emitting fallback',
    );
    errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
      handler: options.handler,
    });
    return;
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(validated.data);
  } catch (stringifyErr) {
    log().error(
      {
        event: 'api.success.unserializable-body',
        bodyKeys:
          typeof validated.data === 'object' && validated.data !== null
            ? Object.keys(validated.data)
            : null,
        handler: options.handler,
        originalStatus: status,
        err: stringifyErr,
      },
      'successResponse parsed body is not JSON-serializable — emitting fallback',
    );
    errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Internal server error.', {
      handler: options.handler,
    });
    return;
  }
  res.writeHead(status, {
    ...options.extraHeaders,
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(serialized);
}
