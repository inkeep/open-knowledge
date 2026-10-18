import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  ALLOW_PARTIAL_CHANGELOG,
  collectDates,
  collectMarkedNotes,
  cutoverOf,
  fetchReleaseFeed,
  loadStableReleases,
  markedNotes,
  mergeReleaseNotes,
  NOTES_SOURCE_MARKER,
  newMarkedNotesScan,
  parseChangelog,
  passedCutover,
  releaseNotesFrom,
  releaseNotesRequired,
} from './releases.ts';

const SAMPLE = `# @inkeep/open-knowledge

## 0.35.0

### Minor Changes

- 3c124b0: Added the command palette.

### Patch Changes

- 6681a97: Fixed a clone bug.

## 0.34.0

### Patch Changes

- 95380ab: Recorded the server exit reason.

## 0.9.1

### Patch Changes

- deadbeef: Old release.
`;

describe('parseChangelog', () => {
  test('parses each version section, newest first (file order)', () => {
    const out = parseChangelog(SAMPLE);
    expect(out.map((r) => r.tag)).toEqual(['v0.35.0', 'v0.34.0', 'v0.9.1']);
  });

  test('derives tag, title, and htmlUrl from the version', () => {
    const [first] = parseChangelog(SAMPLE);
    expect(first.tag).toBe('v0.35.0');
    expect(first.title).toBe('v0.35.0');
    expect(first.htmlUrl).toBe('https://github.com/inkeep/open-knowledge/releases/tag/v0.35.0');
  });

  test('strips the changeset commit-hash prefix and renders GFM to HTML', () => {
    const [first] = parseChangelog(SAMPLE);
    expect(first.bodyHtml).toContain('<h3');
    expect(first.bodyHtml).toContain('<li>Added the command palette.</li>');
    expect(first.bodyHtml).not.toContain('3c124b0');
  });

  test('injects dates by tag; missing tags get null', () => {
    const dates = new Map([['v0.35.0', '2026-07-20T13:57:49Z']]);
    const out = parseChangelog(SAMPLE, dates);
    expect(out.find((r) => r.tag === 'v0.35.0')?.publishedAt).toBe('2026-07-20T13:57:49Z');
    expect(out.find((r) => r.tag === 'v0.34.0')?.publishedAt).toBeNull();
  });

  test('ignores content before the first version heading', () => {
    const [first] = parseChangelog(SAMPLE);
    expect(first.bodyHtml).not.toContain('@inkeep/open-knowledge');
  });

  test('does not match prerelease headings or malformed input', () => {
    expect(parseChangelog('## 0.30.1-beta.1\n\n- x: note\n')).toEqual([]);
    expect(parseChangelog('# Title only\n\nno versions here')).toEqual([]);
    expect(parseChangelog('')).toEqual([]);
  });
});

function apiRelease(
  tag: string,
  opts: {
    draft?: boolean;
    prerelease?: boolean;
    published_at?: string | null;
    created_at?: string;
    body?: string;
  } = {},
) {
  const { draft = false, prerelease = false, published_at = '2026-07-01T00:00:00Z', body } = opts;
  const created_at = opts.created_at ?? published_at ?? '2026-07-01T00:00:00Z';
  return {
    tag_name: tag,
    draft,
    prerelease,
    created_at,
    published_at,
    ...(body === undefined ? {} : { body }),
  };
}

describe('collectDates', () => {
  test('collects stable published dates, skipping drafts and prereleases', () => {
    const dates = new Map<string, string>();
    collectDates(
      [
        apiRelease('v0.35.0'),
        apiRelease('v0.35.0-beta.1', { prerelease: true }),
        apiRelease('v0.29.9', { draft: true }),
        apiRelease('v0.34.0'),
      ],
      dates,
      30,
    );
    expect([...dates.keys()]).toEqual(['v0.35.0', 'v0.34.0']);
  });

  test('honors the limit and tolerates malformed entries', () => {
    const dates = new Map<string, string>();
    collectDates([apiRelease('v1.0.0'), apiRelease('v0.9.0')], dates, 1);
    expect(dates.size).toBe(1);
    const d2 = new Map<string, string>();
    collectDates([null, 42, { tag_name: 5 }, apiRelease('v1.0.0', { published_at: null })], d2, 30);
    expect(d2.size).toBe(0);
    collectDates('not-an-array', d2, 30);
    expect(d2.size).toBe(0);
  });
});

function mockFetch(responder: (page: number) => Response) {
  const pages: number[] = [];
  return ((url: string | URL) => {
    const page = Number(/[?&]page=(\d+)/.exec(String(url))?.[1] ?? '1');
    pages.push(page);
    return Promise.resolve(responder(page));
  }) as unknown as typeof fetch;
}

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
const noWait = async () => {};
const fullPage = (page: number) =>
  Array.from({ length: 100 }, (_, i) => apiRelease(`v9.${page}.${i}`, { prerelease: i > 0 }));

describe('fetchReleaseFeed dates (best-effort)', () => {
  test('keeps only as many stable dates as asked for', async () => {
    const feed = await fetchReleaseFeed({
      dateLimit: 2,
      changelogTags: new Set(),
      fetchImpl: mockFetch((p) => json(p <= 3 ? fullPage(p) : [])),
    });
    expect(feed.dates.size).toBe(2);
  });

  test('stops on a short (final) page', async () => {
    const feed = await fetchReleaseFeed({
      changelogTags: new Set(),
      fetchImpl: mockFetch(() => json([apiRelease('v1.0.0')])),
    });
    expect(feed.dates.size).toBe(1);
  });

  test('degrades to empty on HTTP error — never throws', async () => {
    const feed = await fetchReleaseFeed({
      changelogTags: new Set(),
      fetchImpl: mockFetch(() => new Response('nope', { status: 500 })),
      sleep: noWait,
    });
    expect(feed.dates.size).toBe(0);
  });

  test('degrades to empty on a network throw — never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const feed = await fetchReleaseFeed({
      changelogTags: new Set(),
      fetchImpl: (() => Promise.reject(new Error('offline'))) as never,
      sleep: noWait,
    });
    expect(feed.dates.size).toBe(0);
    warn.mockRestore();
  });
});

const DOWNLOADS =
  '<!-- ok-downloads:start -->\n## Downloads\n\n| a | b |\n| --- | --- |\n<!-- ok-downloads:end -->';
const marked = (notes: string) => `${notes}\n\n${NOTES_SOURCE_MARKER}\n\n${DOWNLOADS}\n`;

describe('markedNotes', () => {
  test('is the body before the notes-source marker, without the Downloads block', () => {
    expect(markedNotes(marked('### Patch Changes\n\n- A fix.'))).toBe(
      '### Patch Changes\n\n- A fix.',
    );
    expect(
      markedNotes(
        `### Patch Changes\n\n- A fix.\n\n${NOTES_SOURCE_MARKER}\n\nPoint release over v1.0.0.`,
      ),
    ).toBe('### Patch Changes\n\n- A fix.');
  });

  test('is null for a body without the marker, so the version keeps its CHANGELOG.md notes', () => {
    expect(markedNotes(`### Patch Changes\n\n- A fix.\n\n${DOWNLOADS}\n`)).toBeNull();
    expect(markedNotes('')).toBeNull();
  });
});

const day = (n: number) => new Date(Date.UTC(2026, 9, 1) - n * 86_400_000).toISOString();

describe('collectMarkedNotes', () => {
  test('keeps every marked stable body and takes the highest unmarked CHANGELOG stable published before them as the cutover', () => {
    const scan = newMarkedNotesScan();
    collectMarkedNotes(
      [
        apiRelease('v0.88.0', { draft: true, body: marked('- Draft.') }),
        apiRelease('v0.88.0-beta.1', { prerelease: true, body: marked('- Beta.') }),
        apiRelease('v0.87.1', { body: marked('- Newest.'), published_at: day(0) }),
        apiRelease('v0.87.0', {
          body: 'A revert point release, unmarked and not in CHANGELOG.md.',
          published_at: day(1),
        }),
        apiRelease('v0.86.11', { body: '- Covered, below the cutover.', published_at: day(5) }),
        apiRelease('v0.86.13', { body: marked('- Older.'), published_at: day(2) }),
        apiRelease('v0.86.12', { body: '- From before the cutover.', published_at: day(3) }),
      ],
      scan,
      new Set(['v0.86.12', 'v0.86.11']),
    );
    expect([...scan.notes]).toEqual([
      ['v0.87.1', '- Newest.'],
      ['v0.86.13', '- Older.'],
    ]);
    expect(cutoverOf(scan)).toEqual({ tag: 'v0.86.12', publishedAt: Date.parse(day(3)) });
  });

  test('an unmarked CHANGELOG stable published after a marked body is never the cutover', () => {
    const scan = newMarkedNotesScan();
    collectMarkedNotes(
      [
        apiRelease('v0.90.1', { body: '- Revert, unmarked.', published_at: day(1) }),
        apiRelease('v0.90.0', { body: marked('- Ninety.'), published_at: day(3) }),
      ],
      scan,
      new Set(['v0.90.1']),
    );
    expect(cutoverOf(scan)).toBeNull();
  });

  test('tolerates malformed entries and payloads', () => {
    const scan = newMarkedNotesScan();
    collectMarkedNotes([null, 42, { tag_name: 5 }, apiRelease('v1.0.0')], scan, new Set());
    collectMarkedNotes('not-an-array', scan, new Set());
    expect(scan.notes.size).toBe(0);
    expect(cutoverOf(scan)).toBeNull();
  });
});

describe('passedCutover', () => {
  test('holds once the scan reaches releases created 14 days before the cutover was published', () => {
    const scan = newMarkedNotesScan();
    const covered = new Set(['v1.0.0']);
    collectMarkedNotes([apiRelease('v1.0.0', { published_at: day(0) })], scan, covered);
    collectMarkedNotes(
      [apiRelease('v0.9.0-beta.0', { prerelease: true, created_at: day(13) })],
      scan,
      covered,
    );
    expect(passedCutover(scan)).toBe(false);
    collectMarkedNotes(
      [apiRelease('v0.9.0-beta.1', { prerelease: true, created_at: day(15) })],
      scan,
      covered,
    );
    expect(passedCutover(scan)).toBe(true);
  });

  test('never holds without an unmarked stable the CHANGELOG covers', () => {
    const scan = newMarkedNotesScan();
    collectMarkedNotes(
      [apiRelease('v2.0.0', { body: marked('- x'), created_at: day(400) })],
      scan,
      new Set(['v1.0.0']),
    );
    expect(passedCutover(scan)).toBe(false);
  });
});

function pagedFetch(pages: unknown[][], status: (page: number) => number = () => 200) {
  const requested: number[] = [];
  const impl = ((url: string | URL) => {
    const page = Number(/[?&]page=(\d+)/.exec(String(url))?.[1] ?? '1');
    requested.push(page);
    const code = status(page);
    return Promise.resolve(
      code === 200
        ? new Response(JSON.stringify(pages[page - 1] ?? []), { status: 200 })
        : new Response('no', { status: code }),
    );
  }) as unknown as typeof fetch;
  return { impl, requested };
}

const betas = (page: number, count: number) =>
  Array.from({ length: count }, (_, i) =>
    apiRelease(`v9.${page}.${i}-beta.0`, { prerelease: true }),
  );

const betasCreated = (page: number, count: number, createdDay: number) =>
  Array.from({ length: count }, (_, i) =>
    apiRelease(`v9.${page}.${i}-beta.0`, { prerelease: true, created_at: day(createdDay) }),
  );

describe('fetchReleaseFeed', () => {
  test('pages past the date limit until it is 14 days below the newest unmarked CHANGELOG stable', async () => {
    const pages = [
      [
        apiRelease('v0.90.0', { body: marked('- Ninety.'), published_at: day(0) }),
        ...betasCreated(1, 99, 1),
      ],
      [
        apiRelease('v0.89.0', { body: marked('- Eighty-nine.'), published_at: day(2) }),
        ...betasCreated(2, 99, 3),
      ],
      [
        apiRelease('v0.88.0', { body: '- Before the marker.', published_at: day(9) }),
        ...betasCreated(3, 99, 10),
      ],
      [
        apiRelease('v0.87.0', { body: '- Old.', published_at: day(20) }),
        ...betasCreated(4, 99, 25),
      ],
      [apiRelease('v0.86.0', { body: marked('- Not read.') }), ...betasCreated(5, 99, 30)],
    ];
    const { impl, requested } = pagedFetch(pages);
    const feed = await fetchReleaseFeed({
      dateLimit: 1,
      changelogTags: new Set(['v0.88.0', 'v0.87.0']),
      fetchImpl: impl,
    });
    expect(requested).toEqual([1, 2, 3, 4]);
    expect([...feed.dates.keys()]).toEqual(['v0.90.0']);
    expect([...feed.notes.keys()]).toEqual(['v0.90.0', 'v0.89.0']);
    expect(feed.notesComplete).toBe(true);
    expect(feed.failure).toBeNull();
  });

  test('a revert or truncated stable published after marked bodies does not end the scan before them', async () => {
    const pages = [
      [
        apiRelease('v0.90.1', {
          body: '- Revert point release, unmarked.',
          created_at: day(1),
          published_at: day(1),
        }),
        ...betasCreated(1, 99, 2),
      ],
      [
        apiRelease('v0.90.0', {
          body: marked('- Ninety.'),
          created_at: day(4),
          published_at: day(3),
        }),
        ...betasCreated(2, 99, 16),
      ],
      [
        apiRelease('v0.89.0', {
          body: marked('- Eighty-nine.'),
          created_at: day(17),
          published_at: day(16),
        }),
        ...betasCreated(3, 99, 30),
      ],
      [
        apiRelease('v0.88.0', {
          body: '- Before the marker.',
          created_at: day(31),
          published_at: day(30),
        }),
        ...betasCreated(4, 99, 50),
      ],
      [apiRelease('v0.87.0', { body: marked('- Not read.') }), ...betasCreated(5, 99, 60)],
    ];
    const { impl, requested } = pagedFetch(pages);
    const feed = await fetchReleaseFeed({
      dateLimit: 1,
      changelogTags: new Set(['v0.90.1', 'v0.88.0']),
      fetchImpl: impl,
    });
    expect(requested).toEqual([1, 2, 3, 4]);
    expect([...feed.notes.keys()]).toEqual(['v0.90.0', 'v0.89.0']);
    expect(feed.notesComplete).toBe(true);
  });

  test('a newer marked stable listed after an unmarked point release is still read', async () => {
    const pages = [
      [
        apiRelease('v0.90.1', {
          body: '- Revert point release, unmarked.',
          created_at: day(1),
          published_at: day(1),
        }),
        ...betasCreated(1, 99, 1),
      ],
      [
        apiRelease('v0.91.0', {
          body: marked('- Promoted after the point release.'),
          created_at: day(2),
          published_at: day(0),
        }),
        apiRelease('v0.90.0', {
          body: marked('- Ninety.'),
          created_at: day(5),
          published_at: day(4),
        }),
        ...betasCreated(2, 98, 6),
      ],
      [
        apiRelease('v0.89.0', { body: '- Before the marker.', published_at: day(7) }),
        ...betasCreated(3, 99, 30),
      ],
      betasCreated(4, 100, 40),
    ];
    const { impl, requested } = pagedFetch(pages);
    const feed = await fetchReleaseFeed({
      dateLimit: 1,
      changelogTags: new Set(['v0.90.1', 'v0.89.0']),
      fetchImpl: impl,
    });
    expect(requested).toEqual([1, 2, 3]);
    expect([...feed.notes.keys()]).toEqual(['v0.91.0', 'v0.90.0']);
    expect(feed.notesComplete).toBe(true);
  });

  test('a short final page completes the notes even with no unmarked stable', async () => {
    const { impl } = pagedFetch([[apiRelease('v1.0.0', { body: marked('- One.') })]]);
    const feed = await fetchReleaseFeed({ changelogTags: new Set(), fetchImpl: impl });
    expect(feed.notesComplete).toBe(true);
    expect([...feed.notes.keys()]).toEqual(['v1.0.0']);
  });

  test('an HTTP error before the cutover leaves the notes incomplete and names the page and status', async () => {
    const { impl } = pagedFetch(
      [[apiRelease('v1.1.0', { body: marked('- New.') }), ...betas(1, 99)]],
      (page) => (page === 2 ? 502 : 200),
    );
    const feed = await fetchReleaseFeed({
      changelogTags: new Set(['v1.0.0']),
      fetchImpl: impl,
      sleep: noWait,
    });
    expect(feed.notesComplete).toBe(false);
    expect(feed.failure).toBe('page 2 returned HTTP 502');
    expect([...feed.dates.keys()]).toEqual(['v1.1.0']);
  });

  test('a 200 that is not a list of releases leaves the notes incomplete', async () => {
    const impl = (() =>
      Promise.resolve(json({ message: 'API rate limit exceeded' }))) as unknown as typeof fetch;
    const feed = await fetchReleaseFeed({ changelogTags: new Set(['v1.0.0']), fetchImpl: impl });
    expect(feed.notesComplete).toBe(false);
    expect(feed.failure).toBe('page 1 returned a body that is not a list of releases');
  });

  test('walks as many pages as the cutover is deep, so release volume alone never leaves the notes incomplete', async () => {
    const pages = [
      ...Array.from({ length: 40 }, (_, i) => [
        apiRelease(`v2.${i}.0`, { body: marked(`- Release ${i}.`), published_at: day(i) }),
        ...betasCreated(i, 99, i),
      ]),
      [
        apiRelease('v1.0.0', { body: '- Old.', published_at: day(60) }),
        ...betasCreated(40, 99, 80),
      ],
      [apiRelease('v0.9.0', { body: marked('- Not read.') })],
    ];
    const { impl, requested } = pagedFetch(pages);
    const feed = await fetchReleaseFeed({ changelogTags: new Set(['v1.0.0']), fetchImpl: impl });
    expect(requested).toEqual(Array.from({ length: 41 }, (_, i) => i + 1));
    expect(feed.notes.size).toBe(40);
    expect(feed.notesComplete).toBe(true);
    expect(feed.failure).toBeNull();
  });

  test('a listing that never ends stops at the runaway bound with a failure that says so', async () => {
    const { impl, requested } = pagedFetch(
      Array.from({ length: 10 }, (_, i) => [
        apiRelease(`v2.${i}.0`, { body: marked('- x') }),
        ...betas(i, 99),
      ]),
    );
    const feed = await fetchReleaseFeed({
      changelogTags: new Set(['v1.0.0']),
      fetchImpl: impl,
      runawayPages: 6,
    });
    expect(requested).toHaveLength(6);
    expect(feed.notesComplete).toBe(false);
    expect(feed.failure).toBe(
      'the Releases listing did not end within 6 pages and never reached the cutover',
    );
  });

  test('retries a transient 5xx, a network error and a short retry-after, with a deadline on every request', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    const deadlines: number[] = [];
    const issued: AbortSignal[] = [];
    const deadline = (ms: number) => {
      deadlines.push(ms);
      const signal = new AbortController().signal;
      issued.push(signal);
      return signal;
    };
    const scripted = (answers: (() => Response | Error)[]) => {
      const seen: (AbortSignal | null | undefined)[] = [];
      const impl = ((_url: string | URL, init?: RequestInit) => {
        seen.push(init?.signal);
        const next = answers.shift()?.();
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      }) as unknown as typeof fetch;
      return { impl, seen };
    };
    const page = () => json([apiRelease('v1.1.0', { body: marked('- New.') })]);
    const flaky = scripted([
      () => new Response('busy', { status: 503 }),
      () => new Error('socket hang up'),
      page,
    ]);
    const feed = await fetchReleaseFeed({
      changelogTags: new Set(['v1.0.0']),
      fetchImpl: flaky.impl,
      sleep,
      deadline,
    });
    expect(feed.failure).toBeNull();
    expect(feed.notesComplete).toBe(true);
    expect([...feed.notes.keys()]).toEqual(['v1.1.0']);
    expect(deadlines).toEqual([30_000, 30_000, 30_000]);
    expect(flaky.seen).toEqual(issued);
    expect(waits).toEqual([1000, 2000]);
    waits.length = 0;
    const limited = scripted([
      () => new Response('slow down', { status: 403, headers: { 'retry-after': '5' } }),
      page,
    ]);
    const throttled = await fetchReleaseFeed({
      changelogTags: new Set(['v1.0.0']),
      fetchImpl: limited.impl,
      sleep,
      deadline,
    });
    expect(throttled.failure).toBeNull();
    expect(waits).toEqual([5000]);
  });

  test('gives up on a page after three attempts and does not retry another 4xx', async () => {
    const { impl, requested } = pagedFetch([], () => 503);
    const failed = await fetchReleaseFeed({
      changelogTags: new Set(['v1.0.0']),
      fetchImpl: impl,
      sleep: noWait,
    });
    expect(requested).toEqual([1, 1, 1]);
    expect(failed.failure).toBe('page 1 returned HTTP 503');
    const forbidden = pagedFetch([], () => 403);
    const refused = await fetchReleaseFeed({
      changelogTags: new Set(['v1.0.0']),
      fetchImpl: forbidden.impl,
      sleep: noWait,
    });
    expect(forbidden.requested).toEqual([1]);
    expect(refused.failure).toBe('page 1 returned HTTP 403');
  });

  test('a rate limit that outlasts the retry-after cap, a spent primary limit and a refused token each fail at once, naming the cause', async () => {
    const cases: [() => Response, string][] = [
      [
        () => new Response('', { status: 429, headers: { 'retry-after': '60' } }),
        'page 1 was rate-limited (HTTP 429)',
      ],
      [
        () => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
        'page 1 was rate-limited (HTTP 403)',
      ],
      [
        () => new Response('', { status: 401 }),
        'page 1 returned HTTP 401: the GITHUB_TOKEN this build sent was refused',
      ],
    ];
    for (const [respond, failure] of cases) {
      const waits: number[] = [];
      let calls = 0;
      const impl = (() => {
        calls += 1;
        return Promise.resolve(respond());
      }) as unknown as typeof fetch;
      const feed = await fetchReleaseFeed({
        changelogTags: new Set(['v1.0.0']),
        fetchImpl: impl,
        sleep: async (ms) => {
          waits.push(ms);
        },
      });
      expect(feed.failure).toBe(failure);
      expect(calls).toBe(1);
      expect(waits).toEqual([]);
    }
  });

  test('a network failure names its page and the underlying cause, and an unparseable body names its page', async () => {
    const unreachable = (() =>
      Promise.reject(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), {
            code: 'ENOTFOUND',
          }),
        }),
      )) as unknown as typeof fetch;
    const offline = await fetchReleaseFeed({
      changelogTags: new Set(['v1.0.0']),
      fetchImpl: unreachable,
      sleep: noWait,
    });
    expect(offline.failure).toBe(
      'page 1 request failed after 3 attempts: fetch failed (ENOTFOUND)',
    );
    const html = (() =>
      Promise.resolve(new Response('<html>', { status: 200 }))) as unknown as typeof fetch;
    const garbled = await fetchReleaseFeed({ changelogTags: new Set(['v1.0.0']), fetchImpl: html });
    expect(garbled.failure).toMatch(/^page 1 returned a body that is not JSON: /);
  });

  test('a body read that times out or resets is retried, and reported as a request failure rather than as a body that is not JSON', async () => {
    const cut = (reason: () => Error) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(reason());
          },
        }),
        { status: 200 },
      );
    const answers = [
      cut(() => new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
      json([apiRelease('v1.1.0', { body: marked('- New.') })]),
    ];
    const waits: number[] = [];
    const recovered = await fetchReleaseFeed({
      changelogTags: new Set(['v1.0.0']),
      fetchImpl: (() => Promise.resolve(answers.shift())) as unknown as typeof fetch,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(recovered.failure).toBeNull();
    expect([...recovered.notes.keys()]).toEqual(['v1.1.0']);
    expect(waits).toEqual([1000]);
    let resets = 0;
    const reset = (() => {
      resets += 1;
      return Promise.resolve(
        cut(
          () =>
            new TypeError('terminated', {
              cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
            }),
        ),
      );
    }) as unknown as typeof fetch;
    waits.length = 0;
    const failed = await fetchReleaseFeed({
      changelogTags: new Set(['v1.0.0']),
      fetchImpl: reset,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(failed.failure).toBe(
      'page 1 request failed after 3 attempts: terminated (UND_ERR_SOCKET)',
    );
    expect(resets).toBe(3);
    expect(waits).toEqual([1000, 2000]);
  });

  test('warns about a published stable that has neither marked notes nor a CHANGELOG.md section', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { impl } = pagedFetch([
      [
        apiRelease('v1.2.0', { body: '- Unmarked, after the freeze.' }),
        apiRelease('v1.1.0', { body: marked('- New.') }),
        apiRelease('v1.0.0', { body: '- Old.' }),
      ],
    ]);
    await fetchReleaseFeed({ changelogTags: new Set(['v1.0.0']), fetchImpl: impl });
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /no notes-source marker and no packages\/cli\/CHANGELOG\.md section.*: v1\.2\.0\./,
      ),
    );
    warn.mockClear();
    const covered = pagedFetch([[apiRelease('v1.0.0', { body: '- Old.' })]]);
    await fetchReleaseFeed({ changelogTags: new Set(['v1.0.0']), fetchImpl: covered.impl });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test('a network throw leaves the notes incomplete and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const feed = await fetchReleaseFeed({
      changelogTags: new Set(['v1.0.0']),
      fetchImpl: (() => Promise.reject(new Error('offline'))) as never,
      sleep: noWait,
    });
    expect(feed).toEqual({
      dates: new Map(),
      notes: new Map(),
      notesComplete: false,
      failure: 'page 1 request failed after 3 attempts: offline',
    });
    warn.mockRestore();
  });
});

describe('releaseNotesRequired', () => {
  test('only a production Vercel build requires the Release bodies, unless the operator override is set', () => {
    expect(releaseNotesRequired({ VERCEL: '1', VERCEL_ENV: 'production' })).toBe(true);
    expect(releaseNotesRequired({ VERCEL: '1', VERCEL_ENV: 'preview' })).toBe(false);
    expect(releaseNotesRequired({ VERCEL: '1' })).toBe(false);
    expect(releaseNotesRequired({ CI: 'true' })).toBe(false);
    expect(releaseNotesRequired({})).toBe(false);
    expect(releaseNotesRequired({ VERCEL_ENV: 'production', [ALLOW_PARTIAL_CHANGELOG]: '1' })).toBe(
      false,
    );
    expect(
      releaseNotesRequired({ VERCEL_ENV: 'production', [ALLOW_PARTIAL_CHANGELOG]: 'true' }),
    ).toBe(true);
  });
});

describe('releaseNotesFrom', () => {
  const notes = new Map([['v1.0.0', '- One.']]);
  const incomplete = {
    dates: new Map(),
    notes,
    notesComplete: false,
    failure: 'page 2 returned HTTP 403',
  };

  const production = { VERCEL: '1', VERCEL_ENV: 'production' };

  test('passes complete notes through whether or not they are required', () => {
    const complete = { dates: new Map(), notes, notesComplete: true, failure: null };
    expect(releaseNotesFrom(complete, production)).toBe(notes);
    expect(releaseNotesFrom(complete, {})).toBe(notes);
  });

  test('incomplete notes fail a production build, naming the failure, GITHUB_TOKEN and the override', () => {
    expect(() => releaseNotesFrom(incomplete, production)).toThrow(
      /\(page 2 returned HTTP 403\).*CHANGELOG\.md is frozen.*GITHUB_TOKEN.*OK_ALLOW_PARTIAL_CHANGELOG=1/,
    );
  });

  test('a preview or local build drops incomplete notes with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(releaseNotesFrom(incomplete, { VERCEL: '1', VERCEL_ENV: 'preview' }).size).toBe(0);
    expect(releaseNotesFrom(incomplete, {}).size).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/\(page 2 returned HTTP 403\).*CHANGELOG\.md notes only/),
    );
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/PRODUCTION/));
    warn.mockRestore();
  });

  test('the override lets a production build publish with a warning that names it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      releaseNotesFrom(incomplete, { ...production, [ALLOW_PARTIAL_CHANGELOG]: '1' }).size,
    ).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /OK_ALLOW_PARTIAL_CHANGELOG=1 is set, so this PRODUCTION build publishes it/,
      ),
    );
    warn.mockRestore();
  });
});

describe('mergeReleaseNotes', () => {
  const changelog = parseChangelog(SAMPLE);

  test('with no marked notes it returns the CHANGELOG releases untouched', () => {
    expect(mergeReleaseNotes(changelog, new Map(), new Map())).toBe(changelog);
  });

  test('a marked body replaces that version and adds new ones, newest version first', () => {
    const dates = new Map([['v0.36.0', '2026-08-01T00:00:00Z']]);
    const out = mergeReleaseNotes(
      changelog,
      new Map([
        ['v0.36.0', '### Patch Changes\n\n- From the tag.'],
        ['v0.34.0', '### Patch Changes\n\n- Corrected in the Release body.'],
        ['v0.10.0', '### Patch Changes\n\n- Sorted by version, not text.'],
      ]),
      dates,
    );
    expect(out.map((r) => r.tag)).toEqual(['v0.36.0', 'v0.35.0', 'v0.34.0', 'v0.10.0', 'v0.9.1']);
    expect(out[0]).toEqual({
      tag: 'v0.36.0',
      title: 'v0.36.0',
      publishedAt: '2026-08-01T00:00:00Z',
      bodyHtml: expect.stringContaining('<li>From the tag.</li>'),
      htmlUrl: 'https://github.com/inkeep/open-knowledge/releases/tag/v0.36.0',
    });
    expect(out[2]?.bodyHtml).toContain('Corrected in the Release body.');
    expect(out[2]?.bodyHtml).not.toContain('95380ab');
    expect(out[1]).toBe(changelog[0]);
  });
});

describe('loadStableReleases', () => {
  const realChangelog = readFileSync(
    join(process.cwd(), '..', 'packages', 'cli', 'CHANGELOG.md'),
    'utf8',
  );
  const changelogTags = realChangelog
    .split('\n')
    .flatMap((line) => /^## (\d+\.\d+\.\d+)\s*$/.exec(line)?.slice(1) ?? [])
    .map((version) => `v${version}`);
  const unmarkedPages = () => {
    const releases = changelogTags.flatMap((tag, i) => [
      apiRelease(`${tag}-beta.0`, { prerelease: true, body: 'Beta.' }),
      apiRelease(tag, {
        body: `### Patch Changes\n\n- Unmarked ${i}.\n\n${DOWNLOADS}\n`,
        published_at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
      }),
    ]);
    return Array.from({ length: Math.ceil(releases.length / 100) }, (_, i) =>
      releases.slice(i * 100, i * 100 + 100),
    );
  };

  test('with no marked Release body it renders exactly what CHANGELOG.md alone renders today', async () => {
    const pages = unmarkedPages();
    const out = await loadStableReleases(undefined, { fetchImpl: pagedFetch(pages).impl });
    const dates = new Map<string, string>();
    for (const page of pages.slice(0, 5)) collectDates(page, dates, 30);
    expect(out).toEqual(parseChangelog(realChangelog, dates));
    expect(dates.size).toBe(30);
  });

  test('a marked stable shows its Release body; every other version keeps its CHANGELOG.md notes', async () => {
    const pages = unmarkedPages();
    pages[0]?.unshift(
      apiRelease('v99.0.0', { body: marked('### Minor Changes\n\n- From the stable tag.') }),
    );
    const out = await loadStableReleases(undefined, { fetchImpl: pagedFetch(pages).impl });
    expect(out[0]?.tag).toBe('v99.0.0');
    expect(out[0]?.bodyHtml).toContain('<li>From the stable tag.</li>');
    expect(out[0]?.bodyHtml).not.toContain('Downloads');
    const changelogOnly = parseChangelog(realChangelog, new Map());
    expect(out.slice(1).map((r) => [r.tag, r.bodyHtml])).toEqual(
      changelogOnly.map((r) => [r.tag, r.bodyHtml]),
    );
  });

  test('a production build fails when the Release bodies cannot be read, rather than drop every newer stable', async () => {
    const env = { VERCEL: '1', VERCEL_ENV: 'production' };
    await expect(
      loadStableReleases(undefined, {
        fetchImpl: pagedFetch([], () => 503).impl,
        env,
        sleep: noWait,
      }),
    ).rejects.toThrow(/page 1 returned HTTP 503.*CHANGELOG\.md is frozen/);
    const offline = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      loadStableReleases(undefined, { fetchImpl: offline, env, sleep: noWait }),
    ).rejects.toThrow(/attempts: offline\)/);
    warn.mockRestore();
  });

  test('the Release fetch sends GITHUB_TOKEN when the build has one, and nothing when it does not', async () => {
    const seen: (string | null)[] = [];
    const recording = ((_url: string | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('authorization'));
      return Promise.resolve(new Response('[]', { status: 200 }));
    }) as unknown as typeof fetch;
    vi.stubEnv('GITHUB_TOKEN', 'ghs_fixture');
    try {
      await fetchReleaseFeed({ changelogTags: new Set(), fetchImpl: recording });
    } finally {
      vi.unstubAllEnvs();
    }
    vi.stubEnv('GITHUB_TOKEN', '');
    try {
      await fetchReleaseFeed({ changelogTags: new Set(), fetchImpl: recording });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(seen).toEqual(['Bearer ghs_fixture', null]);
  });

  test('outside production, unreadable Release bodies fall back to CHANGELOG.md alone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await loadStableReleases(undefined, {
      fetchImpl: pagedFetch([], () => 503).impl,
      env: { VERCEL: '1', VERCEL_ENV: 'preview' },
      sleep: noWait,
    });
    expect(out).toEqual(parseChangelog(realChangelog, new Map()));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/CHANGELOG\.md notes only/));
    warn.mockRestore();
  });
});
