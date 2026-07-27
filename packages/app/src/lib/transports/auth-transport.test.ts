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

  test('a stream that ends before any code is issued surfaces the no-confirmation error', async () => {
    // Nothing to recover: without a `verification` event there is no in-flight
    // device flow on the server to rejoin, so failing fast is correct.
    globalThis.fetch = vi.fn(async () => ndjsonResponse([])) as unknown as typeof fetch;

    const events = await collectEvents(httpAuthTransport().start() as never);
    expect(events.map((e) => e.type)).toEqual(['error']);
    expect(events[0]?.message).toContain('without confirmation');
  });

  test('keepalive ping lines are ignored — not surfaced, not terminal', async () => {
    globalThis.fetch = vi.fn(async () =>
      ndjsonResponse([
        JSON.stringify({ type: 'ping' }),
        JSON.stringify({
          type: 'verification',
          user_code: 'AB-12',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
        }),
        JSON.stringify({ type: 'ping' }),
        JSON.stringify({ type: 'ping' }),
        JSON.stringify({ type: 'complete', host: 'github.com', login: 'octocat' }),
      ]),
    ) as unknown as typeof fetch;

    const events = await collectEvents(httpAuthTransport().start() as never);
    expect(events.map((e) => e.type)).toEqual(['verification', 'complete']);
  });
});

/**
 * Issue #803. The device code is on screen and still valid, then the loopback
 * stream is severed by something outside OpenKnowledge (AV/EDR inspection, VPN
 * proxy, tab-backgrounding). The server keeps the flow alive across the drop,
 * so the client's job is to notice the authorization landing anyway instead of
 * declaring an unrecoverable failure.
 */
describe('streamAuthEndpoint — recovery after a mid-flow stream drop', () => {
  const VERIFICATION = JSON.stringify({
    type: 'verification',
    user_code: 'AB-12',
    verification_uri: 'https://github.com/login/device',
    expires_in: 900,
  });

  /** A body that yields the verification line, then errors mid-stream. */
  function severedAfterVerification(): Response {
    let sent = false;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(new TextEncoder().encode(`${VERIFICATION}\n`));
            return;
          }
          controller.error(new TypeError('network error'));
        },
      }),
      { status: 200 },
    );
  }

  test('a severed stream recovers via the status poll once the token lands', async () => {
    let statusCalls = 0;
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith('/auth/status')) {
        statusCalls++;
        // Not signed in yet on the first probe; the user finishes authorizing
        // on github.com between polls.
        return new Response(
          JSON.stringify(
            statusCalls === 1
              ? { authenticated: false }
              : { authenticated: true, host: 'github.com', login: 'octocat', name: 'Mona' },
          ),
          { status: 200 },
        );
      }
      return severedAfterVerification();
    }) as unknown as typeof fetch;

    const events = await collectEvents(httpAuthTransport().start() as never);
    expect(events.map((e) => e.type)).toEqual(['verification', 'complete']);
    expect(events[1]?.login).toBe('octocat');
    expect(events[1]?.name).toBe('Mona');
    expect(statusCalls).toBeGreaterThanOrEqual(2);
  }, 20_000);

  test('a clean stream end after the code was issued also recovers rather than failing', async () => {
    // Some intermediaries close the connection tidily (FIN, no reset), so the
    // reader sees a normal end-of-stream with no terminal event.
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith('/auth/status')) {
        return new Response(
          JSON.stringify({ authenticated: true, host: 'github.com', login: 'octocat' }),
          { status: 200 },
        );
      }
      return ndjsonResponse([VERIFICATION]);
    }) as unknown as typeof fetch;

    const events = await collectEvents(httpAuthTransport().start() as never);
    expect(events.map((e) => e.type)).toEqual(['verification', 'complete']);
    expect(events[1]?.login).toBe('octocat');
  }, 20_000);

  test('an expired code ends recovery with the expiry error, not a stream error', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith('/auth/status')) {
        return new Response(JSON.stringify({ authenticated: false }), { status: 200 });
      }
      // `expires_in: 0` — the code is already dead when the stream drops, so
      // recovery must not spin.
      return ndjsonResponse([
        JSON.stringify({
          type: 'verification',
          user_code: 'AB-12',
          verification_uri: 'https://github.com/login/device',
          expires_in: 0,
        }),
      ]);
    }) as unknown as typeof fetch;

    const events = await collectEvents(httpAuthTransport().start() as never);
    expect(events.map((e) => e.type)).toEqual(['verification', 'error']);
    expect(events[1]?.message).toContain('expired');
  });

  test('user cancel stops recovery and tells the server it was intentional', async () => {
    const cancelCalls: unknown[] = [];
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/auth/cancel')) {
        cancelCalls.push(JSON.parse(String(init?.body)));
        return new Response('{}', { status: 200 });
      }
      if (String(url).endsWith('/auth/status')) {
        return new Response(JSON.stringify({ authenticated: false }), { status: 200 });
      }
      return ndjsonResponse([VERIFICATION]);
    }) as unknown as typeof fetch;

    const handle = httpAuthTransport().start();
    const iter = handle.events[Symbol.asyncIterator]();
    const first = await iter.next();
    expect((first.value as { type: string }).type).toBe('verification');

    // The user closes the modal while recovery is polling.
    handle.cancel();

    // Iteration ends with no error event — a deliberate cancel is not a failure.
    expect((await iter.next()).done).toBe(true);
    expect(cancelCalls).toEqual([{ channel: 'login' }]);
  });

  test('cancel after a completed flow does not tell the server to cancel', async () => {
    // The modal unmounts on success and calls `cancel()` in cleanup; firing a
    // cancel there could displace a NEW flow the user has since started.
    const cancelCalls: unknown[] = [];
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith('/auth/cancel')) {
        cancelCalls.push(url);
        return new Response('{}', { status: 200 });
      }
      return ndjsonResponse([
        VERIFICATION,
        JSON.stringify({ type: 'complete', host: 'github.com', login: 'octocat' }),
      ]);
    }) as unknown as typeof fetch;

    const handle = httpAuthTransport().start();
    await collectEvents(handle as never);
    handle.cancel();
    expect(cancelCalls).toEqual([]);
  });

  test('the gh-login flow cancels its own channel, not the device-flow slot', async () => {
    const cancelBodies: unknown[] = [];
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/auth/cancel')) {
        cancelBodies.push(JSON.parse(String(init?.body)));
        return new Response('{}', { status: 200 });
      }
      if (String(url).endsWith('/auth/status')) {
        return new Response(JSON.stringify({ authenticated: false }), { status: 200 });
      }
      return ndjsonResponse([VERIFICATION]);
    }) as unknown as typeof fetch;

    const handle = httpAuthTransport().ghLogin?.('ghes.acme.test') as never as {
      events: AsyncIterable<unknown>;
      cancel: () => void;
    };
    const iter = handle.events[Symbol.asyncIterator]();
    await iter.next();
    handle.cancel();
    expect(cancelBodies).toEqual([{ channel: 'gh-login' }]);
  });
});
