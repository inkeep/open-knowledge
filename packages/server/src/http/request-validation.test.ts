import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import {
  isJsonContentType,
  PayloadTooLargeError,
  RequestBodyTimeoutError,
  readBoundedJsonBody,
  UnsupportedMediaTypeError,
  validateBody,
  withValidation,
} from './request-validation.ts';

function makeMockRes() {
  const writeHeadCalls: Array<{ status: number; headers: Record<string, string> }> = [];
  const endCalls: string[] = [];
  const res = {
    headersSent: false,
    writableEnded: false,
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

interface MockReqOptions {
  method?: string;
  chunks?: Buffer[];
  throwOnRead?: Error;
  headers?: Record<string, string>;
}

function makeMockReq(opts: MockReqOptions = {}): IncomingMessage {
  return {
    method: opts.method ?? 'POST',
    headers: opts.headers ?? {},
    destroy(_err?: Error) {},
    [Symbol.asyncIterator]: async function* () {
      if (opts.throwOnRead) {
        throw opts.throwOnRead;
      }
      for (const chunk of opts.chunks ?? []) {
        yield chunk;
      }
    },
  } as unknown as IncomingMessage;
}

const TestSchema = z.object({ foo: z.string() });

describe('withValidation — branch coverage', () => {
  test('method mismatch → 405 with Allow header', async () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    let handlerCalled = false;
    const wrapped = withValidation(
      TestSchema,
      async () => {
        handlerCalled = true;
      },
      { handler: 'test', method: 'POST' },
    );
    await wrapped(makeMockReq({ method: 'GET' }), res);
    expect(handlerCalled).toBe(false);
    expect(writeHeadCalls.length).toBe(1);
    expect(writeHeadCalls[0].status).toBe(405);
    expect(writeHeadCalls[0].headers.Allow).toBe('POST');
    const body = JSON.parse(endCalls[0]);
    expect(body.type).toBe('urn:ok:error:method-not-allowed');
  });

  test('method option omitted → accepts any HTTP method', async () => {
    const { res, writeHeadCalls } = makeMockRes();
    let handlerCalled = false;
    const wrapped = withValidation(
      TestSchema,
      async (_req, _res, body) => {
        handlerCalled = true;
        expect(body.foo).toBe('bar');
      },
      { handler: 'test' },
    );
    await wrapped(makeMockReq({ method: 'DELETE', chunks: [Buffer.from('{"foo":"bar"}')] }), res);
    expect(handlerCalled).toBe(true);
    expect(writeHeadCalls.length).toBe(0);
  });

  test('preBodyGate returns false WITHOUT writing → safety-net 500 emitted', async () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    let bodyConsumed = false;
    let handlerCalled = false;
    const req = {
      method: 'POST',
      destroy() {},
      [Symbol.asyncIterator]: async function* () {
        bodyConsumed = true;
        yield Buffer.from('{}');
      },
    } as unknown as IncomingMessage;
    const wrapped = withValidation(
      TestSchema,
      async () => {
        handlerCalled = true;
      },
      {
        handler: 'test',
        preBodyGate: (_req, _res) => false,
      },
    );
    await wrapped(req, res);
    expect(bodyConsumed).toBe(false);
    expect(handlerCalled).toBe(false);
    expect(writeHeadCalls.length).toBe(1);
    expect(writeHeadCalls[0].status).toBe(500);
    const body = JSON.parse(endCalls[0]);
    expect(body.type).toBe('urn:ok:error:internal-server-error');
    expect(body.title).toBe('Internal server error.');
    expect(body.detail).toBeUndefined();
  });

  test('preBodyGate writes 403 then returns false → no safety-net, gate emission preserved', async () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    let bodyConsumed = false;
    let handlerCalled = false;
    const req = {
      method: 'POST',
      destroy() {},
      [Symbol.asyncIterator]: async function* () {
        bodyConsumed = true;
        yield Buffer.from('{}');
      },
    } as unknown as IncomingMessage;
    const wrapped = withValidation(
      TestSchema,
      async () => {
        handlerCalled = true;
      },
      {
        handler: 'test',
        preBodyGate: (_req, gateRes) => {
          gateRes.writeHead(403, { 'Content-Type': 'application/problem+json' });
          gateRes.end(JSON.stringify({ type: 'urn:ok:error:forbidden', title: 'Forbidden.' }));
          (gateRes as unknown as { writableEnded: boolean }).writableEnded = true;
          return false;
        },
      },
    );
    await wrapped(req, res);
    expect(bodyConsumed).toBe(false);
    expect(handlerCalled).toBe(false);
    expect(writeHeadCalls.length).toBe(1);
    expect(writeHeadCalls[0].status).toBe(403);
    const body = JSON.parse(endCalls[0]);
    expect(body.type).toBe('urn:ok:error:forbidden');
  });

  test('preBodyGate returning true → proceeds to body read + handler', async () => {
    const { res } = makeMockRes();
    let handlerCalled = false;
    const wrapped = withValidation(
      TestSchema,
      async (_req, _res, body) => {
        handlerCalled = true;
        expect(body.foo).toBe('bar');
      },
      {
        handler: 'test',
        preBodyGate: () => true,
      },
    );
    await wrapped(makeMockReq({ chunks: [Buffer.from('{"foo":"bar"}')] }), res);
    expect(handlerCalled).toBe(true);
  });

  test('skipBodyParse:true → handler invoked with empty-validated body, body NOT read', async () => {
    const { res } = makeMockRes();
    let bodyConsumed = false;
    let handlerCalled = false;
    const req = {
      method: 'GET',
      destroy() {},
      [Symbol.asyncIterator]: async function* () {
        bodyConsumed = true;
        yield Buffer.from('this should never be read');
      },
    } as unknown as IncomingMessage;
    const EmptySchema = z.object({}).strict();
    const wrapped = withValidation(
      EmptySchema,
      async () => {
        handlerCalled = true;
      },
      { handler: 'test', method: 'GET', skipBodyParse: true },
    );
    await wrapped(req, res);
    expect(handlerCalled).toBe(true);
    expect(bodyConsumed).toBe(false);
  });

  test('PayloadTooLargeError → 413 urn:ok:error:payload-too-large (mocked throw)', async () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    const wrapped = withValidation(
      TestSchema,
      async () => {
        throw new Error('handler must not run');
      },
      { handler: 'test' },
    );
    await wrapped(makeMockReq({ throwOnRead: new PayloadTooLargeError() }), res);
    expect(writeHeadCalls.length).toBe(1);
    expect(writeHeadCalls[0].status).toBe(413);
    const body = JSON.parse(endCalls[0]);
    expect(body.type).toBe('urn:ok:error:payload-too-large');
    expect(body.title).toBe('Payload too large.');
  });

  test('PayloadTooLargeError → 413 (real bytes — exercises cumulative byte counter)', async () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    const wrapped = withValidation(
      TestSchema,
      async () => {
        throw new Error('handler must not run');
      },
      { handler: 'test' },
    );
    await wrapped(
      makeMockReq({ chunks: [Buffer.alloc(600_000, 0x20), Buffer.alloc(600_000, 0x20)] }),
      res,
    );
    expect(writeHeadCalls.length).toBe(1);
    expect(writeHeadCalls[0].status).toBe(413);
    const body = JSON.parse(endCalls[0]);
    expect(body.type).toBe('urn:ok:error:payload-too-large');
  });

  test('RequestBodyTimeoutError → 408 urn:ok:error:request-timeout', async () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    const wrapped = withValidation(
      TestSchema,
      async () => {
        throw new Error('handler must not run');
      },
      { handler: 'test' },
    );
    await wrapped(makeMockReq({ throwOnRead: new RequestBodyTimeoutError() }), res);
    expect(writeHeadCalls.length).toBe(1);
    expect(writeHeadCalls[0].status).toBe(408);
    const body = JSON.parse(endCalls[0]);
    expect(body.type).toBe('urn:ok:error:request-timeout');
    expect(body.title).toBe('Request body read timed out.');
  });

  test('non-typed read error → 500 urn:ok:error:internal-server-error (transport-class)', async () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    const wrapped = withValidation(
      TestSchema,
      async () => {
        throw new Error('handler must not run');
      },
      { handler: 'test' },
    );
    await wrapped(makeMockReq({ throwOnRead: new Error('socket hangup') }), res);
    expect(writeHeadCalls.length).toBe(1);
    expect(writeHeadCalls[0].status).toBe(500);
    const body = JSON.parse(endCalls[0]);
    expect(body.type).toBe('urn:ok:error:internal-server-error');
    expect(body.title).toBe('Failed to read request body.');
  });

  test('non-JSON body → 400 urn:ok:error:invalid-request "not valid JSON"', async () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    const wrapped = withValidation(
      TestSchema,
      async () => {
        throw new Error('handler must not run');
      },
      { handler: 'test' },
    );
    await wrapped(makeMockReq({ chunks: [Buffer.from('not-json{')] }), res);
    expect(writeHeadCalls.length).toBe(1);
    expect(writeHeadCalls[0].status).toBe(400);
    const body = JSON.parse(endCalls[0]);
    expect(body.type).toBe('urn:ok:error:invalid-request');
    expect(body.title).toBe('Request body is not valid JSON.');
  });

  test('schema validation failure → 400 urn:ok:error:invalid-request with field-path detail', async () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    const wrapped = withValidation(
      TestSchema,
      async () => {
        throw new Error('handler must not run');
      },
      { handler: 'test' },
    );
    await wrapped(makeMockReq({ chunks: [Buffer.from('{"bar":1}')] }), res);
    expect(writeHeadCalls.length).toBe(1);
    expect(writeHeadCalls[0].status).toBe(400);
    const body = JSON.parse(endCalls[0]);
    expect(body.type).toBe('urn:ok:error:invalid-request');
    expect(body.title).toBe('Request body is invalid.');
    expect(typeof body.detail).toBe('string');
    expect(body.detail).toContain('foo');
  });

  test('empty body (Content-Length: 0) → treated as {} → schema validates', async () => {
    const { res } = makeMockRes();
    let receivedBody: unknown = null;
    const EmptySchema = z.object({}).strict();
    const wrapped = withValidation(
      EmptySchema,
      async (_req, _res, body) => {
        receivedBody = body;
      },
      { handler: 'test' },
    );
    await wrapped(makeMockReq({ chunks: [] }), res);
    expect(receivedBody).toEqual({});
  });

  test('empty body + schema requires fields → 400 urn:ok:error:invalid-request', async () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    const wrapped = withValidation(
      TestSchema,
      async () => {
        throw new Error('handler must not run');
      },
      { handler: 'test' },
    );
    await wrapped(makeMockReq({ chunks: [] }), res);
    expect(writeHeadCalls.length).toBe(1);
    expect(writeHeadCalls[0].status).toBe(400);
    const body = JSON.parse(endCalls[0]);
    expect(body.type).toBe('urn:ok:error:invalid-request');
    expect(body.detail).toContain('foo');
  });

  test('inner handler throw propagates — withValidation does not wrap caller exceptions', async () => {
    const { res } = makeMockRes();
    const sentinel = new Error('handler-internal-failure');
    const wrapped = withValidation(
      TestSchema,
      async () => {
        throw sentinel;
      },
      { handler: 'test' },
    );
    let caught: unknown;
    try {
      await wrapped(makeMockReq({ chunks: [Buffer.from(JSON.stringify({ foo: 'ok' }))] }), res);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(sentinel);
  });
});

describe('validateBody — direct unit tests (multipart handler entry point)', () => {
  test('valid input → { ok: true, value } — does not write to res', () => {
    const Schema = z.object({ field: z.string() });
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    const result = validateBody(Schema, { field: 'hello' }, res, { handler: 'test' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ field: 'hello' });
    }
    expect(writeHeadCalls.length).toBe(0);
    expect(endCalls.length).toBe(0);
  });

  test('invalid input → { ok: false } + 400 problem+json with field-path detail', () => {
    const Schema = z.object({ field: z.string() });
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    const result = validateBody(Schema, { field: 123 }, res, { handler: 'test' });
    expect(result.ok).toBe(false);
    expect(writeHeadCalls.length).toBe(1);
    expect(writeHeadCalls[0].status).toBe(400);
    expect(writeHeadCalls[0].headers['Content-Type']).toBe('application/problem+json');
    expect(endCalls.length).toBe(1);
    const body = JSON.parse(endCalls[0]);
    expect(body.type).toBe('urn:ok:error:invalid-request');
    expect(body.status).toBe(400);
    expect(typeof body.detail).toBe('string');
    expect(body.detail).toContain('field');
  });
});

describe('withValidation: body media type gate', () => {
  const wrappedWithSpy = (options: Parameters<typeof withValidation>[2] = {}) => {
    const calls: string[] = [];
    const wrapped = withValidation(
      TestSchema,
      async () => {
        calls.push('handler');
      },
      { handler: 'test', ...options },
    );
    return { wrapped, calls };
  };

  const declaredBody = (headers: Record<string, string>, chunks = [Buffer.from('{"foo":"bar"}')]) =>
    makeMockReq({
      headers: { 'content-length': String(chunks[0]?.length ?? 0), ...headers },
      chunks,
    });

  test.each([
    ['text/plain'],
    ['text/plain;charset=UTF-8'],
    ['application/x-www-form-urlencoded'],
    ['multipart/form-data; boundary=b'],
    ['application/jsonp'],
    ['application/xml'],
  ])(
    'a declared body typed %s → 415 problem+json, before the body is read',
    async (contentType) => {
      const { res, writeHeadCalls, endCalls } = makeMockRes();
      const { wrapped, calls } = wrappedWithSpy();
      let bodyConsumed = false;
      const req = makeMockReq({
        headers: { 'content-type': contentType, 'content-length': '13' },
        chunks: [Buffer.from('{"foo":"bar"}')],
      });
      Object.defineProperty(req, Symbol.asyncIterator, {
        value: async function* () {
          bodyConsumed = true;
          yield Buffer.from('{"foo":"bar"}');
        },
      });
      await wrapped(req, res);
      expect(calls).toEqual([]);
      expect(bodyConsumed).toBe(false);
      expect(writeHeadCalls.length).toBe(1);
      expect(writeHeadCalls[0].status).toBe(415);
      expect(writeHeadCalls[0].headers['Content-Type']).toBe('application/problem+json');
      const body = JSON.parse(endCalls[0]);
      expect(body.type).toBe('urn:ok:error:unsupported-media-type');
      expect(body.title).toBe('Request body must be JSON.');
      expect(body.status).toBe(415);
      expect(body.detail).toContain('Content-Type: application/json');
    },
  );

  test('a declared body with no content-type at all → 415', async () => {
    const { res, writeHeadCalls } = makeMockRes();
    const { wrapped, calls } = wrappedWithSpy();
    await wrapped(declaredBody({}), res);
    expect(calls).toEqual([]);
    expect(writeHeadCalls[0].status).toBe(415);
  });

  test.each([
    ['application/json'],
    ['application/json; charset=utf-8'],
    ['Application/JSON'],
    ['application/json ;charset=utf-8'],
    ['application/merge-patch+json'],
  ])('a body typed %s reaches the handler', async (contentType) => {
    const { res, writeHeadCalls } = makeMockRes();
    const { wrapped, calls } = wrappedWithSpy();
    await wrapped(declaredBody({ 'content-type': contentType }), res);
    expect(calls).toEqual(['handler']);
    expect(writeHeadCalls.length).toBe(0);
  });

  test('an undeclared body (no content-length, no transfer-encoding) skips the gate', async () => {
    const { res, writeHeadCalls } = makeMockRes();
    const { wrapped, calls } = wrappedWithSpy();
    await wrapped(
      makeMockReq({
        headers: { 'content-type': 'text/plain' },
        chunks: [Buffer.from('{"foo":"bar"}')],
      }),
      res,
    );
    expect(calls).toEqual(['handler']);
    expect(writeHeadCalls.length).toBe(0);
  });

  test('transfer-encoding alone declares a body → 415 without a content-type', async () => {
    const { res, writeHeadCalls } = makeMockRes();
    const { wrapped, calls } = wrappedWithSpy();
    await wrapped(makeMockReq({ headers: { 'transfer-encoding': 'chunked' } }), res);
    expect(calls).toEqual([]);
    expect(writeHeadCalls[0].status).toBe(415);
  });

  test('skipBodyParse routes ignore the body entirely, media type included', async () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    const { wrapped, calls } = wrappedWithSpy({ skipBodyParse: true, method: 'DELETE' });
    await wrapped(
      makeMockReq({
        method: 'DELETE',
        headers: { 'content-type': 'text/plain', 'content-length': '3' },
        chunks: [Buffer.from('{}')],
      }),
      res,
    );
    expect(calls).toEqual([]);
    expect(writeHeadCalls.length).toBe(1);
    expect(writeHeadCalls[0].status).toBe(400);
    expect(JSON.parse(endCalls[0]).type).toBe('urn:ok:error:invalid-request');
  });

  test('the method check outranks the media gate: a wrong method is still 405 with Allow', async () => {
    const { res, writeHeadCalls } = makeMockRes();
    const { wrapped, calls } = wrappedWithSpy({ method: 'POST' });
    await wrapped(
      makeMockReq({
        method: 'PATCH',
        headers: { 'content-type': 'text/plain', 'content-length': '13' },
        chunks: [Buffer.from('{"foo":"bar"}')],
      }),
      res,
    );
    expect(calls).toEqual([]);
    expect(writeHeadCalls[0].status).toBe(405);
    expect(writeHeadCalls[0].headers.Allow).toBe('POST');
  });

  test('a preBodyGate refusal still wins over the media gate', async () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    const wrapped = withValidation(
      TestSchema,
      async () => {
        throw new Error('handler must not run');
      },
      {
        handler: 'test',
        preBodyGate: (_req, response) => {
          response.writeHead(403, { 'Content-Type': 'application/problem+json' });
          response.end(JSON.stringify({ type: 'urn:ok:error:invalid-origin' }));
          (response as { headersSent?: boolean }).headersSent = true;
          (response as { writableEnded?: boolean }).writableEnded = true;
          return false;
        },
      },
    );
    await wrapped(
      makeMockReq({
        headers: { 'content-type': 'text/plain', 'content-length': '13' },
        chunks: [Buffer.from('{"foo":"bar"}')],
      }),
      res,
    );
    expect(writeHeadCalls.length).toBe(1);
    expect(writeHeadCalls[0].status).toBe(403);
    expect(JSON.parse(endCalls[0]).type).toBe('urn:ok:error:invalid-origin');
  });
});

describe('isJsonContentType', () => {
  test.each([
    ['application/json'],
    ['application/json; charset=utf-8'],
    ['APPLICATION/JSON'],
    ['Application/JSON'],
    ['  application/json  '],
    ['application/json ;charset=utf-8'],
    ['application/merge-patch+json'],
    ['application/json-patch+json'],
    ['application/vnd.api+json'],
  ])('admits %s', (contentType) => {
    expect(isJsonContentType(contentType)).toBe(true);
  });

  test.each([
    [undefined],
    [''],
    ['text/plain'],
    ['text/plain;charset=UTF-8'],
    ['multipart/form-data; boundary=x'],
    ['application/x-www-form-urlencoded'],
    ['application/jsonp'],
    ['application/+json'],
    ['text/json'],
    ['application/xml'],
  ])('refuses %s', (contentType) => {
    expect(isJsonContentType(contentType)).toBe(false);
  });
});

describe('readBoundedJsonBody: media type refusal', () => {
  const limits = { maxBytes: 1024, timeoutMs: 5_000 };

  test('throws UnsupportedMediaTypeError for a declared non-JSON body without reading it', async () => {
    let bodyConsumed = false;
    const req = makeMockReq({ headers: { 'content-type': 'text/plain', 'content-length': '2' } });
    Object.defineProperty(req, Symbol.asyncIterator, {
      value: async function* () {
        bodyConsumed = true;
        yield Buffer.from('{}');
      },
    });
    await expect(readBoundedJsonBody(req, limits)).rejects.toBeInstanceOf(
      UnsupportedMediaTypeError,
    );
    expect(bodyConsumed).toBe(false);
  });

  test('reads a JSON body and an undeclared body', async () => {
    const json = makeMockReq({
      headers: { 'content-type': 'application/json', 'content-length': '13' },
      chunks: [Buffer.from('{"foo":"bar"}')],
    });
    expect((await readBoundedJsonBody(json, limits)).toString('utf8')).toBe('{"foo":"bar"}');
    const undeclared = makeMockReq({ headers: { 'content-type': 'text/plain' } });
    expect((await readBoundedJsonBody(undeclared, limits)).length).toBe(0);
  });
});
