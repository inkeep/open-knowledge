/**
 * Defense-in-depth coverage for `withValidation()` — the structural enforcement
 * boundary for ~50 body-accepting handlers. The wrapper has six
 * distinct branches that are otherwise only tested indirectly through per-
 * handler integration tests:
 *
 *   1. Method mismatch       → 405 `urn:ok:error:method-not-allowed`
 *   2. `preBodyGate(false)`  → short-circuit (no body read, no handler call)
 *   3. `preBodyGate(true)`   → proceed to body read
 *   4. `skipBodyParse:true`  → handler invoked with empty-validated body
 *   5. PayloadTooLargeError  → 413 `urn:ok:error:payload-too-large`
 *   6. RequestBodyTimeoutError → 408 `urn:ok:error:request-timeout`
 *   7. JSON parse failure    → 400 `urn:ok:error:invalid-request`
 *   8. Schema validation     → 400 `urn:ok:error:invalid-request`
 *
 * Mirrors the mock-`IncomingMessage` / mock-`ServerResponse` pattern from
 * `error-response.test.ts`. Pins the wrapper's behavior independently of any
 * specific handler so a refactor of the catch block is caught here, not by a
 * regression in production.
 */

import { describe, expect, test } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import {
  PayloadTooLargeError,
  RequestBodyTimeoutError,
  validateBody,
  withValidation,
} from './request-validation.ts';

/** Same `ServerResponse` test double shape as `error-response.test.ts`. */
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
}

/**
 * Mock `IncomingMessage` for body-read tests. Implements async-iterable so the
 * `for await (const chunk of req)` loop in `readRequestBody` consumes from
 * `chunks`. `throwOnRead` simulates the timeout / payload-too-large surfaces by
 * throwing on first iteration (matches what `req.destroy(err)` produces in
 * production).
 */
function makeMockReq(opts: MockReqOptions = {}): IncomingMessage {
  return {
    method: opts.method ?? 'POST',
    destroy(_err?: Error) {
      /* no-op for the mock — the AbortSignal listener calls this in production */
    },
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
    // Pins the `if (options.method !== undefined)` guard at request-validation.ts.
    // Composite handlers (the parent method-router shims) are bare async
    // functions, but the omitted-method branch is the public API contract:
    // omit `method` and the wrapper accepts any HTTP method without 405.
    const { res, writeHeadCalls } = makeMockRes();
    let handlerCalled = false;
    const wrapped = withValidation(
      TestSchema,
      async (_req, _res, body) => {
        handlerCalled = true;
        expect(body.foo).toBe('bar');
      },
      { handler: 'test' }, // intentionally no method:
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
    // Wire body uses generic title; the "preBodyGate returned false" diagnostic
    // is routed through `cause` (Pino-logged via err: field, never on the wire)
    // per the codebase's data-leak hygiene precedent.
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
    // Use an empty-object schema so `skipBodyParse:true`'s `validateBody({})`
    // succeeds without requiring a real body.
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
    // Companion to the mocked-throw test. The mock asserts the
    // wrapper's catch branch translates the typed error correctly; this
    // exercises the actual `totalBytes += chunk.length; if (totalBytes >
    // MAX_BODY_BYTES)` accumulation path inside `readRequestBody`. A
    // regression that checked per-chunk size instead of cumulative would
    // pass the mocked test (it never enters the read loop) but would let
    // a multi-chunk payload through here.
    //
    // MAX_BODY_BYTES = 1_048_576 (1 MB). Two 600KB chunks sum to 1.2MB,
    // exceeding the cap on the second iteration of the read loop.
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
    // Stream errors out of `for-await` (ERR_STREAM_PREMATURE_CLOSE,
    // ERR_STREAM_DESTROYED, native AbortError variants) are transport- /
    // server-class, not client-caused. Surfacing as 500 keeps SDK retry
    // semantics correct — a client receiving 400 for a transport failure
    // would retry unchanged believing it sent bad data. The two
    // specifically-typed branches (413 PayloadTooLargeError, 408
    // RequestBodyTimeoutError) keep their precise client-class statuses.
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
    // `foo` is required; pass `{ bar: 1 }` so the schema rejects.
    await wrapped(makeMockReq({ chunks: [Buffer.from('{"bar":1}')] }), res);
    expect(writeHeadCalls.length).toBe(1);
    expect(writeHeadCalls[0].status).toBe(400);
    const body = JSON.parse(endCalls[0]);
    expect(body.type).toBe('urn:ok:error:invalid-request');
    expect(body.title).toBe('Request body is invalid.');
    // Detail surfaces the failing field's path.
    expect(typeof body.detail).toBe('string');
    expect(body.detail).toContain('foo');
  });

  test('empty body (Content-Length: 0) → treated as {} → schema validates', async () => {
    const { res } = makeMockRes();
    let receivedBody: unknown = null;
    // Pin the `raw.length === 0 ? {} : JSON.parse(raw)` branch in
    // `withValidation`: an empty buffer must NOT trigger a JSON parse on
    // the empty string (which would emit `urn:ok:error:invalid-request` for
    // a routine zero-length POST). The wrapper substitutes `{}` and passes
    // the empty object through schema validation.
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
    // The empty-body → `{}` substitution still feeds through schema
    // validation, so a schema that requires fields rejects the empty case
    // exactly like a malformed body — confirming the empty-body branch
    // doesn't accidentally bypass schema enforcement.
    await wrapped(makeMockReq({ chunks: [] }), res);
    expect(writeHeadCalls.length).toBe(1);
    expect(writeHeadCalls[0].status).toBe(400);
    const body = JSON.parse(endCalls[0]);
    expect(body.type).toBe('urn:ok:error:invalid-request');
    expect(body.detail).toContain('foo');
  });

  test('inner handler throw propagates — withValidation does not wrap caller exceptions', async () => {
    // Documented contract (request-validation.ts): inner
    // handler exceptions are NOT caught here. Each api-extension.ts handler
    // owns its own top-level try/catch + 500 emission, so wrapping at this
    // layer would either double-emit (handler caught → withValidation
    // catches the rejected promise → 500 over an already-sent response) or
    // mask the per-handler structured logging. Pin the contract so a future
    // refactor that adds a try/catch around `await handler(...)` fails
    // loudly instead of silently changing the error-flow shape.
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
  // Multipart handlers (e.g., `handleUploadAsset`) bypass `withValidation`'s
  // body reader since busboy parses the multipart envelope itself, then
  // call `validateBody` directly on the assembled metadata fields. Without
  // these direct tests, the function is covered only transitively through
  // `withValidation` — a future refactor that inlined validation logic into
  // `withValidation` while leaving `validateBody` stale would silently
  // break multipart handlers without a test failure.
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
