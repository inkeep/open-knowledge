/**
 * Defense-in-depth coverage for `successResponse(...)`. Mirrors the
 * `errorResponse` test surface: every guard branch (headersSent,
 * writableEnded, schema-parse failure, extraHeaders security defaults,
 * non-200 success status) is pinned so a silent regression at the helper
 * level can't leak malformed bodies to clients across 68 migrated emit
 * sites.
 */

import { describe, expect, spyOn, test } from 'bun:test';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import { loggerFactory } from '../logger.ts';
import { successResponse } from './success-response.ts';

function isObjLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Minimal `ServerResponse` test double. Tracks `writeHead`/`end` calls and
 * exposes a `writeHeadCalls` / `endCalls` surface for assertions. Same shape
 * as the `errorResponse` test mock so reading both side-by-side stays easy.
 */
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
    // `handleAgentSession` emits 202 when
    // an agent session is accepted but processing is async. The helper
    // signature uses `status: number` (not a closed union) so 202 must work
    // identically to 200 — pin the contract.
    const Schema = z.object({ sessionId: z.string() });
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    successResponse(res, 202, Schema, { sessionId: 's-1' });
    expect(writeHeadCalls.length).toBe(1);
    expect(writeHeadCalls[0].status).toBe(202);
    expect(JSON.parse(endCalls[0])).toEqual({ sessionId: 's-1' });
  });

  test('empty-body success with z.object({}).loose() schema emits {}', () => {
    // Many endpoints (e.g., test-reset, sync-resolve-conflict) emit empty
    // success bodies via `z.object({}).loose()` schemas. The helper must not
    // strip them or substitute a different shape.
    const Schema = z.object({}).loose();
    const { res, endCalls } = makeMockRes();
    successResponse(res, 200, Schema, {});
    expect(endCalls.length).toBe(1);
    expect(endCalls[0]).toBe('{}');
  });

  test('.loose() schema preserves extra fields on the wire (forward-compat)', () => {
    // Every per-handler success schema declares `.loose()` so newer server
    // fields don't break older clients (and so older clients reading newer
    // servers still work). The helper's `schema.parse()` call must preserve
    // the extra-field passthrough — a Zod upgrade or refactor that strips
    // unknown keys would silently drop fields at all 69 call sites.
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
    // Mirrors the `errorResponse` headersSent guard. A handler that's
    // already started writing must not crash the response with
    // `ERR_HTTP_HEADERS_SENT` — the original error context (whatever
    // produced the prior write) must survive. Spy pins the
    // `api.success.double-write` observability event so a refactor that
    // drops the `log.error()` call would fail this test.
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
    // Companion guard for the case where `res.end()` was already called
    // (graceful close) but `headersSent` may not flip to true on every
    // Node version. Pin both branches of the OR.
    const Schema = z.object({ x: z.number() });
    const { res, writeHeadCalls, endCalls } = makeMockRes({ writableEnded: true });
    successResponse(res, 200, Schema, { x: 1 }, { handler: 'test' });
    expect(writeHeadCalls.length).toBe(0);
    expect(endCalls.length).toBe(0);
  });

  test('destroyed: true → writeHead never called (TCP RST / abrupt client disconnect)', () => {
    // Third branch of the triple-guard. When the client drops the
    // connection without `end()` (TCP RST), `writableEnded` stays false
    // but `destroyed` flips true and a downstream `res.writeHead` would
    // throw `ERR_STREAM_DESTROYED`. Mirrors `errorResponse`'s destroyed
    // guard (error-response.test.ts) so a refactor that drops one guard
    // can't silently land here without breaking parity.
    const Schema = z.object({ x: z.number() });
    const { res, writeHeadCalls, endCalls } = makeMockRes({ destroyed: true });
    successResponse(res, 200, Schema, { x: 1 }, { handler: 'test' });
    expect(writeHeadCalls.length).toBe(0);
    expect(endCalls.length).toBe(0);
  });

  test('schema-parse failure → emits 500 problem+json via errorResponse fallback', () => {
    // Body shape doesn't match schema (`x` should be number, got string).
    // The helper must NOT emit the malformed body to the wire — it must
    // route through `errorResponse` with `urn:ok:error:internal-server-error`
    // so the client gets a typed contract response and the existing
    // `ok.api.error.count{handler}` counter increments.
    //
    // The helper signature accepts `body: unknown` (mirroring `safeParse`'s
    // own contract — see success-response.ts JSDoc for the schema-vs-runtime
    // index-signature alignment rationale), so this call is well-typed at
    // compile time even though the runtime body is malformed.
    const Schema = z.object({ x: z.number() });
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    successResponse(res, 200, Schema, { x: 'not-a-number' }, { handler: 'test' });
    expect(writeHeadCalls.length).toBe(1);
    // Status overridden to 500 (the fallback's type=internal-server-error
    // and HTTP status must agree — same rationale as `errorResponse`'s
    // malformed-envelope fallback).
    expect(writeHeadCalls[0].status).toBe(500);
    expect(writeHeadCalls[0].headers['Content-Type']).toBe('application/problem+json');
    expect(endCalls.length).toBe(1);
    const body = JSON.parse(endCalls[0]);
    expect(body.type).toBe('urn:ok:error:internal-server-error');
    expect(body.title).toBe('Internal server error.');
    expect(body.status).toBe(500);
    expect(typeof body.instance).toBe('string');
    expect(body.instance).toMatch(/^urn:uuid:/);
    // Data-leak invariant: the malformed body's `x` field must NOT appear
    // on the wire. The fallback constructs a fresh problem+json envelope
    // through `errorResponse`, so client-facing output never echoes the
    // server's parse-rejected payload (which could contain sensitive
    // server-internal state if a future bug populated it).
    expect(body.x).toBeUndefined();
  });

  test('extraHeaders cannot override security defaults (Content-Type, X-Content-Type-Options)', () => {
    // Mirrors `errorResponse`'s security-header defense. A caller passing
    // `extraHeaders` containing reserved security header names must NOT
    // silently strip the defaults. Spread order at the writeHead call must
    // put `extraHeaders` first so canonical headers win on key collision.
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
          // Legitimate header — must survive.
          'Cache-Control': 'no-store',
          // Hostile / buggy caller attempting to retype JSON as html.
          'Content-Type': 'text/html',
          // Hostile / buggy caller attempting to disable sniffing protection.
          'X-Content-Type-Options': 'sniff',
        },
      },
    );
    expect(writeHeadCalls.length).toBe(1);
    const headers = writeHeadCalls[0].headers;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    // Legitimate extension still passes through.
    expect(headers['Cache-Control']).toBe('no-store');
  });

  test('schema-parse failure logs bodyKeys (field names) without body values for data-leak hygiene', () => {
    // The success-response.ts module-level `getLogger('http')` and this test
    // both resolve to the same cached PinoLogger instance via loggerFactory's
    // singleton — spying on that instance captures the malformed-body log
    // line. Mirrors the wire-side data-leak invariant test
    // but on the log-side, closing the centralized-observability exfiltration
    // vector through which user content (full markdown bodies, contributor
    // emails, file paths) would otherwise flow on schema-vs-server drift.
    // Asymmetric with errorResponse's malformed-envelope log: that body is
    // the small fixed-shape ProblemDetails envelope, not unbounded user data.
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

    // errorResponse's happy-path log fires too on the fallback emit; filter
    // explicitly to the success-side event.
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
    // Zod issues retained — load-bearing diagnostic signal carrying path,
    // code, expected, received per failed field.
    expect(data.issues).toBeDefined();

    errorSpy.mockRestore();
  });

  test('unserializable parsed body (circular ref) → 500 problem+json fallback with errorResponse delegation', () => {
    // Most success schemas are tightly constrained, but `HistoryEntrySchema.checkpoint`
    // accepts `z.unknown().nullable()` — survivor data can carry circular
    // refs, `BigInt`, or `Error` cause-chain cycles past `safeParse` and
    // would crash `JSON.stringify(validated.data)` mid-`res.end()` AFTER
    // `res.writeHead` had already committed the original 2xx. The pre-
    // stringify guard catches the throw before headers commit and routes
    // through `errorResponse` so the client still sees a typed
    // `urn:ok:error:internal-server-error` envelope. Mirrors the parallel
    // guard in `errorResponse` for symmetric defense across both wire-emit
    // helpers.
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
    // body=null, body=string, body=number, body=undefined etc. surface as
    // `bodyKeys: null` so the field-name diagnostic shape is well-defined
    // for any input — no crash on `Object.keys(null)`, no leak through
    // stringification of the primitive.
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
    // RFC 9110 §5.1 — HTTP field names are case-insensitive. JS object
    // literal keys are case-SENSITIVE, so `extraHeaders: { 'content-type':
    // ... }` produces a record with both `content-type` (from spread) and
    // `Content-Type` (from the canonical literal). Spread order at
    // writeHead: extraHeaders first, canonical last so canonical wins on
    // exact-key collision; for case-variants Node's `setHeader` lowercases
    // internally and the canonical entries override at send time. This
    // test pins that contract — future refactors that change spread order
    // would silently re-introduce a content-sniffing vector. Mirrors the
    // analogous `errorResponse` test.
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
          // Lowercase + alternate case attempts to bypass the exact-key
          // override defense.
          'content-type': 'text/html',
          'x-content-type-options': 'sniff',
        },
      },
    );
    expect(writeHeadCalls.length).toBe(1);
    const headers = writeHeadCalls[0].headers;
    // Canonical security headers preserved at their canonical case.
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Cache-Control']).toBe('no-store');
  });
});
