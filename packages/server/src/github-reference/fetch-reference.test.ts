import { describe, expect, test, vi } from 'vitest';
import { getLogger } from '../logger.ts';
import {
  fetchGitHubReference,
  GitHubRateLimitHolds,
  previewFromGraphQL,
  previewFromRest,
} from './fetch-reference.ts';
import type { GitHubReferenceTarget } from './reference-target.ts';

const PULL: GitHubReferenceTarget = {
  host: 'github.com',
  owner: 'inkeep',
  repo: 'agents',
  number: 42,
  kind: 'pull',
};

const ISSUE: GitHubReferenceTarget = { ...PULL, number: 7, kind: 'issues' };

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function fakeFetch(respond: (url: string, init: RequestInit | undefined) => Response | Error) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const out = respond(url, init);
    if (out instanceof Error) throw out;
    return out;
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const openPullNode = {
  __typename: 'PullRequest',
  title: 'Add reference cards',
  createdAt: '2026-09-20T10:00:00Z',
  state: 'OPEN',
  isDraft: false,
  additions: 120,
  deletions: 30,
  author: { login: 'octocat' },
  mergeStateStatus: 'BLOCKED',
  reviewDecision: 'REVIEW_REQUIRED',
  autoMergeRequest: { enabledAt: '2026-09-21T00:00:00Z' },
  mergeQueueEntry: { position: 2, state: 'AWAITING_CHECKS' },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] },
};

describe('previewFromGraphQL', () => {
  test('an open pull request carries every status axis', () => {
    expect(previewFromGraphQL(PULL, openPullNode)).toEqual({
      kind: 'pull',
      repo: 'inkeep/agents',
      number: 42,
      title: 'Add reference cards',
      author: 'octocat',
      createdAt: '2026-09-20T10:00:00Z',
      lifecycle: 'open',
      additions: 120,
      deletions: 30,
      status: {
        mergeQueue: { position: 2, state: 'AWAITING_CHECKS' },
        autoMerge: true,
        mergeState: 'BLOCKED',
        reviewDecision: 'REVIEW_REQUIRED',
        checks: 'PENDING',
      },
    });
  });

  test('drafts, merged and closed pull requests carry no status row', () => {
    const draft = previewFromGraphQL(PULL, { ...openPullNode, isDraft: true });
    expect(draft?.lifecycle).toBe('draft');
    expect(draft?.status).toBeUndefined();
    expect(previewFromGraphQL(PULL, { ...openPullNode, state: 'MERGED' })?.lifecycle).toBe(
      'merged',
    );
    const closed = previewFromGraphQL(PULL, { ...openPullNode, state: 'CLOSED' });
    expect(closed?.lifecycle).toBe('closed');
    expect(closed?.status).toBeUndefined();
  });

  test('an unknown enum value degrades to no value instead of failing the card', () => {
    const preview = previewFromGraphQL(PULL, {
      ...openPullNode,
      mergeStateStatus: 'SOMETHING_NEW',
    });
    expect(preview?.status?.mergeState).toBeNull();
    expect(preview?.title).toBe('Add reference cards');
  });

  test('issues map their close reason to completed or not planned', () => {
    const issue = {
      __typename: 'Issue',
      title: 'Crash on start',
      createdAt: '2026-09-01T00:00:00Z',
      state: 'CLOSED',
      stateReason: 'NOT_PLANNED',
      author: null,
    };
    expect(previewFromGraphQL(ISSUE, issue)).toEqual({
      kind: 'issue',
      repo: 'inkeep/agents',
      number: 7,
      title: 'Crash on start',
      author: null,
      createdAt: '2026-09-01T00:00:00Z',
      lifecycle: 'not-planned',
    });
    expect(previewFromGraphQL(ISSUE, { ...issue, stateReason: 'COMPLETED' })?.lifecycle).toBe(
      'completed',
    );
    expect(previewFromGraphQL(ISSUE, { ...issue, state: 'OPEN' })?.lifecycle).toBe('open');
  });
});

describe('previewFromRest', () => {
  test('reads lifecycle, diff and merge state from the pulls endpoint', () => {
    const preview = previewFromRest(PULL, null, {
      title: 'Add reference cards',
      created_at: '2026-09-20T10:00:00Z',
      state: 'open',
      draft: false,
      merged: false,
      additions: 5,
      deletions: 1,
      user: { login: 'octocat' },
      mergeable_state: 'unstable',
      auto_merge: null,
    });
    expect(preview).toMatchObject({
      lifecycle: 'open',
      additions: 5,
      deletions: 1,
      status: {
        mergeQueue: null,
        autoMerge: false,
        mergeState: 'UNSTABLE',
        reviewDecision: null,
        checks: null,
      },
    });
    expect(
      previewFromRest(PULL, null, {
        title: 't',
        created_at: '2026-09-20T10:00:00Z',
        state: 'closed',
        merged_at: '2026-09-21T10:00:00Z',
      })?.lifecycle,
    ).toBe('merged');
    expect(
      previewFromRest(PULL, null, {
        title: 't',
        created_at: '2026-09-20T10:00:00Z',
        state: 'closed',
        merged: false,
        merged_at: null,
      })?.lifecycle,
    ).toBe('closed');
  });
});

describe('fetchGitHubReference', () => {
  test('with a token it asks GraphQL once, sending the token only to the GitHub API', async () => {
    const fake = fakeFetch(() =>
      json({ data: { repository: { issueOrPullRequest: openPullNode } } }),
    );
    const outcome = await fetchGitHubReference({ target: PULL, token: 'tok', fetchFn: fake.impl });
    expect(outcome).toMatchObject({ ok: true, preview: { title: 'Add reference cards' } });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toBe('https://api.github.com/graphql');
    expect(new Headers(fake.calls[0]?.init?.headers).get('authorization')).toBe('Bearer tok');
  });

  test('an enterprise host uses its own API paths', async () => {
    const ghes = { ...PULL, host: 'git.example.com' };
    const fake = fakeFetch(() =>
      json({ data: { repository: { issueOrPullRequest: openPullNode } } }),
    );
    await fetchGitHubReference({ target: ghes, token: 'tok', fetchFn: fake.impl });
    expect(fake.calls[0]?.url).toBe('https://git.example.com/api/graphql');
    const anon = fakeFetch(() => json({ title: 't', created_at: 'x', state: 'open' }));
    await fetchGitHubReference({ target: ghes, token: null, fetchFn: anon.impl });
    expect(anon.calls[0]?.url).toBe('https://git.example.com/api/v3/repos/inkeep/agents/pulls/42');
  });

  test('without a token it reads REST anonymously, following an issue link to its pull request', async () => {
    const fake = fakeFetch((url) =>
      url.endsWith('/issues/7')
        ? json({ title: 'Add cards', pull_request: { url: 'x' } })
        : json({
            title: 'Add cards',
            created_at: '2026-09-20T10:00:00Z',
            state: 'open',
            draft: true,
            user: { login: 'octocat' },
          }),
    );
    const outcome = await fetchGitHubReference({ target: ISSUE, token: null, fetchFn: fake.impl });
    expect(outcome).toMatchObject({ ok: true, preview: { kind: 'pull', lifecycle: 'draft' } });
    expect(fake.calls.map((c) => c.url)).toEqual([
      'https://api.github.com/repos/inkeep/agents/issues/7',
      'https://api.github.com/repos/inkeep/agents/pulls/7',
    ]);
    expect(new Headers(fake.calls[0]?.init?.headers).has('authorization')).toBe(false);
  });

  test('without a token a plain issue reads its title, author, date and close reason from REST', async () => {
    const issue = {
      title: 'Crash on start',
      created_at: '2026-09-01T00:00:00Z',
      state: 'closed',
      state_reason: 'not_planned',
      user: { login: 'octocat' },
    };
    const fake = fakeFetch(() => json(issue));
    expect(await fetchGitHubReference({ target: ISSUE, token: null, fetchFn: fake.impl })).toEqual({
      ok: true,
      preview: {
        kind: 'issue',
        repo: 'inkeep/agents',
        number: 7,
        title: 'Crash on start',
        author: 'octocat',
        createdAt: '2026-09-01T00:00:00Z',
        lifecycle: 'not-planned',
      },
    });
    expect(fake.calls.map((c) => c.url)).toEqual([
      'https://api.github.com/repos/inkeep/agents/issues/7',
    ]);
    const completed = fakeFetch(() => json({ ...issue, state_reason: 'completed' }));
    expect(
      await fetchGitHubReference({ target: ISSUE, token: null, fetchFn: completed.impl }),
    ).toMatchObject({ preview: { lifecycle: 'completed' } });
    const open = fakeFetch(() => json({ ...issue, state: 'open', state_reason: null }));
    expect(
      await fetchGitHubReference({ target: ISSUE, token: null, fetchFn: open.impl }),
    ).toMatchObject({ preview: { lifecycle: 'open' } });
  });

  test('a GraphQL answer it cannot use falls back to REST with the same token', async () => {
    const fake = fakeFetch((url) =>
      url.endsWith('/graphql')
        ? json({ errors: [{ message: "Field 'mergeQueueEntry' doesn't exist" }] })
        : json({ title: 't', created_at: '2026-09-20T10:00:00Z', state: 'open' }),
    );
    const outcome = await fetchGitHubReference({ target: PULL, token: 'tok', fetchFn: fake.impl });
    expect(outcome.ok).toBe(true);
    expect(fake.calls[1]?.url).toBe('https://api.github.com/repos/inkeep/agents/pulls/42');
    expect(new Headers(fake.calls[1]?.init?.headers).get('authorization')).toBe('Bearer tok');
  });

  test('a rate-limited GraphQL answer is not retried over REST', async () => {
    for (const limited of [
      () => json({ message: 'You have exceeded a secondary rate limit' }, 429),
      () =>
        new Response('{"message":"API rate limit exceeded"}', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0' },
        }),
    ]) {
      const fake = fakeFetch(limited);
      expect(
        await fetchGitHubReference({ target: PULL, token: 'tok', fetchFn: fake.impl }),
      ).toEqual({ ok: false, reason: 'unavailable' });
      expect(fake.calls.map((c) => c.url)).toEqual(['https://api.github.com/graphql']);
    }
  });

  test('after GitHub rate-limits a card, no request goes to that host until the limit resets', async () => {
    let now = 1_000_000_000_000;
    const rateLimits = new GitHubRateLimitHolds();
    const limited = fakeFetch(
      () =>
        new Response('{"message":"API rate limit exceeded"}', {
          status: 403,
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String((now + 120_000) / 1000),
          },
        }),
    );
    const read = (target: GitHubReferenceTarget, fetchFn: typeof fetch, token: string | null) =>
      fetchGitHubReference({ target, token, fetchFn, rateLimits, now: () => now });
    expect(await read(PULL, limited.impl, null)).toEqual({ ok: false, reason: 'unavailable' });

    const issue = { title: 'Crash on start', created_at: '2026-09-01T00:00:00Z', state: 'open' };
    const answering = fakeFetch(() => json(issue));
    expect(await read(ISSUE, answering.impl, null)).toEqual({ ok: false, reason: 'unavailable' });
    expect(answering.calls).toHaveLength(0);
    expect((await read({ ...ISSUE, host: 'ghe.example.com' }, answering.impl, null)).ok).toBe(true);
    expect(answering.calls).toHaveLength(1);

    now += 120_000;
    expect((await read(ISSUE, answering.impl, null)).ok).toBe(true);
    expect(answering.calls).toHaveLength(2);
  });

  test('a rate-limit hold follows retry-after first, lasts at most an hour, and is kept apart per sign-in', async () => {
    let now = 1_000_000_000_000;
    const rateLimits = new GitHubRateLimitHolds();
    const limitedFor = (headers: Record<string, string>) =>
      fakeFetch(() => new Response('{}', { status: 429, headers })).impl;
    const answering = fakeFetch(() => json({ data: { repository: { issueOrPullRequest: null } } }));
    const read = (fetchFn: typeof fetch, token: string | null) =>
      fetchGitHubReference({ target: PULL, token, fetchFn, rateLimits, now: () => now });

    await read(
      limitedFor({ 'retry-after': '30', 'x-ratelimit-reset': String(now / 1000 + 600) }),
      'tok',
    );
    expect((await read(answering.impl, null)).ok).toBe(false);
    expect(answering.calls).toHaveLength(1);
    now += 29_000;
    await read(answering.impl, 'tok');
    expect(answering.calls).toHaveLength(1);
    now += 1_000;
    await read(answering.impl, 'tok');
    expect(answering.calls).toHaveLength(2);

    await read(limitedFor({ 'retry-after': String(24 * 60 * 60) }), 'tok');
    now += 60 * 60_000 - 1;
    await read(answering.impl, 'tok');
    expect(answering.calls).toHaveLength(2);
    now += 1;
    await read(answering.impl, 'tok');
    expect(answering.calls).toHaveLength(3);
  });

  test('a spent GraphQL budget holds only GraphQL until its reset, and REST keeps answering', async () => {
    let now = 1_000_000_000_000;
    const rateLimits = new GitHubRateLimitHolds();
    const reset = String((now + 300_000) / 1000);
    const pull = { title: 't', created_at: '2026-09-20T10:00:00Z', state: 'open' };
    const fake = fakeFetch((url) =>
      url.endsWith('/graphql')
        ? new Response(JSON.stringify({ errors: [{ type: 'RATE_LIMITED' }] }), {
            status: 200,
            headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
          })
        : json(pull),
    );
    const read = (number: number) =>
      fetchGitHubReference({
        target: { ...PULL, number },
        token: 'tok',
        fetchFn: fake.impl,
        rateLimits,
        now: () => now,
      });
    const infoLog = vi.spyOn(getLogger('github-reference'), 'info');
    expect((await read(1)).ok).toBe(true);
    expect((await read(2)).ok).toBe(true);
    expect(fake.calls.map((c) => c.url.replace('https://api.github.com', ''))).toEqual([
      '/graphql',
      '/repos/inkeep/agents/pulls/1',
      '/repos/inkeep/agents/pulls/2',
    ]);
    expect(infoLog).toHaveBeenCalledWith(
      expect.objectContaining({ api: 'graphql' }),
      '[github-reference] GitHub rate-limited reference cards; no GraphQL requests to this host until the limit resets',
    );
    infoLog.mockRestore();
    now += 300_000;
    await read(3);
    expect(fake.calls.at(-2)?.url).toBe('https://api.github.com/graphql');
  });

  test("a hold follows GitHub's order: retry-after, then the reset only when none are left, else a minute", async () => {
    let now = 1_000_000_000_000;
    const seconds = (ms: number) => String((now + ms) / 1000);
    const cases: Array<[string, Response, number]> = [
      [
        'a 429 with requests left waits a minute, not for the reset',
        new Response('{}', {
          status: 429,
          headers: { 'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': seconds(3_000_000) },
        }),
        60_000,
      ],
      [
        'a reset already past still waits a minute',
        new Response('{}', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': seconds(-5_000) },
        }),
        60_000,
      ],
      [
        'a 403 with only retry-after is a rate limit',
        new Response('{}', {
          status: 403,
          headers: { 'retry-after': '90', 'x-ratelimit-remaining': '12' },
        }),
        90_000,
      ],
      [
        'a retry-after of zero still holds for a second',
        new Response('{}', { status: 429, headers: { 'retry-after': '0' } }),
        1_000,
      ],
    ];
    for (const [label, limited, holdMs] of cases) {
      const rateLimits = new GitHubRateLimitHolds();
      const first = fakeFetch(() => limited);
      const answering = fakeFetch(() =>
        json({ title: 't', created_at: '2026-09-20T10:00:00Z', state: 'open' }),
      );
      const read = (fetchFn: typeof fetch) =>
        fetchGitHubReference({ target: PULL, token: null, fetchFn, rateLimits, now: () => now });
      expect(await read(first.impl), label).toEqual({ ok: false, reason: 'unavailable' });
      now += holdMs - 1;
      await read(answering.impl);
      expect(answering.calls, label).toHaveLength(0);
      now += 1;
      await read(answering.impl);
      expect(answering.calls, label).toHaveLength(1);
    }
  });

  test('a REST 429 with no requests left holds only REST, so the next signed-in read still asks GraphQL', async () => {
    let now = 1_000_000_000_000;
    const rateLimits = new GitHubRateLimitHolds();
    const fake = fakeFetch((url) =>
      url.endsWith('/graphql')
        ? json({ data: null })
        : new Response('{}', {
            status: 429,
            headers: {
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': String((now + 600_000) / 1000),
            },
          }),
    );
    const read = (number: number) =>
      fetchGitHubReference({
        target: { ...PULL, number },
        token: 'tok',
        fetchFn: fake.impl,
        rateLimits,
        now: () => now,
      });
    await read(1);
    now += 1_000;
    await read(2);
    expect(fake.calls.map((c) => c.url.replace('https://api.github.com', ''))).toEqual([
      '/graphql',
      '/repos/inkeep/agents/pulls/1',
      '/graphql',
    ]);
  });

  test('GraphQL is held when a 200 says its budget is spent, whichever way GitHub says it', async () => {
    const pull = { title: 't', created_at: '2026-09-20T10:00:00Z', state: 'open' };
    const cases: Array<[string, () => Response, boolean]> = [
      [
        'a RATE_LIMIT error',
        () => new Response(JSON.stringify({ errors: [{ type: 'RATE_LIMIT' }] }), { status: 200 }),
        true,
      ],
      [
        'an answer that spent the last point',
        () =>
          new Response(
            JSON.stringify({ data: { repository: { issueOrPullRequest: openPullNode } } }),
            { status: 200, headers: { 'x-ratelimit-remaining': '0' } },
          ),
        false,
      ],
    ];
    for (const [label, graphql, fallsBack] of cases) {
      const now = 1_000_000_000_000;
      const rateLimits = new GitHubRateLimitHolds();
      const fake = fakeFetch((url) => (url.endsWith('/graphql') ? graphql() : json(pull)));
      const read = (number: number) =>
        fetchGitHubReference({
          target: { ...PULL, number },
          token: 'tok',
          fetchFn: fake.impl,
          rateLimits,
          now: () => now,
        });
      expect((await read(1)).ok, label).toBe(true);
      await read(2);
      const graphqlCalls = fake.calls.filter((c) => c.url.endsWith('/graphql'));
      expect(graphqlCalls, label).toHaveLength(1);
      expect(
        fake.calls.map((c) => c.url).includes('https://api.github.com/repos/inkeep/agents/pulls/1'),
        label,
      ).toBe(fallsBack);
    }
  });

  test('a GraphQL 403 with only retry-after is not retried over REST', async () => {
    const fake = fakeFetch(
      () => new Response('{}', { status: 403, headers: { 'retry-after': '30' } }),
    );
    expect(await fetchGitHubReference({ target: PULL, token: 'tok', fetchFn: fake.impl })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(fake.calls.map((c) => c.url)).toEqual(['https://api.github.com/graphql']);
  });

  test('a spent GraphQL budget still reads REST, which GitHub meters separately', async () => {
    const fake = fakeFetch((url) =>
      url.endsWith('/graphql')
        ? new Response(JSON.stringify({ errors: [{ type: 'RATE_LIMITED' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '0' },
          })
        : json({ title: 't', created_at: '2026-09-20T10:00:00Z', state: 'open' }),
    );
    const outcome = await fetchGitHubReference({ target: PULL, token: 'tok', fetchFn: fake.impl });
    expect(outcome.ok).toBe(true);
    expect(fake.calls.map((c) => c.url)).toEqual([
      'https://api.github.com/graphql',
      'https://api.github.com/repos/inkeep/agents/pulls/42',
    ]);
  });

  test('a GitHub host that never answers is given up on after the timeout', async () => {
    const hung = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      })) as typeof fetch;
    const started = Date.now();
    expect(
      await fetchGitHubReference({ target: PULL, token: null, fetchFn: hung, timeoutMs: 30 }),
    ).toEqual({ ok: false, reason: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('a failed request is logged with its cause and target, and a timeout without the error', async () => {
    const warn = vi.spyOn(getLogger('github-reference'), 'warn').mockImplementation(() => {});
    try {
      const hung = (async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        })) as typeof fetch;
      await fetchGitHubReference({ target: PULL, token: null, fetchFn: hung, timeoutMs: 20 });
      const offline = fakeFetch(() => new TypeError('fetch failed'));
      await fetchGitHubReference({ target: PULL, token: 'tok', fetchFn: offline.impl });
      const target = { host: 'github.com', repo: 'inkeep/agents', number: 42 };
      expect(warn.mock.calls[0]?.[0]).toEqual({ reason: 'timeout', ...target });
      expect(warn.mock.calls[1]?.[0]).toEqual({
        reason: 'network',
        ...target,
        err: expect.any(TypeError),
      });
    } finally {
      warn.mockRestore();
    }
  });

  test('missing repositories and numbers are not found; limits and outages are unavailable', async () => {
    const missingRepo = fakeFetch(() => json({ data: { repository: null } }));
    expect(
      await fetchGitHubReference({ target: PULL, token: 'tok', fetchFn: missingRepo.impl }),
    ).toEqual({ ok: false, reason: 'not-found' });
    const missingNumber = fakeFetch(() =>
      json({ data: { repository: { issueOrPullRequest: null } } }),
    );
    expect(
      await fetchGitHubReference({ target: PULL, token: 'tok', fetchFn: missingNumber.impl }),
    ).toEqual({ ok: false, reason: 'not-found' });
    const privateRepo = fakeFetch(() => json({ message: 'Not Found' }, 404));
    expect(
      await fetchGitHubReference({ target: PULL, token: null, fetchFn: privateRepo.impl }),
    ).toEqual({ ok: false, reason: 'not-found' });
    const limited = fakeFetch(() => json({ message: 'rate limited' }, 403));
    expect(
      await fetchGitHubReference({ target: PULL, token: null, fetchFn: limited.impl }),
    ).toEqual({ ok: false, reason: 'unavailable' });
    const offline = fakeFetch(() => new TypeError('fetch failed'));
    expect(
      await fetchGitHubReference({ target: PULL, token: 'tok', fetchFn: offline.impl }),
    ).toEqual({ ok: false, reason: 'unavailable' });
  });
});
