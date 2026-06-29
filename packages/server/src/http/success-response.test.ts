
import { describe, expect, spyOn, test } from 'bun:test';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import { loggerFactory } from '../logger.ts';
import { successResponse } from './success-response.ts';

function isObjLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function makeMockRes(
  opts: { headersSent?: boolean; writableEnded?: boolean; destroyed?: boolean } = {},
) {
  const writeHeadCalls: Array<{ status: number; headers: Record<string, string> }> = [];
  const endCalls: string[] = [];
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
  };
  return { res: res as unknown as ServerResponse, writeHeadCalls, endCalls };
}

describe('successResponse — happy path', () => {
  test('emits Content-Type: application/json + JSON body matching schema', () => {
    const Schema = z.object({ docName: z.string(), content: z.string() });
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    successResponse(res, 200, Schema, { docName: 'a.md', content: 'hello' }, { handler: 'test' });
    expect(writeHeadCalls.length).toBe(1);
    expect(writeHeadCalls[0].status).toBe(200);
    expect(writeHeadCalls[0].headers['Content-Type']).toBe('application/json');
    expect(writeHeadCalls[0].headers['X-Content-Type-Options']).toBe('nosniff');
    expect(endCalls.length).toBe(1);
    const parsed = JSON.parse(endCalls[0]);
    expect(parsed).toEqual({ docName: 'a.md', content: 'hello' });
  });

  test('accepts 201 (Created) status code', () => {
    const Schema = z.object({ id: z.string() });
    const { res, writeHeadCalls } = makeMockRes();
    successResponse(res, 201, Schema, { id: 'new-id' });
    expect(writeHeadCalls.length).toBe(1);
    expect(writeHeadCalls[0].status).toBe(201);
  });

  test('accepts 202 (Accepted) status code for async-accepted patterns', () => {
    const Schema = z.object({ sessionId: z.string() });
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    successResponse(res, 202, Schema, { sessionId: 's-1' });
    expect(writeHeadCalls.length).toBe(1);
    expect(writeHeadCalls[0].status).toBe(202);
    expect(JSON.parse(endCalls[0])).toEqual({ sessionId: 's-1' });
  });

  test('empty-body success with z.object({}).loose() schema emits {}', () => {
    const Schema = z.object({}).loose();
    const { res, endCalls } = makeMockRes();
    successResponse(res, 200, Schema, {});
    expect(endCalls.length).toBe(1);
    expect(endCalls[0]).toBe('{}');
  });

  test('.loose() schema preserves extra fields on the wire (forward-compat)', () => {
    const Schema = z.object({ id: z.string() }).loose();
    const { res, endCalls } = makeMockRes();
    successResponse(res, 200, Schema, {
      id: 'x',
      extraField: 42,
      newServerField: 'forward-compat',
    } as { id: string });
    const parsed = JSON.parse(endCalls[0]);
    expect(parsed).toEqual({ id: 'x', extraField: 42, newServerField: 'forward-compat' });
  });
});

describe('successResponse — defense-in-depth branches', () => {
  test('headersSent: true → writeHead never called (suppressed double-write)', () => {
    const log = loggerFactory.getLogger('http');
    const errorSpy = spyOn(log, 'error');
    errorSpy.mockClear();

    const Schema = z.object({ x: z.number() });
    const { res, writeHeadCalls, endCalls } = makeMockRes({ headersSent: true });
    successResponse(res, 200, Schema, { x: 1 }, { handler: 'test' });
    expect(writeHeadCalls.length).toBe(0);
    expect(endCalls.length).toBe(0);
    expect(errorSpy).toHaveBeenCalled();
    const event = errorSpy.mock.calls.find(
      ([arg]) => isObjLike(arg) && arg.event === 'api.success.double-write',
    );
    expect(event).toBeDefined();
  });

  test('writableEnded: true → writeHead never called (suppressed post-end double-write)', () => {
    const Schema = z.object({ x: z.number() });
    const { res, writeHeadCalls, endCalls } = makeMockRes({ writableEnded: true });
    successResponse(res, 200, Schema, { x: 1 }, { handler: 'test' });
    expect(writeHeadCalls.length).toBe(0);
    expect(endCalls.length).toBe(0);
  });

  test('destroyed: true → writeHead never called (TCP RST / abrupt client disconnect)', () => {
    const Schema = z.object({ x: z.number() });
    const { res, writeHeadCalls, endCalls } = makeMockRes({ destroyed: true });
    successResponse(res, 200, Schema, { x: 1 }, { handler: 'test' });
    expect(writeHeadCalls.length).toBe(0);
    expect(endCalls.length).toBe(0);
  });

  test('schema-parse failure → emits 500 problem+json via errorResponse fallback', () => {
    const Schema = z.object({ x: z.number() });
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    successResponse(res, 200, Schema, { x: 'not-a-number' }, { handler: 'test' });
    expect(writeHeadCalls.length).toBe(1);
    expect(writeHeadCalls[0].status).toBe(500);
    expect(writeHeadCalls[0].headers['Content-Type']).toBe('application/problem+json');
    expect(endCalls.length).toBe(1);
    const body = JSON.parse(endCalls[0]);
    expect(body.type).toBe('urn:ok:error:internal-server-error');
    expect(body.title).toBe('Internal server error.');
    expect(body.status).toBe(500);
    expect(typeof body.instance).toBe('string');
    expect(body.instance).toMatch(/^urn:uuid:/);
    expect(body.x).toBeUndefined();
  });

  test('extraHeaders cannot override security defaults (Content-Type, X-Content-Type-Options)', () => {
    const Schema = z.object({ src: z.string() });
    const { res, writeHeadCalls } = makeMockRes();
    successResponse(
      res,
      200,
      Schema,
      { src: 'attachments/photo.png' },
      {
        handler: 'upload-asset',
        extraHeaders: {
          'Cache-Control': 'no-store',
          'Content-Type': 'text/html',
          'X-Content-Type-Options': 'sniff',
        },
      },
    );
    expect(writeHeadCalls.length).toBe(1);
    const headers = writeHeadCalls[0].headers;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Cache-Control']).toBe('no-store');
  });

  test('schema-parse failure logs bodyKeys (field names) without body values for data-leak hygiene', () => {
    const log = loggerFactory.getLogger('http');
    const errorSpy = spyOn(log, 'error');
    errorSpy.mockClear();

    const Schema = z.object({ x: z.number() });
    const sensitiveBody = {
      x: 'sensitive-value-that-must-not-be-logged',
      contributorEmail: 'alice@private.example',
    };
    const { res } = makeMockRes();
    successResponse(res, 200, Schema, sensitiveBody, { handler: 'test' });

    const malformed = errorSpy.mock.calls.find((c) => {
      const arg0 = c[0];
      return isObjLike(arg0) && arg0.event === 'api.success.malformed-body';
    });
    expect(malformed).toBeDefined();
    const data = malformed?.[0];
    expect(isObjLike(data)).toBe(true);
    if (!isObjLike(data)) throw new Error('unreachable');

    expect(data.bodyKeys).toEqual(['x', 'contributorEmail']);
    expect(data).not.toHaveProperty('body');
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain('sensitive-value-that-must-not-be-logged');
    expect(serialized).not.toContain('alice@private.example');
    expect(data.issues).toBeDefined();

    errorSpy.mockRestore();
  });

  test('unserializable parsed body (circular ref) → 500 problem+json fallback with errorResponse delegation', () => {
    const log = loggerFactory.getLogger('http');
    const errorSpy = spyOn(log, 'error');
    errorSpy.mockClear();

    const Schema = z.object({ checkpoint: z.unknown().nullable() });
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    successResponse(res, 200, Schema, { checkpoint: circular }, { handler: 'history' });

    expect(writeHeadCalls.length).toBe(1);
    expect(writeHeadCalls[0].status).toBe(500);
    expect(writeHeadCalls[0].headers['Content-Type']).toBe('application/problem+json');
    expect(writeHeadCalls[0].headers['X-Content-Type-Options']).toBe('nosniff');
    expect(endCalls.length).toBe(1);
    const body = JSON.parse(endCalls[0]);
    expect(body.type).toBe('urn:ok:error:internal-server-error');
    expect(body.title).toBe('Internal server error.');
    expect(body.status).toBe(500);
    expect(typeof body.instance).toBe('string');
    expect(body.instance).toMatch(/^urn:uuid:/);

    const unserializable = errorSpy.mock.calls.find((c) => {
      const arg0 = c[0];
      return isObjLike(arg0) && arg0.event === 'api.success.unserializable-body';
    });
    expect(unserializable).toBeDefined();
    const data = unserializable?.[0];
    if (!isObjLike(data)) throw new Error('unreachable');
    expect(data.bodyKeys).toEqual(['checkpoint']);
    expect(data.handler).toBe('history');
    expect(data.originalStatus).toBe(200);

    errorSpy.mockRestore();
  });

  test('schema-parse failure with non-object body logs bodyKeys: null', () => {
    const log = loggerFactory.getLogger('http');
    const errorSpy = spyOn(log, 'error');
    errorSpy.mockClear();

    const Schema = z.object({ x: z.number() });
    const { res } = makeMockRes();
    successResponse(res, 200, Schema, 'leaky-string-body', { handler: 'test' });

    const malformed = errorSpy.mock.calls.find((c) => {
      const arg0 = c[0];
      return isObjLike(arg0) && arg0.event === 'api.success.malformed-body';
    });
    expect(malformed).toBeDefined();
    const data = malformed?.[0];
    if (!isObjLike(data)) throw new Error('unreachable');
    expect(data.bodyKeys).toBeNull();
    expect(JSON.stringify(data)).not.toContain('leaky-string-body');

    errorSpy.mockRestore();
  });

  test('case-variant header overrides cannot defeat security defaults', () => {
    const Schema = z.object({ src: z.string() });
    const { res, writeHeadCalls } = makeMockRes();
    successResponse(
      res,
      200,
      Schema,
      { src: 'attachments/photo.png' },
      {
        extraHeaders: {
          'Cache-Control': 'no-store',
          'content-type': 'text/html',
          'x-content-type-options': 'sniff',
        },
      },
    );
    expect(writeHeadCalls.length).toBe(1);
    const headers = writeHeadCalls[0].headers;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Cache-Control']).toBe('no-store');
  });
});
