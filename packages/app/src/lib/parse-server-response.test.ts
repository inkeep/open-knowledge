/**
 * Branch coverage for `parseServerResponse` + `parseSuccessOrWarn` — the
 * canonical client-side boundary parser for direct-HTTP consumers
 * (`FileTree.tsx`, `EditorTabs.tsx`, and any future consumer of mutating
 * endpoints). Untested regression of either branch crashes the UI
 * mid-mutation, AFTER the server has already committed the operation —
 * the warn-and-fallback design exists specifically to prevent this, so
 * the contract deserves dedicated coverage.
 */

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { parseServerResponse, parseSuccessOrWarn } from './parse-server-response.ts';

describe('parseServerResponse', () => {
  test('2xx with valid JSON body → {ok: true, body} with body untouched', async () => {
    const res = new Response(JSON.stringify({ renamed: [{ from: 'a', to: 'b' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const result = await parseServerResponse(res, 'unused');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body).toEqual({ renamed: [{ from: 'a', to: 'b' }] });
    }
  });

  test('4xx with RFC 9457 problem+json → {ok: false, title: <RFC title>}', async () => {
    const res = new Response(
      JSON.stringify({
        type: 'urn:ok:error:doc-already-exists',
        title: 'Destination already exists.',
        status: 409,
        instance: 'urn:uuid:00000000-0000-0000-0000-000000000000',
      }),
      { status: 409, headers: { 'content-type': 'application/problem+json' } },
    );
    const result = await parseServerResponse(res, 'fallback');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.title).toBe('Destination already exists.');
    }
  });

  test('5xx with non-RFC body → {ok: false, title: fallback}', async () => {
    // Body is JSON-shaped but lacks RFC 9457 `title` — `parseApiError`
    // returns undefined, the helper falls back to the caller's string.
    const res = new Response(JSON.stringify({ message: 'something broke' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
    const result = await parseServerResponse(res, 'Failed to rename path');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.title).toBe('Failed to rename path');
    }
  });

  test('non-JSON response → {ok: false, title: HTTP status + parse error detail}', async () => {
    // Plain-text response (e.g., a reverse proxy 502 with HTML / text).
    // `res.json()` throws SyntaxError; the helper forwards the error
    // detail in the title so the UI can distinguish "truncated body"
    // from "non-JSON content-type".
    const res = new Response('<html>Bad Gateway</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    });
    const result = await parseServerResponse(res, 'unused');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.title).toContain('HTTP 502');
      // SyntaxError detail is forwarded — exact message is engine-specific
      // (`Unexpected token <` on V8/Bun, `JSON Parse error` on Safari)
      // so we just assert it's longer than the bare "HTTP 502" prefix.
      expect(result.title.length).toBeGreaterThan('Server error (HTTP 502)'.length);
    }
  });

  test('204 No Content (empty body) → {ok: true, body: null}', async () => {
    // The HTTP status is the canonical wire-level success/error
    // discriminator. A 2xx with no JSON body (e.g., 204 from a DELETE-
    // style endpoint) is a success — not an error. Pin the contract:
    // a regression that misclassifies 204 as `{ok: false}` would show
    // spurious error toasts on every successful delete.
    const res = new Response('', { status: 204 });
    const result = await parseServerResponse(res, 'unused');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body).toBeNull();
    }
  });

  test('200 with malformed JSON body → {ok: true, body: null} (success preferred)', async () => {
    // Same rationale as the 204 case — HTTP 2xx is the discriminator.
    // A 200 that somehow returns broken JSON is suspicious but the
    // status says success; surface as `body: null` and let
    // `parseSuccessOrWarn` apply the per-endpoint fallback.
    const res = new Response('not-json', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const result = await parseServerResponse(res, 'unused');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body).toBeNull();
    }
  });

  test('2xx whose body read is aborted mid-stream → cancellation stays observable to the caller', async () => {
    // A superseded refresh aborts its own fetch after the 200 headers arrive
    // but mid-body-read; in Chromium (the production renderer) `res.json()`
    // then rejects with a DOMException named 'AbortError'. Bun's fetch
    // buffers bodies eagerly so the race cannot be produced through a real
    // fetch — a Response over an erroring ReadableStream reproduces the
    // exact rejection the renderer sees.
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new DOMException('The operation was aborted.', 'AbortError'));
      },
    });
    const res = new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    let result: Awaited<ReturnType<typeof parseServerResponse>> | undefined;
    try {
      result = await parseServerResponse(res, 'unused');
    } catch (err) {
      // Propagating the abort is one valid contract: it routes the rejection
      // into the caller's existing abort guard (FileTree.refreshDocs checks
      // `controller.signal.aborted` in its catch block).
      expect(err instanceof Error && err.name === 'AbortError').toBe(true);
      return;
    }
    // If the parser returns instead of throwing, the result must be
    // distinguishable from the empty-2xx success mapping: `{ok: true,
    // body: null}` is exactly what a 204 produces, and collapsing a
    // client-initiated abort into it erases the cancellation signal —
    // consumers then render a terminal "did not match expected shape"
    // error for their own supersede-abort.
    expect(result).not.toEqual({ ok: true, body: null });
  });

  test('5xx whose body read is aborted mid-stream → cancellation stays observable, not a server-error title', async () => {
    // Same Chromium-streaming emulation as the 2xx abort case above, on an
    // error status: a refresh superseded after error headers arrive but
    // mid-body-read is still a client-initiated cancellation. Mapping it to
    // the `{ok: false, title: 'Server error (HTTP n): ...'}` transport shape
    // makes consumers paint a terminal error banner for their own
    // supersede-abort.
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new DOMException('The operation was aborted.', 'AbortError'));
      },
    });
    const res = new Response(stream, {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });

    let result: Awaited<ReturnType<typeof parseServerResponse>> | undefined;
    try {
      result = await parseServerResponse(res, 'unused');
    } catch (err) {
      // Propagating the abort is one valid contract: it routes the rejection
      // into the caller's existing abort guard regardless of HTTP status.
      expect(err instanceof Error && err.name === 'AbortError').toBe(true);
      return;
    }
    // If the parser returns instead of throwing, the cancellation must stay
    // distinguishable from a genuine server failure: `{ok: false}` results
    // render as error UI, and the empty-success shape erases the signal.
    expect(result).not.toMatchObject({ ok: false });
    expect(result).not.toEqual({ ok: true, body: null });
  });

  test('aborted body read emits no transport console.warn (no per-supersede log spam)', async () => {
    // Every superseded refresh produces exactly one abort rejection. Routing
    // aborts through the 2xx-non-JSON transport warn turns routine supersedes
    // into console spam and miscasts a client-initiated cancel as a transport
    // problem worth an engineer's attention. The warn stays reserved for
    // genuine transport surprises (proxy HTML, truncated bodies).
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new DOMException('The operation was aborted.', 'AbortError'));
      },
    });
    const res = new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    const consoleWarnSpy: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      consoleWarnSpy.push(args);
    };
    try {
      await parseServerResponse(res, 'unused').catch((err: unknown) => {
        // Rethrowing the abort is a valid contract pinned by the sibling
        // abort tests; this test constrains only the logging side-effect.
        if (!(err instanceof Error && err.name === 'AbortError')) throw err;
      });
      const transportWarns = consoleWarnSpy.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('[parse-server-response]'),
      );
      expect(transportWarns).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('parseSuccessOrWarn', () => {
  const schema = z.object({ renamed: z.array(z.string()) });

  test('schema matches → returns parsed data', () => {
    const result = parseSuccessOrWarn(schema, { renamed: ['a', 'b'] }, 'rename-path', {
      renamed: [],
    });
    expect(result).toEqual({ renamed: ['a', 'b'] });
  });

  test('schema drift → returns fallback, does NOT throw', () => {
    // Mid-mutation flows (rename / delete / create) cannot recover from
    // a thrown parse error because the server has already committed the
    // operation. The fallback keeps the UI consistent. Pin the contract:
    // a future refactor that throws on schema drift would crash the UI
    // mid-rename and lose user state.
    const consoleWarnSpy: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      consoleWarnSpy.push(args);
    };
    try {
      const result = parseSuccessOrWarn<{ renamed: string[] }, { renamed: string[] }>(
        schema,
        { unexpected: 'shape' },
        'rename-path',
        { renamed: [] },
      );
      expect(result).toEqual({ renamed: [] });
      // The drift was logged for dev-tools / integration-test capture.
      expect(consoleWarnSpy.length).toBe(1);
      expect(consoleWarnSpy[0]?.[0]).toContain('schema drift');
    } finally {
      console.warn = originalWarn;
    }
  });

  test('schema drift produces no throw even with fallback of a different shape', () => {
    // The function returns `TIn | TOut` — the caller can substitute a
    // sentinel. Pin that the fallback type is preserved through.
    const fallback: 'sentinel' = 'sentinel';
    const result = parseSuccessOrWarn(schema, { junk: 1 }, 'unknown', fallback);
    expect(result).toBe('sentinel');
  });
});
