
import { describe, expect, spyOn, test } from 'bun:test';
import type { ServerResponse } from 'node:http';
import { loggerFactory } from '../logger.ts';
import {
  createStreamingErrorWriter,
  errorResponse,
  streamingProblemEvent,
} from './error-response.ts';

function isObjLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function makeMockRes(
  opts: { headersSent?: boolean; writableEnded?: boolean; destroyed?: boolean } = {},
) {
  const writeHeadCalls: Array<{ status: number; headers: Record<string, string> }> = [];
  const endCalls: string[] = [];
  const writeCalls: string[] = [];
  const res = {
    headersSent: opts.headersSent ?? false,
    writableEnded: opts.writableEnded ?? false,
    destroyed: opts.destroyed ?? false,
    writeHead(status: number, headers: Record<string, string>) {
      writeHeadCalls.push({ status, headers });
      return res;
    },
    end(body: string) {
      endCalls.push(body);
      return res;
    },
    write(chunk: string) {
      writeCalls.push(chunk);
      return true;
    },
  };
  return { res: res as unknown as ServerResponse, writeHeadCalls, endCalls, writeCalls };
}

describe('errorResponse — defense-in-depth branches', () => {
  test('headersSent: true → writeHead never called (suppressed double-write)', () => {
    const log = loggerFactory.getLogger('http');
    const errorSpy = spyOn(log, 'error');
    errorSpy.mockClear();

    const { res, writeHeadCalls, endCalls } = makeMockRes({ headersSent: true });
    errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Anything.', {
      handler: 'test',
    });
    expect(writeHeadCalls.length).toBe(0);
    expect(endCalls.length).toBe(0);
    expect(errorSpy).toHaveBeenCalled();
    const event = errorSpy.mock.calls.find(
      ([arg]) => isObjLike(arg) && arg.event === 'api.error.double-write',
    );
    expect(event).toBeDefined();
  });

  test('writableEnded: true → writeHead never called (suppressed post-end double-write)', () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes({ writableEnded: true });
    errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Anything.', {
      handler: 'test',
    });
    expect(writeHeadCalls.length).toBe(0);
    expect(endCalls.length).toBe(0);
  });

  test('destroyed: true → writeHead never called (TCP RST / abrupt client disconnect)', () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes({ destroyed: true });
    errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Anything.', {
      handler: 'test',
    });
    expect(writeHeadCalls.length).toBe(0);
    expect(endCalls.length).toBe(0);
  });

  test('status-conditional log level: 4xx → log.warn, 5xx → log.error', () => {
    const log = loggerFactory.getLogger('http');
    const warnSpy = spyOn(log, 'warn');
    const errorSpy = spyOn(log, 'error');
    warnSpy.mockClear();
    errorSpy.mockClear();

    const ctx4xx = makeMockRes();
    errorResponse(ctx4xx.res, 404, 'urn:ok:error:doc-not-found', 'Not found.', {
      handler: 'test',
    });
    const warn4xx = warnSpy.mock.calls.find(
      ([arg]) => isObjLike(arg) && arg.event === 'api.error' && arg.status === 404,
    );
    expect(warn4xx).toBeDefined();

    warnSpy.mockClear();
    errorSpy.mockClear();

    const ctx5xx = makeMockRes();
    errorResponse(ctx5xx.res, 500, 'urn:ok:error:internal-server-error', 'Bang.', {
      handler: 'test',
    });
    const error5xx = errorSpy.mock.calls.find(
      ([arg]) => isObjLike(arg) && arg.event === 'api.error' && arg.status === 500,
    );
    expect(error5xx).toBeDefined();
    const warn5xx = warnSpy.mock.calls.find(
      ([arg]) => isObjLike(arg) && arg.event === 'api.error' && arg.status === 500,
    );
    expect(warn5xx).toBeUndefined();
  });

  test('empty title (min(1) violation) → emits fallback urn:ok:error:internal-server-error', () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    errorResponse(res, 500, 'urn:ok:error:internal-server-error', '', {
      handler: 'test',
    });
    expect(writeHeadCalls.length).toBe(1);
    expect(writeHeadCalls[0].status).toBe(500);
    expect(writeHeadCalls[0].headers['Content-Type']).toBe('application/problem+json');
    expect(endCalls.length).toBe(1);
    const body = JSON.parse(endCalls[0]);
    expect(body.type).toBe('urn:ok:error:internal-server-error');
    expect(body.title).toBe('Internal server error.');
    expect(body.status).toBe(500);
    expect(typeof body.instance).toBe('string');
  });

  test('malformed envelope at 4xx: fallback overrides HTTP status to 500 for type/status coherence', () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    errorResponse(res, 404, 'urn:ok:error:doc-not-found', '', { handler: 'test' });
    expect(writeHeadCalls.length).toBe(1);
    expect(writeHeadCalls[0].status).toBe(500);
    const body = JSON.parse(endCalls[0]);
    expect(body.type).toBe('urn:ok:error:internal-server-error');
    expect(body.status).toBe(500);
  });

  test('happy path: well-formed call writes single problem+json response', () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    errorResponse(res, 400, 'urn:ok:error:invalid-request', 'Bad input.', {
      handler: 'test',
      detail: 'Field x is required.',
    });
    expect(writeHeadCalls.length).toBe(1);
    expect(writeHeadCalls[0].status).toBe(400);
    expect(writeHeadCalls[0].headers['Content-Type']).toBe('application/problem+json');
    expect(writeHeadCalls[0].headers['X-Content-Type-Options']).toBe('nosniff');
    const body = JSON.parse(endCalls[0]);
    expect(body.type).toBe('urn:ok:error:invalid-request');
    expect(body.title).toBe('Bad input.');
    expect(body.detail).toBe('Field x is required.');
    expect(body.status).toBe(400);
    expect(body.instance).toMatch(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  test('cause carrying filesystem path does not leak to wire body — only detail surfaces', () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    const fsErr = new Error(
      "EACCES: permission denied, open '/Users/alice/secrets/api-keys.tmp.4432.99124'",
    );
    errorResponse(res, 500, 'urn:ok:error:internal-server-error', 'Failed to write template.', {
      handler: 'template-put',
      detail: 'WRITE_ERROR',
      cause: fsErr,
    });
    expect(writeHeadCalls.length).toBe(1);
    expect(writeHeadCalls[0].status).toBe(500);
    const body = JSON.parse(endCalls[0]);
    expect(body.detail).toBe('WRITE_ERROR');
    const wireSerialized = endCalls[0];
    expect(wireSerialized).not.toContain('/Users/alice/secrets');
    expect(wireSerialized).not.toContain('EACCES');
    expect(body).not.toHaveProperty('cause');
    expect(body).not.toHaveProperty('err');
  });

  test('extraHeaders cannot override security defaults (Content-Type, X-Content-Type-Options)', () => {
    const { res, writeHeadCalls } = makeMockRes();
    errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
      handler: 'test',
      extraHeaders: {
        Allow: 'GET',
        'X-Content-Type-Options': 'sniff',
        'Content-Type': 'text/html',
      },
    });
    expect(writeHeadCalls.length).toBe(1);
    const headers = writeHeadCalls[0].headers;
    expect(headers['Content-Type']).toBe('application/problem+json');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers.Allow).toBe('GET');
  });

  test('case-variant header overrides cannot defeat security defaults', () => {
    const { res, writeHeadCalls } = makeMockRes();
    errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
      handler: 'test',
      extraHeaders: {
        Allow: 'GET',
        'content-type': 'text/html',
        'x-content-type-options': 'sniff',
      },
    });
    expect(writeHeadCalls.length).toBe(1);
    const headers = writeHeadCalls[0].headers;
    expect(headers['Content-Type']).toBe('application/problem+json');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers.Allow).toBe('GET');
  });

  test('unserializable extensions (circular ref) → 500 problem+json fallback with caller instance preserved', () => {
    const log = loggerFactory.getLogger('http');
    const errorSpy = spyOn(log, 'error');
    errorSpy.mockClear();

    const { res, writeHeadCalls, endCalls } = makeMockRes();
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const fixedInstance = 'urn:uuid:11111111-2222-3333-4444-555555555555';
    errorResponse(res, 409, 'urn:ok:error:doc-already-exists', 'Doc already exists.', {
      handler: 'test',
      instance: fixedInstance,
      extensions: { circular },
      extraHeaders: { Allow: 'GET, POST', 'Retry-After': '5' },
    });

    expect(writeHeadCalls.length).toBe(1);
    expect(writeHeadCalls[0].status).toBe(500);
    expect(writeHeadCalls[0].headers['Content-Type']).toBe('application/problem+json');
    expect(writeHeadCalls[0].headers['X-Content-Type-Options']).toBe('nosniff');
    expect(writeHeadCalls[0].headers).not.toHaveProperty('Allow');
    expect(writeHeadCalls[0].headers).not.toHaveProperty('Retry-After');
    expect(endCalls.length).toBe(1);
    const body = JSON.parse(endCalls[0]);
    expect(body.type).toBe('urn:ok:error:internal-server-error');
    expect(body.title).toBe('Internal server error.');
    expect(body.status).toBe(500);
    expect(body.instance).toBe(fixedInstance);

    const unserializable = errorSpy.mock.calls.find((c) => {
      const arg0 = c[0];
      return isObjLike(arg0) && arg0.event === 'api.error.unserializable-body';
    });
    expect(unserializable).toBeDefined();
    const data = unserializable?.[0];
    if (!isObjLike(data)) throw new Error('unreachable');
    expect(data.bodyKeys).toEqual(
      expect.arrayContaining(['circular', 'type', 'title', 'status', 'instance']),
    );
    expect(data.handler).toBe('test');
    expect(data.originalStatus).toBe(409);
    expect(data.instance).toBe(fixedInstance);

    errorSpy.mockRestore();
  });

  test('extension members merge with canonical body — caller cannot override type/title/status/instance/detail', () => {
    const { res, endCalls } = makeMockRes();
    errorResponse(res, 409, 'urn:ok:error:doc-already-exists', 'Doc already exists.', {
      handler: 'test',
      extensions: {
        colliding: [{ existing: 'a.md', incoming: 'A.md', to: 'A.md' }],
        type: 'urn:ok:error:hostile-override' as unknown,
        title: 'Hostile title.' as unknown,
        status: 200 as unknown,
        instance: 'attacker-controlled' as unknown,
        detail: 'Attacker detail.' as unknown,
      } as Record<string, unknown> & {
        [K in 'type' | 'title' | 'status' | 'instance' | 'detail']?: never;
      },
    });
    const body = JSON.parse(endCalls[0]);
    expect(body.type).toBe('urn:ok:error:doc-already-exists');
    expect(body.title).toBe('Doc already exists.');
    expect(body.status).toBe(409);
    expect(body.detail).toBeUndefined();
    expect(typeof body.instance).toBe('string');
    expect(body.instance).not.toBe('attacker-controlled');
    expect(body.colliding).toEqual([{ existing: 'a.md', incoming: 'A.md', to: 'A.md' }]);
  });
});

describe('streamingProblemEvent — defense-in-depth fallback', () => {
  test('empty title (min(1) violation) → returns fallback event', () => {
    const event = streamingProblemEvent(500, 'urn:ok:error:internal-server-error', '', {
      handler: 'test',
    });
    expect(event.type).toBe('error');
    expect(event.problem.type).toBe('urn:ok:error:internal-server-error');
    expect(event.problem.title).toBe('Internal server error.');
    expect(event.problem.status).toBe(500);
    expect(typeof event.problem.instance).toBe('string');
  });

  test('malformed envelope at 4xx: fallback overrides problem.status to 500 for type/status coherence', () => {
    const event = streamingProblemEvent(404, 'urn:ok:error:doc-not-found', '', { handler: 'test' });
    expect(event.problem.type).toBe('urn:ok:error:internal-server-error');
    expect(event.problem.status).toBe(500);
  });

  test('happy path: well-formed call returns the typed event', () => {
    const event = streamingProblemEvent(503, 'urn:ok:error:sync-not-active', 'Sync engine off.', {
      handler: 'test',
      detail: 'Sync engine is not active in this environment.',
    });
    expect(event.type).toBe('error');
    expect(event.problem.type).toBe('urn:ok:error:sync-not-active');
    expect(event.problem.title).toBe('Sync engine off.');
    expect(event.problem.detail).toBe('Sync engine is not active in this environment.');
    expect(event.problem.status).toBe(503);
    expect(event.problem.instance).toMatch(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  test('detail field present when provided', () => {
    const event = streamingProblemEvent(500, 'urn:ok:error:clone-failed', 'Clone failed.', {
      handler: 'test',
      detail: 'fatal: repository not found',
    });
    expect(event.problem.detail).toBe('fatal: repository not found');
  });

  test('detail field absent when not provided', () => {
    const event = streamingProblemEvent(500, 'urn:ok:error:clone-failed', 'Clone failed.', {
      handler: 'test',
    });
    expect(event.problem.detail).toBeUndefined();
    expect(JSON.stringify(event.problem)).not.toContain('"detail"');
  });
});

describe('createStreamingErrorWriter — writableEnded guard', () => {
  test('writableEnded: true → write never called (suppressed mid-stream double-emit)', () => {
    const { res, writeCalls } = makeMockRes({ writableEnded: true });
    const writer = createStreamingErrorWriter(res, 'test');
    writer(500, 'urn:ok:error:internal-server-error', 'Whatever.');
    expect(writeCalls.length).toBe(0);
  });

  test('destroyed: true → write never called (TCP RST / abrupt client disconnect)', () => {
    const { res, writeCalls } = makeMockRes({ destroyed: true });
    const writer = createStreamingErrorWriter(res, 'test');
    writer(500, 'urn:ok:error:internal-server-error', 'Whatever.');
    expect(writeCalls.length).toBe(0);
  });

  test('res.write throws → caught + logged, original cause preserved', () => {
    const { res } = makeMockRes();
    res.write = (() => {
      throw new Error('ERR_STREAM_DESTROYED');
    }) as typeof res.write;
    const writer = createStreamingErrorWriter(res, 'test');
    expect(() =>
      writer(500, 'urn:ok:error:internal-server-error', 'Real error.', {
        cause: new Error('original-failure'),
      }),
    ).not.toThrow();
  });

  test('writableEnded: false → emits one NDJSON line with typed event', () => {
    const { res, writeCalls } = makeMockRes();
    const writer = createStreamingErrorWriter(res, 'test');
    writer(500, 'urn:ok:error:internal-server-error', 'Real error.');
    expect(writeCalls.length).toBe(1);
    expect(writeCalls[0].endsWith('\n')).toBe(true);
    const event = JSON.parse(writeCalls[0].trimEnd());
    expect(event.type).toBe('error');
    expect(event.problem.type).toBe('urn:ok:error:internal-server-error');
    expect(event.problem.title).toBe('Real error.');
  });

  test('headersSent: true (normal mid-stream state) → write proceeds (asymmetry vs sync)', () => {
    const { res, writeCalls } = makeMockRes({ headersSent: true });
    const writer = createStreamingErrorWriter(res, 'test');
    writer(500, 'urn:ok:error:internal-server-error', 'Mid-stream error.');
    expect(writeCalls.length).toBe(1);
  });
});
