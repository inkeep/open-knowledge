
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import {
  type ProblemDetails,
  ProblemDetailsSchema,
  type ProblemType,
  type StreamingProblemEvent,
  StreamingProblemEventSchema,
} from '@inkeep/open-knowledge-core';
import type { Counter } from '@opentelemetry/api';
import { getLogger } from '../logger.ts';
import { getMeter } from '../telemetry.ts';

const log = (): ReturnType<typeof getLogger> => getLogger('http');

export type HttpErrorStatus =
  | 400
  | 401
  | 403
  | 404
  | 405
  | 408
  | 409
  | 413
  | 415
  | 422
  | 429
  | 500
  | 502
  | 503
  | 504
  | 507;

let _apiErrorCounter: Counter | null = null;
export function apiErrorCounter(): Counter {
  _apiErrorCounter ||= getMeter().createCounter('ok.api.error.count', {
    description: 'API error responses by problem type and handler',
    unit: '1',
  });
  return _apiErrorCounter;
}

interface ErrorResponseOptions {
  handler?: string;
  instance?: string;
  detail?: string;
  extensions?: Record<string, unknown> & {
    [K in 'type' | 'title' | 'status' | 'instance' | 'detail']?: never;
  };
  extraHeaders?: Record<string, string>;
  cause?: unknown;
}

type StreamingErrorOptions = Pick<
  ErrorResponseOptions,
  'instance' | 'handler' | 'detail' | 'cause'
>;

export function errorResponse(
  res: ServerResponse,
  status: HttpErrorStatus,
  type: ProblemType,
  title: string,
  options: ErrorResponseOptions = {},
): void {
  const instance = options.instance ?? `urn:uuid:${randomUUID()}`;

  if (res.headersSent || res.writableEnded || res.destroyed) {
    log().error(
      {
        event: 'api.error.double-write',
        instance,
        type,
        status,
        handler: options.handler,
      },
      'errorResponse called after headers already sent — suppressed',
    );
    apiErrorCounter().add(1, {
      type: 'urn:ok:error:internal-server-error',
      ...(options.handler ? { handler: options.handler } : {}),
    });
    return;
  }

  const body: ProblemDetails = {
    type,
    title,
    status,
    instance,
    detail: options.detail ?? undefined,
  };
  const validated = ProblemDetailsSchema.safeParse(body);
  if (!validated.success) {
    log().error(
      {
        event: 'api.error.malformed-envelope',
        issues: validated.error.issues,
        body,
        handler: options.handler,
        originalStatus: status,
      },
      'errorResponse produced an invalid ProblemDetails body — emitting fallback',
    );
    const fallbackStatus = 500 as const;
    apiErrorCounter().add(1, {
      type: 'urn:ok:error:internal-server-error',
      ...(options.handler ? { handler: options.handler } : {}),
    });
    res.writeHead(fallbackStatus, {
      'Content-Type': 'application/problem+json',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(
      JSON.stringify({
        type: 'urn:ok:error:internal-server-error' satisfies ProblemType,
        title: 'Internal server error.',
        status: fallbackStatus,
        instance,
      }),
    );
    return;
  }

  const wireBody: Record<string, unknown> = options.extensions
    ? { ...options.extensions, ...body }
    : body;

  apiErrorCounter().add(1, {
    type,
    ...(options.handler ? { handler: options.handler } : {}),
  });

  const logLevel = status >= 500 ? 'error' : 'warn';
  log()[logLevel](
    {
      event: 'api.error',
      instance,
      type,
      status,
      handler: options.handler,
      detail: options.detail,
      err: options.cause,
    },
    title,
  );

  let serialized: string;
  try {
    serialized = JSON.stringify(wireBody);
  } catch (stringifyErr) {
    log().error(
      {
        event: 'api.error.unserializable-body',
        bodyKeys: Object.keys(wireBody),
        handler: options.handler,
        originalStatus: status,
        instance,
        err: stringifyErr,
      },
      'errorResponse wireBody is not JSON-serializable — emitting hardcoded fallback',
    );
    apiErrorCounter().add(1, {
      type: 'urn:ok:error:internal-server-error',
      ...(options.handler ? { handler: options.handler } : {}),
    });
    res.writeHead(500, {
      'Content-Type': 'application/problem+json',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(
      JSON.stringify({
        type: 'urn:ok:error:internal-server-error' satisfies ProblemType,
        title: 'Internal server error.',
        status: 500,
        instance,
      }),
    );
    return;
  }
  res.writeHead(status, {
    ...options.extraHeaders,
    'Content-Type': 'application/problem+json',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(serialized);
}

export function streamingProblemEvent(
  status: HttpErrorStatus,
  type: ProblemType,
  title: string,
  options: StreamingErrorOptions = {},
): StreamingProblemEvent {
  const instance = options.instance ?? `urn:uuid:${randomUUID()}`;
  const problem: ProblemDetails = {
    type,
    title,
    status,
    instance,
    detail: options.detail ?? undefined,
  };
  const event: StreamingProblemEvent = { type: 'error', problem };
  const validated = StreamingProblemEventSchema.safeParse(event);
  if (!validated.success) {
    log().error(
      {
        event: 'api.streaming.malformed-envelope',
        issues: validated.error.issues,
        body: event,
        handler: options.handler,
        originalStatus: status,
      },
      'streamingProblemEvent produced an invalid StreamingProblemEvent — returning fallback',
    );
    const fallbackStatus = 500 as const;
    apiErrorCounter().add(1, {
      type: 'urn:ok:error:internal-server-error',
      ...(options.handler ? { handler: options.handler } : {}),
    });
    return {
      type: 'error',
      problem: {
        type: 'urn:ok:error:internal-server-error',
        title: 'Internal server error.',
        status: fallbackStatus,
        instance,
      },
    };
  }

  apiErrorCounter().add(1, {
    type,
    ...(options.handler ? { handler: options.handler } : {}),
  });

  const logLevel = status >= 500 ? 'error' : 'warn';
  log()[logLevel](
    {
      event: 'api.streaming.error',
      instance,
      type,
      status,
      handler: options.handler,
      detail: options.detail,
      err: options.cause,
    },
    title,
  );

  return event;
}

export function createStreamingErrorWriter(
  res: ServerResponse,
  handler: string,
): (
  status: HttpErrorStatus,
  type: ProblemType,
  title: string,
  options?: { detail?: string; cause?: unknown },
) => void {
  return (status, type, title, options = {}) => {
    if (res.writableEnded || res.destroyed) {
      log().error(
        {
          event: 'api.streaming.error.suppressed',
          type,
          status,
          handler,
          detail: options.detail,
          err: options.cause,
        },
        'createStreamingErrorWriter called after writableEnded/destroyed — suppressed',
      );
      apiErrorCounter().add(1, {
        type: 'urn:ok:error:internal-server-error',
        ...(handler ? { handler } : {}),
      });
      return;
    }
    const event = streamingProblemEvent(status, type, title, { handler, ...options });
    try {
      res.write(`${JSON.stringify(event)}\n`);
    } catch (writeErr) {
      log().error(
        {
          event: 'api.streaming.error.write-failed',
          type,
          status,
          handler,
          err: options.cause,
          writeErr,
        },
        'createStreamingErrorWriter: res.write threw — original error preserved in log',
      );
    }
  };
}

export function _resetApiErrorCounterForTest(): void {
  _apiErrorCounter = null;
}
