import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildWorkspaceEntries,
  classifyOmnibarSearchHint,
  EMPTY_QUERY_NAV_LIMIT,
  fetchWorkspaceSearchEntries,
  matchesCommandQuery,
  searchWorkspaceEntries,
  splitTextByQueryMatches,
  type WorkspaceEntry,
  type WorkspaceSearchEntry,
} from './command-palette-search';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('buildWorkspaceEntries', () => {
  test('builds sorted file and folder entries from page and folder sets', () => {
    const entries = buildWorkspaceEntries(
      new Set(['notes/zebra', 'alpha', 'notes/atlas']),
      new Set(['notes', 'docs']),
    );

    expect(entries).toEqual([
      { kind: 'file', path: 'alpha', name: 'alpha' },
      { kind: 'folder', path: 'docs', name: 'docs' },
      { kind: 'folder', path: 'notes', name: 'notes' },
      { kind: 'file', path: 'notes/atlas', name: 'atlas' },
      { kind: 'file', path: 'notes/zebra', name: 'zebra' },
    ]);
  });
  // non-markdown files are first-class omnibar entries.
  test('admits non-markdown filePaths as kind:file entries with bodyIndexed:false', () => {
    const entries = buildWorkspaceEntries(
      new Set(['notes/guide']),
      new Set(['notes']),
      new Map(),
      new Map(),
      new Set(['data/example.csv', 'packages/app/src/index.ts']),
    );

    expect(entries).toEqual([
      {
        kind: 'file',
        path: 'data/example.csv',
        name: 'example.csv',
        bodyIndexed: false,
      },
      { kind: 'folder', path: 'notes', name: 'notes' },
      { kind: 'file', path: 'notes/guide', name: 'guide' },
      {
        kind: 'file',
        path: 'packages/app/src/index.ts',
        name: 'index.ts',
        bodyIndexed: false,
      },
    ]);
  });

  test('threads page docExt metadata onto markdown page entries', () => {
    const entries = buildWorkspaceEntries(
      new Set(['docs/component']),
      new Set(),
      new Map(),
      new Map([
        ['docs/component', { size: 100, modified: '2026-06-24T00:00:00.000Z', docExt: '.mdx' }],
      ]),
    );

    expect(entries[0]).toMatchObject({
      kind: 'file',
      path: 'docs/component',
      name: 'component',
      docExt: '.mdx',
    });
  });
  // Pages take precedence on path collision — a markdown page `notes/foo` (no
  // extension) would never collide with a non-markdown `notes/foo.csv`, but
  // the filePaths set MAY redundantly include a path that's already a page
  // when the wire bytes drift (the server is the source of truth on this
  // partition; the dedup is defensive).
  test('skips a non-markdown file already present in pages', () => {
    const entries = buildWorkspaceEntries(
      new Set(['data/example.csv']),
      new Set(),
      new Map(),
      new Map(),
      new Set(['data/example.csv']),
    );
    expect(entries).toEqual([{ kind: 'file', path: 'data/example.csv', name: 'example.csv' }]);
  });
});

describe('searchWorkspaceEntries with non-markdown files', () => {
  // a tracked non-markdown file is findable in ⌘K by name AND partial
  // path/folder. Exercised against the local corpus (per-keystroke), the
  // path /api/search backs at higher latency.
  const entries = buildWorkspaceEntries(
    new Set(['notes/guide', 'roadmap']),
    new Set(['notes', 'docs']),
    new Map(),
    new Map(),
    new Set(['data/example.csv', 'packages/app/src/components/FileTree.tsx']),
  );

  test('finds a non-markdown file by basename', () => {
    const results = searchWorkspaceEntries(entries, 'FileTree');
    expect(results.map((entry) => entry.path)).toContain(
      'packages/app/src/components/FileTree.tsx',
    );
  });

  test('finds a non-markdown file by extension', () => {
    const results = searchWorkspaceEntries(entries, 'csv');
    expect(results.map((entry) => entry.path)).toContain('data/example.csv');
  });

  test('finds a non-markdown file by partial folder path', () => {
    const results = searchWorkspaceEntries(entries, 'components');
    expect(results.map((entry) => entry.path)).toContain(
      'packages/app/src/components/FileTree.tsx',
    );
  });

  test('a markdown page maps to the page tier and outranks a lexically-tied non-markdown sibling', () => {
    // Pins the default-page mapping in the corpus builder: a markdown
    // WorkspaceEntry (no bodyIndexed) must enter as a page, NOT a file. Both
    // entries share the basename `alpha`, so the lexical match is identical
    // and only the canonical-first kind demotion decides order. If the mapping
    // inverted (markdown -> file), the markdown page would take the demotion
    // and the non-markdown file would rank first. The non-markdown entry is
    // listed first to prove ordering is by rank, not input order.
    const tieEntries: WorkspaceEntry[] = [
      { kind: 'file', path: 'data/alpha', name: 'alpha', bodyIndexed: false },
      { kind: 'file', path: 'notes/alpha', name: 'alpha' },
    ];
    const results = searchWorkspaceEntries(tieEntries, 'alpha');
    expect(results[0]).toEqual({ kind: 'file', path: 'notes/alpha', name: 'alpha' });
  });
});

describe('searchWorkspaceEntries', () => {
  const entries = buildWorkspaceEntries(
    new Set(['architecture/overview', 'docs/api', 'docs/graph-guide', 'notes/graphing', 'roadmap']),
    new Set(['architecture', 'docs', 'notes']),
  );

  test('returns a capped alphabetical list for the empty query', () => {
    const results = searchWorkspaceEntries(entries, '');
    expect(results.length).toBeLessThanOrEqual(EMPTY_QUERY_NAV_LIMIT);
    expect(results[0]?.path).toBe('architecture');
  });

  test('prefers exact basename match over prefix and substring matches', () => {
    const results = searchWorkspaceEntries(entries, 'api');
    expect(results.map((entry) => entry.path)).toEqual(['docs/api']);
  });

  test('prefers basename prefix matches before plain substring path matches', () => {
    const results = searchWorkspaceEntries(entries, 'graph');
    expect(results.map((entry) => entry.path)).toEqual(['docs/graph-guide', 'notes/graphing']);
  });

  test('matches folder paths as well as files', () => {
    const results = searchWorkspaceEntries(entries, 'arch');
    expect(results[0]).toEqual({ kind: 'folder', path: 'architecture', name: 'architecture' });
  });

  test('breaks ties alphabetically by path', () => {
    const tieEntries = buildWorkspaceEntries(new Set(['b/docs', 'a/docs']), new Set());
    const results = searchWorkspaceEntries(tieEntries, 'docs');
    expect(results.map((entry) => entry.path)).toEqual(['a/docs', 'b/docs']);
  });
});

// the search-hint affordance classifier. Pin the four modes
// the omnibar branches on so the rendered hint is auditable from one site.
describe('classifyOmnibarSearchHint', () => {
  test('idle on empty / whitespace query regardless of results', () => {
    expect(classifyOmnibarSearchHint('', [])).toBe('idle');
    expect(classifyOmnibarSearchHint('   ', [])).toBe('idle');
    const someResults: WorkspaceEntry[] = [{ kind: 'file', path: 'notes/foo', name: 'foo' }];
    expect(classifyOmnibarSearchHint('', someResults)).toBe('idle');
  });

  test('empty on non-empty query with zero results', () => {
    expect(classifyOmnibarSearchHint('mystery', [])).toBe('empty');
  });

  test('name-only when results exist but no entry carries a snippet', () => {
    const results: WorkspaceEntry[] = [
      { kind: 'file', path: 'notes/foo', name: 'foo' },
      { kind: 'folder', path: 'notes', name: 'notes' },
      { kind: 'file', path: 'data/example.csv', name: 'example.csv', bodyIndexed: false },
    ];
    expect(classifyOmnibarSearchHint('foo', results)).toBe('name-only');
  });

  test('content when at least one entry carries a non-empty snippet', () => {
    const results: WorkspaceSearchEntry[] = [
      {
        kind: 'file',
        path: 'notes/foo',
        name: 'foo',
        snippet: '… the matched body fragment …',
      },
    ];
    expect(classifyOmnibarSearchHint('matched', results)).toBe('content');
  });

  test('an empty-string snippet does NOT count as a content hit', () => {
    const results: WorkspaceSearchEntry[] = [
      { kind: 'file', path: 'notes/foo', name: 'foo', snippet: '' },
    ];
    expect(classifyOmnibarSearchHint('foo', results)).toBe('name-only');
  });

  test('mixed name-only + one content hit still classifies as content (hint absent)', () => {
    const results: Array<WorkspaceEntry | WorkspaceSearchEntry> = [
      { kind: 'folder', path: 'docs', name: 'docs' },
      { kind: 'file', path: 'notes/x', name: 'x' },
      { kind: 'file', path: 'notes/body-match', name: 'body-match', snippet: '… excerpt …' },
    ];
    expect(classifyOmnibarSearchHint('excerpt', results)).toBe('content');
  });

  // truncation observability: when /api/search reports the corpus hit
  // the `OK_SEARCH_MAX_ENTRIES` cap, the classifier returns `'truncated'` in
  // preference to `'name-only'` / `'content'` — a user looking for a missing
  // file needs the cap signal regardless of how the surviving results rank.
  test('truncated:true overrides name-only when there are results', () => {
    const results: WorkspaceEntry[] = [{ kind: 'file', path: 'notes/foo', name: 'foo' }];
    expect(classifyOmnibarSearchHint('foo', results, { truncated: true })).toBe('truncated');
  });

  test('truncated:true overrides content when at least one snippet is present', () => {
    const results: WorkspaceSearchEntry[] = [
      { kind: 'file', path: 'notes/foo', name: 'foo', snippet: '… match …' },
    ];
    expect(classifyOmnibarSearchHint('match', results, { truncated: true })).toBe('truncated');
  });

  test('truncated does NOT override empty (no surviving results means no surface to point at)', () => {
    expect(classifyOmnibarSearchHint('foo', [], { truncated: true })).toBe('empty');
  });

  test('truncated does NOT override idle (no query → no hint at all)', () => {
    expect(classifyOmnibarSearchHint('', [], { truncated: true })).toBe('idle');
  });
});

describe('matchesCommandQuery', () => {
  test('matches empty query', () => {
    expect(matchesCommandQuery('New file', '')).toBe(true);
  });

  test('matches label text and keyword text case-insensitively', () => {
    expect(matchesCommandQuery('Open graph', 'graph')).toBe(true);
    expect(matchesCommandQuery('Open graph', 'claude', ['open in claude code'])).toBe(true);
  });

  test('returns false when neither label nor keywords include the query', () => {
    expect(matchesCommandQuery('Open graph', 'cursor')).toBe(false);
  });
});

describe('splitTextByQueryMatches', () => {
  test('marks query words case-insensitively', () => {
    expect(splitTextByQueryMatches('Homepage content on the home page', 'homepage home')).toEqual([
      { text: 'Homepage', match: true, start: 0 },
      { text: ' content on the ', match: false, start: 8 },
      { text: 'home', match: true, start: 24 },
      { text: ' page', match: false, start: 28 },
    ]);
  });

  test('treats regex metacharacters as literal query text', () => {
    expect(splitTextByQueryMatches('Use api/search?query=home', 'api/search?query=home')).toEqual([
      { text: 'Use ', match: false, start: 0 },
      { text: 'api/search?query=home', match: true, start: 4 },
    ]);
  });
});

describe('fetchWorkspaceSearchEntries', () => {
  test('posts a full-text search request and maps server rows to palette entries', async () => {
    let requestBody: unknown = null;
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          // flat success body — no `{ ok: true }` wrapper. The MCP
          // shim's normalizeResponse synthesizes `ok: true` for in-process
          // consumers, but the wire is flat. Mirrors the actual server
          // contract emitted by handleSearch.
          results: [
            {
              kind: 'page',
              path: 'THIRD_PARTY_NOTICES',
              title: 'Third Party Notices',
              snippet: 'Homepage: https://example.test',
              score: 42,
            },
            { kind: 'folder', path: 'docs', title: 'docs', score: 12 },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const { entries, truncated } = await fetchWorkspaceSearchEntries('homepage');

    expect(requestBody).toEqual({
      query: 'homepage',
      intent: 'full_text',
      // Per-keystroke nav ranks name-first over the full_text candidate set.
      ranking: 'navigation',
      // `'file'` joins the scope set so /api/search returns
      // name-only non-markdown rows alongside the existing page / folder /
      // content tiers.
      scopes: ['page', 'folder', 'content', 'file'],
      limit: 50,
      source: 'omnibar',
    });
    expect(entries).toEqual([
      {
        kind: 'file',
        path: 'THIRD_PARTY_NOTICES',
        name: 'THIRD_PARTY_NOTICES',
        title: 'Third Party Notices',
        snippet: 'Homepage: https://example.test',
        score: 42,
      },
      { kind: 'folder', path: 'docs', name: 'docs', title: 'docs', score: 12 },
    ]);
    expect(truncated).toBe(false);
  });

  test('semantic submit adds semantic:true (keeps full_text + scopes + source:omnibar)', async () => {
    let requestBody: unknown = null;
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as typeof fetch;

    await fetchWorkspaceSearchEntries('auth retries', { semantic: true });

    expect(requestBody).toEqual({
      query: 'auth retries',
      intent: 'full_text',
      // The deliberate "by meaning" submit keeps the body-weighted ranking.
      ranking: 'relevance',
      // `'file'` is part of the omnibar's scope set so the
      // server's name-only `kind:'file'` corpus tier surfaces results.
      scopes: ['page', 'folder', 'content', 'file'],
      limit: 50,
      source: 'omnibar',
      semantic: true,
    });
  });

  // the server's `kind:'file'` row (a tracked non-markdown
  // file from the all-files corpus) collapses into the same client
  // `kind:'file'` entry as a markdown page. Without this mapping every
  // non-markdown hit returned by /api/search would silently drop on the
  // client.
  test('maps a kind:file server row to a client kind:file name-only entry', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              kind: 'file',
              path: 'assets/photo.png',
              title: 'assets/photo.png',
              score: 7,
            },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;

    const { entries } = await fetchWorkspaceSearchEntries('csv');

    expect(entries).toEqual([
      {
        kind: 'file',
        path: 'assets/photo.png',
        name: 'photo.png',
        bodyIndexed: false,
        title: 'assets/photo.png',
        score: 7,
      },
    ]);
  });

  test('threads `truncated:true` from the server response into the result', async () => {
    // truncation observability: when the corpus build hit
    // `OK_SEARCH_MAX_ENTRIES` and dropped deepest-tail paths, the wire payload
    // carries `truncated: true`. The omnibar uses it to surface a "results
    // capped" hint via `classifyOmnibarSearchHint({ truncated })` so a missing
    // file reads as a cap artifact rather than a typo. Default is false.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ results: [], truncated: true }), {
        status: 200,
      })) as typeof fetch;
    const { truncated } = await fetchWorkspaceSearchEntries('overflowing');
    expect(truncated).toBe(true);
  });
});
