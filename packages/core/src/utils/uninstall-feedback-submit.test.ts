import { afterEach, describe, expect, test } from 'vitest';
import { postUninstallFeedback as barrelPostUninstallFeedback } from '../index.ts';
import { hasUninstallFeedbackContent, postUninstallFeedback } from './uninstall-feedback-submit.ts';

/** The origin baked into shipped builds, which a GUI app has no env to override. */
const SHIPPED_INTAKE_ORIGIN = 'https://openknowledge.ai';

const HOST_FACTS = { source: 'cli_uninstall', appVersion: '1.2.3', platform: 'darwin' } as const;

interface SeenRequest {
  url: string;
  method: string | undefined;
  contentType: string | undefined;
  body: Record<string, unknown>;
}

const realFetch = globalThis.fetch;
const realOriginEnv = process.env.OK_FEEDBACK_INTAKE_ORIGIN;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realOriginEnv === undefined) delete process.env.OK_FEEDBACK_INTAKE_ORIGIN;
  else process.env.OK_FEEDBACK_INTAKE_ORIGIN = realOriginEnv;
});

/** Installs a fetch that records each request and answers with `respond()`. */
function recordRequests(respond: () => Response | Promise<Response>): SeenRequest[] {
  const seen: SeenRequest[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: init?.method,
      contentType: new Headers(init?.headers).get('content-type') ?? undefined,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return Promise.resolve(respond());
  }) as typeof globalThis.fetch;
  return seen;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A request that never answers on its own — only the caller's abort ends it. */
function hangUntilAborted(): { wasAborted: () => boolean } {
  let wasAborted = false;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        wasAborted = true;
        reject(new DOMException('The operation was aborted', 'TimeoutError'));
      });
    });
  }) as typeof globalThis.fetch;
  return { wasAborted: () => wasAborted };
}

describe('postUninstallFeedback', () => {
  test('posts the single-select wire shape the intake schema accepts', async () => {
    const seen = recordRequests(() => jsonResponse(200, { reference: 'OK-42' }));

    const result = await postUninstallFeedback({
      ...HOST_FACTS,
      reason: 'missing-feature',
      note: 'Needed nested tags.',
      email: 'departing@example.com',
    });

    expect(result).toEqual({ ok: true, reference: 'OK-42' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`${SHIPPED_INTAKE_ORIGIN}/api/feedback`);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.contentType).toBe('application/json');
    expect(seen[0]?.body).toEqual({
      kind: 'uninstall',
      reasons: ['missing-feature'],
      message: 'Needed nested tags.',
      email: 'departing@example.com',
      appVersion: '1.2.3',
      platform: 'darwin',
      source: 'cli_uninstall',
    });
  });

  test('sends an empty reasons array when the user only left a note', async () => {
    const seen = recordRequests(() => jsonResponse(200, { reference: 'OK-43' }));

    await postUninstallFeedback({ ...HOST_FACTS, note: 'no reason fit' });

    expect(seen[0]?.body).toMatchObject({ reasons: [], message: 'no reason fit' });
    expect(seen[0]?.body).not.toHaveProperty('email');
  });

  // The intake validates `email` as an email and would 400 on `''`, so a
  // blanked-out field has to travel as absent rather than as an empty string.
  test('omits blank note and email rather than sending empty strings', async () => {
    const seen = recordRequests(() => jsonResponse(200, { reference: 'OK-44' }));

    await postUninstallFeedback({
      ...HOST_FACTS,
      reason: 'one-off',
      note: '   ',
      email: '  ',
    });

    expect(seen[0]?.body).not.toHaveProperty('message');
    expect(seen[0]?.body).not.toHaveProperty('email');
  });

  test('trims surrounding whitespace off the note and email', async () => {
    const seen = recordRequests(() => jsonResponse(200, { reference: 'OK-45' }));

    await postUninstallFeedback({
      ...HOST_FACTS,
      note: '  too slow  ',
      email: '  someone@example.com ',
    });

    expect(seen[0]?.body).toMatchObject({
      message: 'too slow',
      email: 'someone@example.com',
    });
  });

  test('reports success even when the response body carries no reference', async () => {
    recordRequests(() => new Response('', { status: 200 }));

    await expect(postUninstallFeedback({ ...HOST_FACTS, reason: 'other' })).resolves.toEqual({
      ok: true,
      reference: '',
    });
  });

  test.each([
    { status: 400, reason: 'invalid' },
    { status: 413, reason: 'invalid' },
    { status: 503, reason: 'unavailable' },
    { status: 500, reason: 'error' },
    { status: 429, reason: 'error' },
  ])('maps HTTP $status to reason $reason', async ({ status, reason }) => {
    recordRequests(() => new Response('', { status }));

    await expect(postUninstallFeedback({ ...HOST_FACTS, reason: 'other' })).resolves.toEqual({
      ok: false,
      reason,
    });
  });

  test('resolves rather than throwing when the network fails', async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error('getaddrinfo ENOTFOUND'))) as typeof globalThis.fetch;

    await expect(postUninstallFeedback({ ...HOST_FACTS, reason: 'unreliable' })).resolves.toEqual({
      ok: false,
      reason: 'error',
    });
  });

  // A departing user must never be parked on a hung intake: the request is
  // abandoned at the ceiling so the caller can get on with the uninstall.
  test('abandons a hung request at the timeout instead of blocking the caller', async () => {
    const hung = hangUntilAborted();

    const result = await postUninstallFeedback(
      { ...HOST_FACTS, reason: 'switched-tool' },
      { timeoutMs: 25 },
    );

    expect(hung.wasAborted()).toBe(true);
    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });

  test('targets the loopback intake origin the env names', async () => {
    process.env.OK_FEEDBACK_INTAKE_ORIGIN = 'http://localhost:4321';
    const seen = recordRequests(() => jsonResponse(200, { reference: 'OK-47' }));

    await postUninstallFeedback({ ...HOST_FACTS, reason: 'other' });

    expect(seen[0]?.url).toBe('http://localhost:4321/api/feedback');
  });

  // A departing user's note and follow-up address must never go out in
  // cleartext, and a bad origin must fail the send rather than silently
  // reverting to the shipped one.
  test.each([
    { origin: 'not a url', label: 'unparseable' },
    { origin: 'http://feedback.example.com', label: 'plaintext off-box' },
    { origin: 'ftp://localhost:4321', label: 'non-web scheme' },
  ])('refuses to send to an $label origin', async ({ origin }) => {
    process.env.OK_FEEDBACK_INTAKE_ORIGIN = origin;
    const seen = recordRequests(() => jsonResponse(200, { reference: 'OK-48' }));

    await expect(postUninstallFeedback({ ...HOST_FACTS, reason: 'other' })).resolves.toEqual({
      ok: false,
      reason: 'error',
    });
    expect(seen).toEqual([]);
  });

  test('sends to an off-box origin over https', async () => {
    process.env.OK_FEEDBACK_INTAKE_ORIGIN = 'https://staging.example.com';
    const seen = recordRequests(() => jsonResponse(200, { reference: 'OK-49' }));

    await postUninstallFeedback({ ...HOST_FACTS, reason: 'other' });

    expect(seen[0]?.url).toBe('https://staging.example.com/api/feedback');
  });

  // The intake validates the whole body at once, so shipping a typo'd address
  // would 400 the request and lose the reason and note along with it.
  test.each([
    'me@',
    'me.com',
    'not an address',
  ])('never spends a round trip on the obviously-broken address %s', async (email) => {
    const seen = recordRequests(() => jsonResponse(200, { reference: 'OK-50' }));

    const result = await postUninstallFeedback({
      ...HOST_FACTS,
      reason: 'unreliable',
      note: 'kept crashing',
      email,
    });

    expect(result).toEqual({ ok: true, reference: 'OK-50' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body).toMatchObject({ reasons: ['unreliable'], message: 'kept crashing' });
    expect(seen[0]?.body).not.toHaveProperty('email');
  });

  // These pass this side's cheap check but fail the intake's stricter
  // `z.email()`, which would otherwise reject the whole body. Correctness must
  // not depend on the two validators agreeing across the mirror boundary.
  test.each([
    'me@example.c',
    'josé@example.com',
    'a..b@example.com',
  ])('refiles without the address when the intake rejects %s', async (email) => {
    let attempts = 0;
    const seen = recordRequests(() => {
      attempts += 1;
      return attempts === 1
        ? new Response('', { status: 400 })
        : jsonResponse(200, { reference: 'OK-51' });
    });

    const result = await postUninstallFeedback({
      ...HOST_FACTS,
      reason: 'unreliable',
      note: 'kept crashing',
      email,
    });

    expect(result).toEqual({ ok: true, reference: 'OK-51' });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.body).toMatchObject({ email });
    expect(seen[1]?.body).toMatchObject({ reasons: ['unreliable'], message: 'kept crashing' });
    expect(seen[1]?.body).not.toHaveProperty('email');
  });

  test('retries at most once, so a body rejected for another reason still settles', async () => {
    const seen = recordRequests(() => new Response('', { status: 400 }));

    const result = await postUninstallFeedback({
      ...HOST_FACTS,
      reason: 'other',
      email: 'me@example.c',
    });

    expect(result).toEqual({ ok: false, reason: 'invalid' });
    expect(seen).toHaveLength(2);
  });

  test('does not retry a rejection when there was no address to blame', async () => {
    const seen = recordRequests(() => new Response('', { status: 400 }));

    await postUninstallFeedback({ ...HOST_FACTS, reason: 'other', note: 'no address given' });

    expect(seen).toHaveLength(1);
  });

  // Only a rejected body is worth refiling. Feedback being switched off, a
  // hung intake, or a dead network say nothing about the address, and a second
  // attempt would just spend the caller's remaining budget.
  test.each([503, 500])('does not retry a %s, which the address cannot explain', async (status) => {
    const seen = recordRequests(() => new Response('', { status }));

    await postUninstallFeedback({ ...HOST_FACTS, reason: 'other', email: 'me@example.com' });

    expect(seen).toHaveLength(1);
  });

  // The retry shares the caller's ceiling rather than starting a fresh one —
  // the desktop flow holds the finish screen open for exactly this budget.
  //
  // Deliberately slow for a unit test. The only thing separating the two
  // implementations is elapsed time, and `AbortSignal.timeout` runs on Node's
  // internal timer, which vitest's fake timers do not drive — so this has to
  // use the real clock, and the constants are sized to leave a margin that
  // survives CPU contention across parallel workers rather than to run fast.
  // The shared deadline is self-correcting (overshoot on the first attempt
  // shrinks what the retry gets), so the margin only has to cover the final
  // abort delivery: correct lands at ~BUDGET, per-attempt at ~BUDGET + FIRST.
  test('spends one budget across both attempts, not one budget each', async () => {
    const BUDGET = 600;
    const FIRST_ATTEMPT_MS = 360;
    let attempts = 0;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      attempts += 1;
      // The rejection arrives late, then the refile hangs: a per-attempt
      // timeout would let the pair run to BUDGET + FIRST_ATTEMPT_MS.
      if (attempts === 1) {
        return new Promise<Response>((resolve) =>
          setTimeout(() => resolve(new Response('', { status: 400 })), FIRST_ATTEMPT_MS),
        );
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted', 'TimeoutError')),
        );
      });
    }) as typeof globalThis.fetch;

    const startedAt = Date.now();
    const result = await postUninstallFeedback(
      { ...HOST_FACTS, reason: 'other', email: 'me@example.c' },
      { timeoutMs: BUDGET },
    );
    const elapsed = Date.now() - startedAt;

    expect(attempts).toBe(2);
    expect(result).toEqual({ ok: false, reason: 'timeout' });
    expect(elapsed).toBeLessThan(BUDGET + FIRST_ATTEMPT_MS / 2);
  });

  test('is exported from the package barrel both surfaces import', () => {
    expect(barrelPostUninstallFeedback).toBe(postUninstallFeedback);
  });
});

describe('hasUninstallFeedbackContent', () => {
  // Both uninstall surfaces gate their POST on this so an untouched form can
  // never file an empty churn ticket, and so the two can't drift on what
  // "empty" means.
  test.each([
    { answers: {}, expected: false },
    { answers: { note: '   ', email: '\t' }, expected: false },
    { answers: { reason: 'other' as const }, expected: true },
    { answers: { note: 'something' }, expected: true },
    { answers: { email: 'someone@example.com' }, expected: true },
  ])('is $expected for $answers', ({ answers, expected }) => {
    expect(hasUninstallFeedbackContent(answers)).toBe(expected);
  });
});
