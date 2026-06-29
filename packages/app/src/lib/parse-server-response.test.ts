
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
    const res = new Response('<html>Bad Gateway</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    });
    const result = await parseServerResponse(res, 'unused');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.title).toContain('HTTP 502');
      expect(result.title.length).toBeGreaterThan('Server error (HTTP 502)'.length);
    }
  });

  test('204 No Content (empty body) → {ok: true, body: null}', async () => {
    const res = new Response('', { status: 204 });
    const result = await parseServerResponse(res, 'unused');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.body).toBeNull();
    }
  });

  test('200 with malformed JSON body → {ok: true, body: null} (success preferred)', async () => {
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
      expect(err instanceof Error && err.name === 'AbortError').toBe(true);
      return;
    }
    expect(result).not.toEqual({ ok: true, body: null });
  });

  test('5xx whose body read is aborted mid-stream → cancellation stays observable, not a server-error title', async () => {
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
      expect(err instanceof Error && err.name === 'AbortError').toBe(true);
      return;
    }
    expect(result).not.toMatchObject({ ok: false });
    expect(result).not.toEqual({ ok: true, body: null });
  });

  test('aborted body read emits no transport console.warn (no per-supersede log spam)', async () => {
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
      expect(consoleWarnSpy.length).toBe(1);
      expect(consoleWarnSpy[0]?.[0]).toContain('schema drift');
    } finally {
      console.warn = originalWarn;
    }
  });

  test('schema drift produces no throw even with fallback of a different shape', () => {
    const fallback: 'sentinel' = 'sentinel';
    const result = parseSuccessOrWarn(schema, { junk: 1 }, 'unknown', fallback);
    expect(result).toBe('sentinel');
  });
});
