import { afterEach, describe, expect, test, vi } from 'vitest';
import { isGitHubReferenceHref, loadGitHubReference } from './github-reference';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

let seq = 0;
function uniquePull(): string {
  seq += 1;
  return `https://github.com/inkeep/agents/pull/${seq}`;
}

const PREVIEW = {
  kind: 'pull',
  repo: 'inkeep/agents',
  number: 1,
  title: 'Add cards',
  author: 'octocat',
  createdAt: '2026-09-20T10:00:00Z',
  lifecycle: 'merged',
};

const respond = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('isGitHubReferenceHref', () => {
  test('matches pull request and issue links on any https host', () => {
    expect(isGitHubReferenceHref('https://github.com/inkeep/agents/pull/42')).toBe(true);
    expect(isGitHubReferenceHref('https://git.example.com/team/app/issues/7')).toBe(true);
    expect(isGitHubReferenceHref('https://github.com/inkeep/agents/pull/42/files')).toBe(true);
  });

  test('leaves other links alone', () => {
    for (const href of [
      undefined,
      'http://github.com/inkeep/agents/pull/42',
      'https://github.com/inkeep/agents',
      'https://github.com/inkeep/agents/pulls',
      'https://linear.app/inkeep/issue/PRD-1',
      '#/docs/readme',
      'not a url',
    ]) {
      expect(isGitHubReferenceHref(href)).toBe(false);
    }
  });
});

describe('loadGitHubReference', () => {
  test('posts the link once and reuses the answer', async () => {
    const url = uniquePull();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      respond({ ok: true, preview: PREVIEW }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const [a, b] = await Promise.all([loadGitHubReference(url), loadGitHubReference(url)]);
    expect(a).toMatchObject({ title: 'Add cards', lifecycle: 'merged' });
    expect(b).toBe(a);
    expect(await loadGitHubReference(url)).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(input).toBe('/api/github-reference');
    expect(JSON.parse(String(init?.body))).toEqual({ url });
  });

  test('an unavailable preview resolves to nothing, and is not asked for again at once', async () => {
    const url = uniquePull();
    const fetchMock = vi.fn(async () => respond({ ok: false, reason: 'not-found' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    expect(await loadGitHubReference(url)).toBeNull();
    expect(await loadGitHubReference(url)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a network failure resolves to nothing and is retried on the next hover', async () => {
    const url = uniquePull();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => {
      throw new TypeError('offline');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    expect(await loadGitHubReference(url)).toBeNull();
    expect(await loadGitHubReference(url)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
