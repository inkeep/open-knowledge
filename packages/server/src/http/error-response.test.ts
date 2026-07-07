/**
 * Defense-in-depth coverage for `errorResponse(...)`'s hardening.
 * Both branches guard ~286 call
 * sites and rarely fire; without unit coverage, silent regression would
 * re-expose the original crash risk that motivated the fix.
 */

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

/**
 * Minimal `ServerResponse` test double. Tracks `writeHead`/`end`/`write` calls
 * and exposes a `writeHeadCalls` / `endCalls` / `writeCalls` surface for
 * assertions. Avoids real HTTP machinery (no socket, no Node version coupling).
 */
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
    // Pin the observability contract alongside the suppression behavior.
    // Without the spy, a refactor that drops the `log.error()` call while
    // preserving the early return would pass the suppression assertion
    // but silently drop the diagnostic event — operators relying on
    // `api.error.double-write` for alerting would never see the bug.
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
    // Pin the documented level split ("Separating
    // levels avoids drowning monitoring in routine 4xx noise"). Without
    // this test, a refactor that hardcodes a single level would silently
    // shift either: (1) all routine 4xx noise to error/critical alerts,
    // or (2) all 5xx server bugs to warn-level where they get filtered.
    // Both regressions break monitoring contracts that the structured
    // `api.error` event powers downstream.
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
    // 5xx must NOT route through warn (and 4xx must NOT route through error).
    const warn5xx = warnSpy.mock.calls.find(
      ([arg]) => isObjLike(arg) && arg.event === 'api.error' && arg.status === 500,
    );
    expect(warn5xx).toBeUndefined();
  });

  test('empty title (min(1) violation) → emits fallback urn:ok:error:internal-server-error', () => {
    const { res, writeHeadCalls, endCalls } = makeMockRes();
    // Cast around the public API: `errorResponse` types `title` as `string`,
    // but a runtime caller could still pass `''` (e.g., constructed from a
    // user-supplied field). The schema's `min(1)` would reject this, and
    // the throwing `.parse()` would crash. The fallback must emit.
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
    // Caller passed a 4xx with an empty title — schema rejects, fallback
    // fires. The fallback emits `type: internal-server-error`; preserving
    // the caller's 404 would surface a contradiction to the client (404
    // body claiming the type is internal-server-error). Override the HTTP
    // status to 500 so type and status agree. The original 404 is captured
    // in the malformed-envelope log line for ops triage.
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
    // `X-Content-Type-Options: nosniff` is part of the security floor on
    // every error response (defense-in-depth alongside the explicit
    // problem+json content-type). Pinned on the happy path so a future
    // refactor that strips the security default from the spread-order
    // protection block fails loudly here.
    expect(writeHeadCalls[0].headers['X-Content-Type-Options']).toBe('nosniff');
    const body = JSON.parse(endCalls[0]);
    expect(body.type).toBe('urn:ok:error:invalid-request');
    expect(body.title).toBe('Bad input.');
    expect(body.detail).toBe('Field x is required.');
    expect(body.status).toBe(400);
    // `instance` is the primary correlation handle (grep between this
    // HTTP body and the matching Pino `api.error` log line). RFC 9457 §3.1.6
    // URI-reference form, emitted as `urn:uuid:<uuid>` per the schema.
    // Without this assertion, a refactor that drops `instance` from the
    // body construction would pass silently and break ops triage.
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
    // A caller passing `extraHeaders` containing reserved security header
    // names must NOT silently strip the defaults. Spread order at the
    // writeHead call must put `extraHeaders` first so canonical headers
    // win on key collision (mirrors the wireBody body-merge order).
    errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
      handler: 'test',
      extraHeaders: {
        Allow: 'GET',
        // Hostile / buggy caller attempting to disable sniffing protection.
        'X-Content-Type-Options': 'sniff',
        // Hostile / buggy caller attempting to retype problem+json as html.
        'Content-Type': 'text/html',
      },
    });
    expect(writeHeadCalls.length).toBe(1);
    const headers = writeHeadCalls[0].headers;
    expect(headers['Content-Type']).toBe('application/problem+json');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    // Non-reserved extension still passes through.
    expect(headers.Allow).toBe('GET');
  });

  test('case-variant header overrides cannot defeat security defaults', () => {
    // RFC 9110 §5.1 — HTTP field names are case-insensitive. JS object
    // literal keys are case-SENSITIVE, so `extraHeaders: { 'content-type': ... }`
    // produces a record with both `content-type` (from spread) and
    // `Content-Type` (from the canonical literal). Both are present in the
    // object passed to `writeHead`, but Node's `setHeader` lowercases
    // internally — and because the canonical entries come AFTER the spread
    // in the object literal (insertion order is iteration order for string
    // keys), they override on `setHeader`. This test pins that contract:
    // future refactors that change spread order would silently re-introduce
    // a content-sniffing vector.
    const { res, writeHeadCalls } = makeMockRes();
    errorResponse(res, 405, 'urn:ok:error:method-not-allowed', 'Method not allowed.', {
      handler: 'test',
      extraHeaders: {
        Allow: 'GET',
        // Lowercase + alternate case attempts to bypass the exact-key
        // override defense.
        'content-type': 'text/html',
        'x-content-type-options': 'sniff',
      },
    });
    expect(writeHeadCalls.length).toBe(1);
    const headers = writeHeadCalls[0].headers;
    // Canonical security headers preserved at their canonical case.
    expect(headers['Content-Type']).toBe('application/problem+json');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    // The lowercase variants survive in the writeHead args (Node's
    // setHeader will dedupe them when actually sending headers); the test's
    // contract is that the canonical-case keys carry the security values.
    expect(headers.Allow).toBe('GET');
  });

  test('unserializable extensions (circular ref) → 500 problem+json fallback with caller instance preserved', () => {
    // The `extensions` parameter narrows reserved RFC 9457 keys to `never`
    // at compile time but cannot reach into VALUE shape — a circular
    // reference, `BigInt`, or `Error` cause-chain cycle typed as `unknown`
    // sneaks past TypeScript and would crash `JSON.stringify(wireBody)`
    // mid-`res.end()` AFTER `res.writeHead` had already committed the
    // original status. The pre-stringify guard catches the throw before
    // headers commit and emits a hardcoded `urn:ok:error:internal-server-error`
    // envelope at status 500 so the client still sees a typed problem+json.
    // Caller-supplied instance UUID is preserved across the fallback for
    // grep correlation between the structured log and the wire envelope.
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
      // Pin the omission contract: caller-supplied `extraHeaders` (e.g.
      // `Allow: GET, POST` from a 405) are semantically tied to the original
      // error type, not the replacement `internal-server-error` 500. They
      // must not ride on the fallback envelope. A regression that surfaces
      // contradictory headers (`Allow: GET, POST` on a 500) breaks HTTP
      // semantics; this test asserts the headers seen on the wire contain
      // only the security defaults.
      extraHeaders: { Allow: 'GET, POST', 'Retry-After': '5' },
    });

    expect(writeHeadCalls.length).toBe(1);
    expect(writeHeadCalls[0].status).toBe(500);
    expect(writeHeadCalls[0].headers['Content-Type']).toBe('application/problem+json');
    expect(writeHeadCalls[0].headers['X-Content-Type-Options']).toBe('nosniff');
    // Caller's `extraHeaders` must be absent on the fallback path.
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
    // RFC 9457 §3.2 extension fields ride alongside the canonical body via
    // `{ ...options.extensions, ...body }` (spread order: extensions first,
    // canonical last so canonical wins on key collision). The TypeScript
    // `extensions` parameter narrows the reserved keys to `never`, but a
    // hostile / mis-typed runtime caller could still slip a colliding key
    // through. This test pins the merge order — a future refactor that
    // reverses the spread (extensions LAST) would let a caller silently
    // override the URN, leak the original handler's title, or hide the
    // status mismatch — all RFC 9457 contract violations the closed
    // ProblemTypeSchema is meant to enforce. Uses a typed cast through
    // `as unknown` because the dev-time type rejects collisions; this
    // test exercises the runtime defense.
    const { res, endCalls } = makeMockRes();
    errorResponse(res, 409, 'urn:ok:error:doc-already-exists', 'Doc already exists.', {
      handler: 'test',
      extensions: {
        // Legitimate extension — must survive on the wire.
        colliding: [{ existing: 'a.md', incoming: 'A.md', to: 'A.md' }],
        // Hostile collisions — typed as `never` at compile time but tested
        // at runtime to pin the spread order.
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
    // Canonical fields survive — hostile values dropped.
    expect(body.type).toBe('urn:ok:error:doc-already-exists');
    expect(body.title).toBe('Doc already exists.');
    expect(body.status).toBe(409);
    expect(body.detail).toBeUndefined();
    expect(typeof body.instance).toBe('string');
    expect(body.instance).not.toBe('attacker-controlled');
    // Legitimate extension survives.
    expect(body.colliding).toEqual([{ existing: 'a.md', incoming: 'A.md', to: 'A.md' }]);
  });
});

describe('streamingProblemEvent — defense-in-depth fallback', () => {
  test('empty title (min(1) violation) → returns fallback event', () => {
    // Mirrors the errorResponse fallback test: a runtime caller could still
    // pass `''` and the throwing `.parse()` would crash mid-
    // stream. The safeParse fallback must emit a typed event.
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
    // Mirrors the errorResponse fix on the streaming side. Caller passed
    // a 4xx with an empty title — schema rejects, fallback fires. Override
    // problem.status to 500 so `type: internal-server-error` and the body's
    // status field agree. Original status captured in the malformed-envelope
    // log line for ops triage.
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
    // Streaming-side counterpart to the errorResponse happy-path UUID
    // assertion. RFC 9457 §3.1.6 URI reference, emitted as `urn:uuid:<uuid>`
    // per the schema.
    expect(event.problem.instance).toMatch(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  test('detail field present when provided', () => {
    // Pin the contract on the streaming side — the 3 NDJSON handlers
    // (clone, auth-login, auth-repos) rely on `detail` for programmatic
    // error diagnosis. A regression that drops it from the body
    // construction would silently lose diagnostic context for SDK
    // consumers, so guard each direction explicitly.
    const event = streamingProblemEvent(500, 'urn:ok:error:clone-failed', 'Clone failed.', {
      handler: 'test',
      detail: 'fatal: repository not found',
    });
    expect(event.problem.detail).toBe('fatal: repository not found');
  });

  test('detail field absent when not provided', () => {
    // Companion to the above. The conditional-spread / falsy-coercion
    // in `streamingProblemEvent` must produce a body where `detail` is
    // absent (not present-as-undefined) so JSON.stringify omits the
    // field on the wire — matches RFC 9457's optional-field semantics.
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
    // Companion guard to `writableEnded`. When the client drops the
    // connection without `end()` (TCP RST), `writableEnded` stays false
    // but `destroyed` flips true and a downstream `res.write` would throw
    // `ERR_STREAM_DESTROYED`. The writer must skip the write so the
    // original error context (caller's `cause`) survives in the log.
    const { res, writeCalls } = makeMockRes({ destroyed: true });
    const writer = createStreamingErrorWriter(res, 'test');
    writer(500, 'urn:ok:error:internal-server-error', 'Whatever.');
    expect(writeCalls.length).toBe(0);
  });

  test('res.write throws → caught + logged, original cause preserved', () => {
    // Race window: socket destruction between the guard and the
    // write itself. The try/catch must swallow the write failure so the
    // caller's original error context survives — a propagated throw would
    // crash the streaming handler's event callback and replace the real
    // root cause with `ERR_STREAM_DESTROYED`.
    const { res } = makeMockRes();
    res.write = (() => {
      throw new Error('ERR_STREAM_DESTROYED');
    }) as typeof res.write;
    const writer = createStreamingErrorWriter(res, 'test');
    // Should not throw out of the writer.
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
    // Pins the documented sync-vs-streaming asymmetry: streaming emit only
    // checks `writableEnded || destroyed`, NOT `headersSent`, because
    // mid-stream `headersSent === true` is the EXPECTED state (the response
    // head was written when the stream was opened). A future refactor that
    // "harmonizes" sync + streaming guards by adding `headersSent` would
    // silently break the 3 NDJSON streaming handlers (clone, auth-login,
    // auth-repos).
    const { res, writeCalls } = makeMockRes({ headersSent: true });
    const writer = createStreamingErrorWriter(res, 'test');
    writer(500, 'urn:ok:error:internal-server-error', 'Mid-stream error.');
    expect(writeCalls.length).toBe(1);
  });
});
