import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { HeadingEntry } from '@inkeep/open-knowledge-core';
import { __resetDocumentListInflightForTests } from '@/lib/documents-fetch';
import {
  autocompleteBoost,
  buildAnchorItems,
  buildSuggestionItems,
  computeFallbackAttrs,
  fetchPages,
  filterPages,
  isSkillFolderDoc,
  loadWikiLinkContext,
  type PageItem,
  parseQuery,
  type WikiLinkContext,
  wikiLinkMatcher,
} from './wiki-link-suggestion';

const pages: PageItem[] = [
  { docName: 'test-doc', title: 'Test Document' },
  { docName: 'release-notes', title: 'Release Notes' },
  { docName: 'qa-source', title: 'QA Source File' },
];

describe('parseQuery', () => {
  test('page mode when query has no #', () => {
    expect(parseQuery('release-notes')).toEqual({
      mode: 'page',
      pageTarget: '',
      anchorQuery: '',
    });
  });

  test('anchor mode when # has non-empty left side', () => {
    expect(parseQuery('release-notes#changes')).toEqual({
      mode: 'anchor',
      pageTarget: 'release-notes',
      anchorQuery: 'changes',
    });
  });

  test('anchor mode with empty anchor query', () => {
    expect(parseQuery('release-notes#')).toEqual({
      mode: 'anchor',
      pageTarget: 'release-notes',
      anchorQuery: '',
    });
  });

  test('page mode when # is at position 0', () => {
    expect(parseQuery('#heading')).toEqual({
      mode: 'page',
      pageTarget: '',
      anchorQuery: '',
    });
  });

  test('page mode for empty query', () => {
    expect(parseQuery('')).toEqual({
      mode: 'page',
      pageTarget: '',
      anchorQuery: '',
    });
  });
});

describe('buildSuggestionItems', () => {
  test('returns all pages (up to MAX_ITEMS) when query is empty', () => {
    const items = buildSuggestionItems(pages, '');
    expect(items).toEqual([
      { kind: 'page', docName: 'test-doc', title: 'Test Document' },
      { kind: 'page', docName: 'release-notes', title: 'Release Notes' },
      { kind: 'page', docName: 'qa-source', title: 'QA Source File' },
    ]);
  });

  test('returns matching pages when results exist', () => {
    expect(buildSuggestionItems(pages, 'test')).toEqual([
      {
        kind: 'page',
        docName: 'test-doc',
        title: 'Test Document',
      },
    ]);
  });

  test('matches by docName when title differs', () => {
    expect(buildSuggestionItems(pages, 'qa-source')).toEqual([
      {
        kind: 'page',
        docName: 'qa-source',
        title: 'QA Source File',
      },
    ]);
  });

  test('returns referenced asset suggestions', () => {
    expect(
      buildSuggestionItems(
        [...pages, { kind: 'asset', docName: '/docs/public/Wide.png', title: 'Wide.png' }],
        'wide',
      ),
    ).toEqual([
      {
        kind: 'asset',
        target: '/docs/public/Wide.png',
        path: 'docs/public/Wide.png',
        title: 'Wide.png',
      },
    ]);
  });

  test('returns a selectable create action when there are no matches', () => {
    expect(buildSuggestionItems(pages, 'A Brand New Page')).toEqual([
      {
        kind: 'create',
        docName: 'a-brand-new-page',
        title: 'A Brand New Page',
        actionLabel: 'Insert unresolved link "A Brand New Page"',
      },
    ]);
  });
});

describe('buildAnchorItems', () => {
  const headings: HeadingEntry[] = [
    { level: 1, text: 'Introduction', slug: 'introduction' },
    { level: 2, text: 'Getting Started', slug: 'getting-started' },
    { level: 3, text: 'Prerequisites', slug: 'prerequisites' },
  ];

  test('returns all headings when anchorQuery is empty', () => {
    expect(buildAnchorItems('release-notes', headings, '')).toEqual([
      {
        kind: 'anchor',
        docName: 'release-notes',
        level: 1,
        text: 'Introduction',
        slug: 'introduction',
      },
      {
        kind: 'anchor',
        docName: 'release-notes',
        level: 2,
        text: 'Getting Started',
        slug: 'getting-started',
      },
      {
        kind: 'anchor',
        docName: 'release-notes',
        level: 3,
        text: 'Prerequisites',
        slug: 'prerequisites',
      },
    ]);
  });

  test('filters headings by anchorQuery', () => {
    const items = buildAnchorItems('release-notes', headings, 'get');
    expect(items).toEqual([
      {
        kind: 'anchor',
        docName: 'release-notes',
        level: 2,
        text: 'Getting Started',
        slug: 'getting-started',
      },
    ]);
  });

  test('returns empty array when no headings match', () => {
    expect(buildAnchorItems('release-notes', headings, 'zzzznothing')).toEqual([]);
  });

  test('maps HeadingEntry fields correctly to WikiLinkSuggestionItem', () => {
    const single: HeadingEntry[] = [{ level: 4, text: 'Deep Section', slug: 'deep-section' }];
    expect(buildAnchorItems('my-doc', single, '')).toEqual([
      { kind: 'anchor', docName: 'my-doc', level: 4, text: 'Deep Section', slug: 'deep-section' },
    ]);
  });
});

describe('computeFallbackAttrs', () => {
  test('returns null for empty query (unslugable)', () => {
    expect(computeFallbackAttrs('')).toBeNull();
  });

  test('returns null for whitespace-only query', () => {
    expect(computeFallbackAttrs('   ')).toBeNull();
  });

  test('page mode: derives unresolved link attrs from query', () => {
    expect(computeFallbackAttrs('My New Page')).toEqual({
      target: 'my-new-page',
      alias: 'My New Page',
      anchor: null,
    });
  });

  test('page mode: slug equals original when already slugified', () => {
    expect(computeFallbackAttrs('already-slug')).toEqual({
      target: 'already-slug',
      alias: null,
      anchor: null,
    });
  });

  test('anchor mode: inserts target + anchor when both present', () => {
    expect(computeFallbackAttrs('release-notes#changes')).toEqual({
      target: 'release-notes',
      alias: null,
      anchor: 'changes',
    });
  });

  test('anchor mode: anchor null when only hash is typed', () => {
    expect(computeFallbackAttrs('release-notes#')).toEqual({
      target: 'release-notes',
      alias: null,
      anchor: null,
    });
  });

  test('anchor mode: anchor null when anchor query is whitespace-only', () => {
    expect(computeFallbackAttrs('release-notes#   ')).toEqual({
      target: 'release-notes',
      alias: null,
      anchor: null,
    });
  });

  test('leading hash is treated as page mode, not anchor mode', () => {
    // parseQuery only treats `#` as anchor separator when it has a non-empty left side
    expect(computeFallbackAttrs('#bar')).toEqual({
      target: 'bar',
      alias: '#bar',
      anchor: null,
    });
  });
});

describe('wikiLinkMatcher', () => {
  /** Stub that satisfies the subset of ResolvedPos used by wikiLinkMatcher. */
  function stubPosition(textBefore: string, blockStart: number) {
    const cursorPos = blockStart + textBefore.length;
    return {
      $position: {
        parent: {
          textBetween: () => textBefore,
        },
        parentOffset: textBefore.length,
        start: () => blockStart,
        pos: cursorPos,
      },
    };
  }

  test('matches [[ at start of block', () => {
    const result = wikiLinkMatcher(stubPosition('[[', 1) as never);
    expect(result).toEqual({
      range: { from: 1, to: 3 },
      query: '',
      text: '[[',
    });
  });

  test('matches [[ with query text', () => {
    const result = wikiLinkMatcher(stubPosition('[[release-notes', 1) as never);
    expect(result).toEqual({
      range: { from: 1, to: 16 },
      query: 'release-notes',
      text: '[[release-notes',
    });
  });

  test('matches [[ with anchor query (# included in query)', () => {
    const result = wikiLinkMatcher(stubPosition('[[page#heading', 1) as never);
    expect(result).toEqual({
      range: { from: 1, to: 15 },
      query: 'page#heading',
      text: '[[page#heading',
    });
  });

  test('matches [[ after preceding text', () => {
    const result = wikiLinkMatcher(stubPosition('some text [[foo', 1) as never);
    expect(result).toEqual({
      range: { from: 11, to: 16 },
      query: 'foo',
      text: '[[foo',
    });
  });

  test('returns null when no [[ found', () => {
    expect(wikiLinkMatcher(stubPosition('no brackets here', 1) as never)).toBeNull();
  });

  test('returns null when ] appears after [[ (closed bracket)', () => {
    expect(wikiLinkMatcher(stubPosition('[[done]', 1) as never)).toBeNull();
  });
});

describe('fetchPages', () => {
  const realFetch = globalThis.fetch;

  function pageEntry(docName: string, title: string) {
    return { docName, title, docExt: '.md', size: 1, modified: '2026-06-24T00:00:00.000Z' };
  }

  /** Stub `/api/pages` + `/api/documents` with caller-supplied JSON bodies. */
  function stubFetch(pagesBody: unknown, documentsBody: unknown) {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = url.startsWith('/api/pages') ? pagesBody : documentsBody;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
  }

  beforeEach(() => {
    stubFetch({ pages: [] }, { documents: [] });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    // fetchPages routes /api/documents through the module-global single-flight;
    // clear the slot so a case that leaves a request in flight can't leak a
    // stale coalesced promise into the next test.
    __resetDocumentListInflightForTests();
  });

  test('a folder row survives and maps to a kind:"folder" PageItem', async () => {
    stubFetch(
      { pages: [pageEntry('notes', 'Notes')] },
      {
        documents: [
          { kind: 'folder', path: 'specs/foo', size: 0, modified: '2026-06-24T00:00:00.000Z' },
        ],
      },
    );

    const result = await fetchPages();
    const folder = result.find((item) => item.kind === 'folder');
    expect(folder).toEqual({ kind: 'folder', docName: 'specs/foo', title: 'foo' });
  });

  test('a top-level folder titles from its bare path', async () => {
    stubFetch(
      { pages: [] },
      { documents: [{ kind: 'folder', path: 'specs', modified: '2026-06-24T00:00:00.000Z' }] },
    );

    const result = await fetchPages();
    expect(result).toContainEqual({ kind: 'folder', docName: 'specs', title: 'specs' });
  });

  test('keeps pages, assets, and folders together; drops other kinds', async () => {
    stubFetch(
      { pages: [pageEntry('notes', 'Notes')] },
      {
        documents: [
          { kind: 'folder', path: 'guides', modified: '2026-06-24T00:00:00.000Z' },
          { kind: 'asset', path: 'img/diagram.png' },
          { kind: 'file', path: 'ignored.md' },
        ],
      },
    );

    const result = await fetchPages();
    expect(result.map((item) => item.kind)).toEqual(['page', 'asset', 'folder']);
  });

  test('folders with an empty path are dropped', async () => {
    stubFetch(
      { pages: [] },
      { documents: [{ kind: 'folder', path: '', modified: '2026-06-24T00:00:00.000Z' }] },
    );

    const result = await fetchPages();
    expect(result.some((item) => item.kind === 'folder')).toBe(false);
  });
});

describe('isSkillFolderDoc', () => {
  test('matches docs under .agents / .claude / .cursor at any depth', () => {
    expect(isSkillFolderDoc('.claude/skills/foo/SKILL')).toBe(true);
    expect(isSkillFolderDoc('.agents/rules/bar')).toBe(true);
    expect(isSkillFolderDoc('.cursor/rules/baz')).toBe(true);
    expect(isSkillFolderDoc('public/open-knowledge/.claude/skills/x')).toBe(true);
  });

  test('does not match ordinary docs or look-alike folder names', () => {
    expect(isSkillFolderDoc('guides/getting-started')).toBe(false);
    expect(isSkillFolderDoc('claude/notes')).toBe(false); // no leading dot
    expect(isSkillFolderDoc('agents-overview')).toBe(false);
  });
});

describe('autocompleteBoost', () => {
  const ctx = (over: Partial<WikiLinkContext> = {}): WikiLinkContext => ({
    currentDocName: null,
    connectedDocNames: new Set(),
    ...over,
  });

  test('penalizes skill-folder docs', () => {
    expect(autocompleteBoost('.claude/skills/foo/SKILL', ctx())).toBe(-200);
  });

  test('boosts the current page and link-graph neighbors, neighbor > current', () => {
    expect(autocompleteBoost('current', ctx({ currentDocName: 'current' }))).toBe(50);
    expect(autocompleteBoost('neighbor', ctx({ connectedDocNames: new Set(['neighbor']) }))).toBe(
      100,
    );
  });

  test('combines penalty and link boost additively (a linked skill is still demoted)', () => {
    const linkedSkill = autocompleteBoost(
      '.claude/skills/foo/SKILL',
      ctx({ connectedDocNames: new Set(['.claude/skills/foo/SKILL']) }),
    );
    expect(linkedSkill).toBe(-100);
  });

  test('returns 0 for an ordinary doc with empty context', () => {
    expect(autocompleteBoost('guides/intro', ctx())).toBe(0);
  });
});

describe('context-aware ranking', () => {
  test('empty query: neighbors and current page float up, skills sink', () => {
    const corpus: PageItem[] = [
      { docName: 'alpha', title: 'Alpha' },
      { docName: '.claude/skills/foo/SKILL', title: 'Foo' },
      { docName: 'beta', title: 'Beta' },
      { docName: 'gamma', title: 'Gamma' },
    ];
    const context: WikiLinkContext = {
      currentDocName: 'beta',
      connectedDocNames: new Set(['gamma']),
    };
    expect(filterPages(corpus, '', context).map((p) => p.docName)).toEqual([
      'gamma', // linked neighbor (+100)
      'beta', // current page (+50)
      'alpha', // ordinary (0)
      '.claude/skills/foo/SKILL', // skill (-200)
    ]);
  });

  test('empty query without context preserves source order (byte-identical to slice)', () => {
    const corpus: PageItem[] = [
      { docName: 'alpha', title: 'Alpha' },
      { docName: 'beta', title: 'Beta' },
      { docName: 'gamma', title: 'Gamma' },
    ];
    expect(filterPages(corpus, '').map((p) => p.docName)).toEqual(['alpha', 'beta', 'gamma']);
  });

  test('typed query: a skill is deprioritized below a stronger non-skill match but still listed', () => {
    const corpus: PageItem[] = [
      { docName: '.claude/skills/notes/SKILL', title: 'Project notes overview' },
      { docName: 'notes', title: 'Notes' },
    ];
    expect(filterPages(corpus, 'notes').map((p) => p.docName)).toEqual([
      'notes',
      '.claude/skills/notes/SKILL',
    ]);
  });

  test('typed query: a linked neighbor outranks an equal-tier non-linked match', () => {
    const corpus: PageItem[] = [
      { docName: 'guide-alpha', title: 'Guide alpha' },
      { docName: 'guide-beta', title: 'Guide beta' },
    ];
    const context: WikiLinkContext = {
      currentDocName: 'somewhere-else',
      connectedDocNames: new Set(['guide-beta']),
    };
    expect(filterPages(corpus, 'guide', context).map((p) => p.docName)).toEqual([
      'guide-beta',
      'guide-alpha',
    ]);
  });

  test('typed query: a boosted neighbor ranked outside the natural top-8 still surfaces', () => {
    // 9 equal-tier matches; without context the alphabetical tiebreak drops
    // item-9 to 9th, outside the MAX_ITEMS=8 cap. This pins the widened
    // candidate window (limit 100 → trim 8): reverting to limit MAX_ITEMS would
    // stop returning item-9 as a candidate at all, so the boost could not pull
    // it in and this test would fail.
    const corpus: PageItem[] = Array.from({ length: 9 }, (_, i) => ({
      docName: `item-${i + 1}`,
      title: `Item ${i + 1}`,
    }));
    const noContext = filterPages(corpus, 'item').map((p) => p.docName);
    expect(noContext).toHaveLength(8);
    expect(noContext).not.toContain('item-9');

    const withNeighbor = filterPages(corpus, 'item', {
      currentDocName: 'elsewhere',
      connectedDocNames: new Set(['item-9']),
    }).map((p) => p.docName);
    expect(withNeighbor).toContain('item-9');
  });
});

describe('loadWikiLinkContext', () => {
  const realFetch = globalThis.fetch;

  /** Stub `/api/forward-links` + `/api/backlinks` with per-route status/body. */
  function stubLinks(routes: {
    forward?: { status?: number; body: unknown };
    back?: { status?: number; body: unknown };
  }) {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const route = url.startsWith('/api/forward-links')
        ? routes.forward
        : url.startsWith('/api/backlinks')
          ? routes.back
          : undefined;
      const status = route?.status ?? (route ? 200 : 404);
      return new Response(JSON.stringify(route?.body ?? {}), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('returns an empty context for a null docName without fetching', async () => {
    let called = false;
    globalThis.fetch = mock(async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch;
    const ctx = await loadWikiLinkContext(null);
    expect(ctx).toEqual({ currentDocName: null, connectedDocNames: new Set() });
    expect(called).toBe(false);
  });

  test('merges outgoing doc links with incoming sources and excludes external links', async () => {
    stubLinks({
      forward: {
        body: {
          docName: 'me',
          forwardLinks: [
            { kind: 'doc', docName: 'out-a', anchor: null, title: 'A', snippet: null },
            { kind: 'external', url: 'https://example.com', title: 'x', snippet: null },
          ],
        },
      },
      back: {
        body: {
          docName: 'me',
          backlinks: [{ source: 'in-b', anchor: null, title: 'B', snippet: null }],
        },
      },
    });
    const ctx = await loadWikiLinkContext('me');
    expect(ctx.currentDocName).toBe('me');
    expect([...ctx.connectedDocNames].sort()).toEqual(['in-b', 'out-a']);
  });

  test('drops a self-link so the current page earns the current-page boost, not the neighbor boost', async () => {
    stubLinks({
      forward: {
        body: {
          docName: 'me',
          forwardLinks: [
            { kind: 'doc', docName: 'me', anchor: null, title: 'self', snippet: null },
            { kind: 'doc', docName: 'friend', anchor: null, title: 'F', snippet: null },
          ],
        },
      },
      back: { body: { docName: 'me', backlinks: [] } },
    });
    const ctx = await loadWikiLinkContext('me');
    expect(ctx.connectedDocNames.has('me')).toBe(false);
    expect(autocompleteBoost('me', ctx)).toBe(50);
    expect(autocompleteBoost('friend', ctx)).toBe(100);
  });

  test('degrades to the still-successful side when one endpoint errors (HTTP 500)', async () => {
    stubLinks({
      forward: { status: 500, body: {} },
      back: {
        body: {
          docName: 'me',
          backlinks: [{ source: 'in-b', anchor: null, title: 'B', snippet: null }],
        },
      },
    });
    const ctx = await loadWikiLinkContext('me');
    expect(ctx.currentDocName).toBe('me');
    expect([...ctx.connectedDocNames]).toEqual(['in-b']);
  });

  test('degrades to no neighbors when a response body is malformed', async () => {
    stubLinks({ forward: { body: { wrong: 'shape' } }, back: { body: { nope: true } } });
    const ctx = await loadWikiLinkContext('me');
    expect(ctx.currentDocName).toBe('me');
    expect(ctx.connectedDocNames.size).toBe(0);
  });
});
