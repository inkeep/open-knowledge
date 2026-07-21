import { afterEach, describe, expect, test, vi } from 'vitest';
import { httpAuthTransport } from './auth-transport';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Drain a handle's async-iterable into an array (ends on terminal event). */
async function collectEvents(handle: {
  events: AsyncIterable<unknown>;
}): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for await (const e of handle.events) out.push(e as Record<string, unknown>);
  return out;
}

/** An NDJSON Response whose body streams the given lines. */
function ndjsonResponse(lines: string[]): Response {
  return new Response(new Blob([lines.map((l) => `${l}\n`).join('')]).stream(), { status: 200 });
}

describe('httpAuthTransport().pat', () => {
  test('POSTs { host, token } to the pat relay and returns the login on success', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ host: 'ghes.acme.test', login: 'omar-acme' }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const result = await httpAuthTransport().pat?.('ghes.acme.test', 'ghp_secret');
    expect(result).toEqual({ ok: true, login: 'omar-acme' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/local-op/auth/pat');
    expect(calls[0]?.body).toEqual({ host: 'ghes.acme.test', token: 'ghp_secret' });
  });

  test('surfaces the problem+json detail on a rejected token (bounded reason)', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            type: 'urn:ok:error:auth-failed',
            title: 'Authentication failed',
            status: 400,
            detail: 'Token invalid for ghes.acme.test',
          }),
          { status: 400, headers: { 'Content-Type': 'application/problem+json' } },
        ),
    ) as unknown as typeof fetch;

    const result = await httpAuthTransport().pat?.('ghes.acme.test', 'bad');
    expect(result).toEqual({ ok: false, error: 'Token invalid for ghes.acme.test' });
  });

  test('returns a generic connection error when the request throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const result = await httpAuthTransport().pat?.('ghes.acme.test', 'x');
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe('Connection error — try again');
  });
});

describe('httpAuthTransport().start / ghLogin (streamAuthEndpoint)', () => {
  test('a pre-stream problem+json failure surfaces the typed title as a single error event', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            type: 'urn:ok:error:auth-failed',
            title: 'The GitHub CLI (gh) is not installed.',
            status: 400,
          }),
          { status: 400, headers: { 'Content-Type': 'application/problem+json' } },
        ),
    ) as unknown as typeof fetch;

    const events = await collectEvents(httpAuthTransport().ghLogin?.('ghes.acme.test') as never);
    expect(events).toEqual([{ type: 'error', message: 'The GitHub CLI (gh) is not installed.' }]);
  });

  test('a pre-stream failure with an unparseable body falls back to the generic message', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('<html>gateway error</html>', { status: 502 }),
    ) as unknown as typeof fetch;

    const events = await collectEvents(httpAuthTransport().start() as never);
    expect(events).toEqual([{ type: 'error', message: 'Failed to start sign-in — try again' }]);
  });

  test('streams verification then complete, ending iteration on the terminal event', async () => {
    globalThis.fetch = vi.fn(async () =>
      ndjsonResponse([
        JSON.stringify({
          type: 'verification',
          user_code: 'AB-12',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
        }),
        JSON.stringify({ type: 'complete', host: 'github.com', login: 'octocat' }),
      ]),
    ) as unknown as typeof fetch;

    const events = await collectEvents(httpAuthTransport().start() as never);
    expect(events.map((e) => e.type)).toEqual(['verification', 'complete']);
    expect(events[1]?.login).toBe('octocat');
  });

  test('a mid-stream {type:error, problem} line is bridged to {type:error, message}', async () => {
    globalThis.fetch = vi.fn(async () =>
      ndjsonResponse([
        JSON.stringify({
          type: 'error',
          problem: { title: 'Authentication failed', detail: 'Device flow was denied' },
        }),
      ]),
    ) as unknown as typeof fetch;

    const events = await collectEvents(httpAuthTransport().start() as never);
    expect(events).toEqual([{ type: 'error', message: 'Device flow was denied' }]);
  });

  test('a stream that ends without a terminal event surfaces the no-confirmation error', async () => {
    globalThis.fetch = vi.fn(async () =>
      ndjsonResponse([
        JSON.stringify({
          type: 'verification',
          user_code: 'AB-12',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
        }),
      ]),
    ) as unknown as typeof fetch;

    const events = await collectEvents(httpAuthTransport().start() as never);
    expect(events.map((e) => e.type)).toEqual(['verification', 'error']);
    expect(events[1]?.message).toContain('without confirmation');
  });
});
