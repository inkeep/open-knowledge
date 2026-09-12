import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getGitHubStars } from './github-stars.ts';

const guardedFetch = globalThis.fetch;

let answer: () => Promise<Response>;
let requested: Request[] = [];
let inits: (RequestInit | undefined)[] = [];

beforeEach(() => {
  requested = [];
  inits = [];
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    if (new URL(request.url).host !== 'api.github.com') return guardedFetch(input, init);
    requested.push(request);
    inits.push(init);
    return answer();
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = guardedFetch;
});

async function warnsWhileRunning<T>(run: () => Promise<T>): Promise<T> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const outcome = await run();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[github-stars]'));
    return outcome;
  } finally {
    warn.mockRestore();
  }
}

function json(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

describe('getGitHubStars', () => {
  test('returns the star count and asks the repo endpoint for JSON', async () => {
    answer = () => json({ stargazers_count: 1234 });

    expect(await getGitHubStars()).toBe(1234);

    const request = requested[0];
    if (request === undefined) throw new Error('no request was made');
    expect(new URL(request.url).pathname).toBe('/repos/inkeep/open-knowledge');
    expect(request.headers.get('accept')).toBe('application/vnd.github+json');
    expect(request.headers.get('user-agent')).toBe('openknowledge.ai');
  });

  test('forwards caller init keys other than signal, which is how the docs layout gets ISR', async () => {
    answer = () => json({ stargazers_count: 1234 });

    await getGitHubStars({ next: { revalidate: 3600 } } as RequestInit);

    expect(inits).toHaveLength(1);
    expect((inits[0] as { next?: unknown } | undefined)?.next).toEqual({ revalidate: 3600 });
  });

  test('returns null when the response is not ok, even though the body would parse', async () => {
    answer = () => json({ stargazers_count: 1234 }, 403);

    expect(await warnsWhileRunning(() => getGitHubStars())).toBeNull();
    expect(requested).toHaveLength(1);
  });

  test('returns null when the payload omits stargazers_count', async () => {
    answer = () => json({ full_name: 'inkeep/open-knowledge' });

    expect(await getGitHubStars()).toBeNull();
    expect(requested).toHaveLength(1);
  });

  test('returns null when stargazers_count is present but not a number', async () => {
    answer = () => json({ stargazers_count: '1234' });

    expect(await getGitHubStars()).toBeNull();
    expect(requested).toHaveLength(1);
  });

  test('returns null when the transport fails', async () => {
    answer = () => Promise.reject(new TypeError('fetch failed'));

    expect(await warnsWhileRunning(() => getGitHubStars())).toBeNull();
    expect(requested).toHaveLength(1);
  });

  test('aborts with the caller signal, and the caller signal alone ends it', async () => {
    const controller = new AbortController();
    answer = () =>
      new Promise((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });

    const pending = warnsWhileRunning(() => getGitHubStars({ signal: controller.signal }));
    controller.abort();
    expect(await pending).toBeNull();

    const forwarded = requested[0]?.signal;
    expect(forwarded?.aborted).toBe(true);
    expect((forwarded?.reason as { name?: string } | undefined)?.name).toBe('AbortError');
  });
});
