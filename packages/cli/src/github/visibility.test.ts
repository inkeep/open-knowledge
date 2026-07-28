import { describe, expect, test } from 'vitest';
import { type FetchFn, isGitHubRepoPublic } from './visibility.ts';

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  fetch: FetchFn;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn: FetchFn = (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  };
  return { fetch: fn, calls };
}

describe('isGitHubRepoPublic', () => {
  test('returns true on 200', async () => {
    const { fetch } = mockFetch(() => new Response('{}', { status: 200 }));
    expect(await isGitHubRepoPublic('miles', 'sharing-remote', fetch)).toBe(true);
  });

  test('returns false on 404 (private or nonexistent)', async () => {
    const { fetch } = mockFetch(() => new Response('not found', { status: 404 }));
    expect(await isGitHubRepoPublic('miles', 'sharing-remote', fetch)).toBe(false);
  });

  test('returns false on 403 (rate-limited)', async () => {
    const { fetch } = mockFetch(() => new Response('rate limit', { status: 403 }));
    expect(await isGitHubRepoPublic('miles', 'sharing-remote', fetch)).toBe(false);
  });

  test('returns false on network error', async () => {
    const fn: FetchFn = () => Promise.reject(new Error('ENETUNREACH'));
    expect(await isGitHubRepoPublic('miles', 'sharing-remote', fn)).toBe(false);
  });

  test('hits api.github.com/repos/OWNER/NAME with cli user-agent', async () => {
    const { fetch, calls } = mockFetch(() => new Response('{}', { status: 200 }));
    await isGitHubRepoPublic('inkeep', 'open-knowledge', fetch);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.github.com/repos/inkeep/open-knowledge');
    const headers = calls[0].init?.headers as Record<string, string> | undefined;
    expect(headers?.['User-Agent']).toBe('open-knowledge-cli');
  });

  test('percent-encodes path segments to defeat URL injection', async () => {
    const { fetch, calls } = mockFetch(() => new Response('{}', { status: 200 }));
    await isGitHubRepoPublic('owner/../escape', 'name', fetch);
    expect(calls[0].url).toBe('https://api.github.com/repos/owner%2F..%2Fescape/name');
  });

  test('sends no Authorization header (probe must be unauthenticated)', async () => {
    const { fetch, calls } = mockFetch(() => new Response('{}', { status: 200 }));
    await isGitHubRepoPublic('miles', 'sharing-remote', fetch);
    const headers = calls[0].init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });

  test('passes an AbortSignal to fetch so the 5s timeout stays wired up', async () => {
    const { fetch, calls } = mockFetch(() => new Response('{}', { status: 200 }));
    await isGitHubRepoPublic('miles', 'sharing-remote', fetch);
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });
});
