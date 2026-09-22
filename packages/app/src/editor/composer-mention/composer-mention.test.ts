import { afterEach, describe, expect, test, vi } from 'vitest';
import { __resetDocumentListInflightForTests } from '@/lib/documents-fetch';
import type { PageItem } from '../extensions/wiki-link-suggestion';
import { createMentionCorpus, pageItemToPath } from './composer-mention';

describe('pageItemToPath', () => {
  test('a page docName gains the .md suffix', () => {
    const item: PageItem = { kind: 'page', docName: 'specs/foo/SPEC', title: 'SPEC' };
    expect(pageItemToPath(item)).toBe('specs/foo/SPEC.md');
  });

  test('a kind-less item is treated as a page (gains .md)', () => {
    const item: PageItem = { docName: 'notes', title: 'Notes' };
    expect(pageItemToPath(item)).toBe('notes.md');
  });

  test('an asset strips its leading slash and keeps its extension', () => {
    const item: PageItem = { kind: 'asset', docName: '/docs/public/Wide.png', title: 'Wide.png' };
    expect(pageItemToPath(item)).toBe('docs/public/Wide.png');
  });

  test('a folder serializes to its bare path with no .md suffix', () => {
    const item: PageItem = { kind: 'folder', docName: 'specs/foo', title: 'foo' };
    expect(pageItemToPath(item)).toBe('specs/foo');
  });

  test('a top-level folder serializes to its bare name', () => {
    const item: PageItem = { kind: 'folder', docName: 'specs', title: 'specs' };
    expect(pageItemToPath(item)).toBe('specs');
  });
});

describe('createMentionCorpus — default corpus', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    __resetDocumentListInflightForTests();
  });

  test('the default fetch opts into folders — the composer is the one folder consumer', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = url.startsWith('/api/pages')
        ? {
            pages: [
              {
                docName: 'notes',
                title: 'Notes',
                docExt: '.md',
                size: 1,
                modified: '2026-06-24T00:00:00.000Z',
              },
            ],
          }
        : {
            documents: [
              { kind: 'folder', path: 'specs/foo', size: 0, modified: '2026-06-24T00:00:00.000Z' },
            ],
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const corpus = createMentionCorpus();
    const items = await corpus.getItems('');
    expect(items.map((item) => item.path)).toEqual(['notes.md', 'specs/foo']);
  });
});

describe('createMentionCorpus — fetch retry contract', () => {
  const PAGE: PageItem = { kind: 'page', docName: 'notes', title: 'Notes' };

  test('a rejected first fetch leaves the corpus unloaded so the next @ re-fetches', async () => {
    let calls = 0;
    const fetch = () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('network down')) : Promise.resolve([PAGE]);
    };
    const corpus = createMentionCorpus(fetch);

    const first = await corpus.getItems('');
    expect(calls).toBe(1);
    expect(first).toEqual([]);
    expect(corpus.snapshot()).toEqual({ loaded: false, error: true });

    const second = await corpus.getItems('');
    expect(calls).toBe(2);
    expect(second.map((i) => i.path)).toEqual(['notes.md']);
    expect(corpus.snapshot()).toEqual({ loaded: true, error: false });
  });

  test('the corpus assigns `kind: file` to pages/assets and `kind: folder` to folders', async () => {
    const items: PageItem[] = [
      { kind: 'page', docName: 'notes', title: 'Notes' },
      { kind: 'asset', docName: '/assets/logo.png', title: 'logo.png' },
      { kind: 'folder', docName: 'specs', title: 'specs' },
    ];
    const corpus = createMentionCorpus(() => Promise.resolve(items));
    const first = await corpus.getItems('');
    expect(first.map((i) => ({ path: i.path, kind: i.kind }))).toEqual([
      { path: 'notes.md', kind: 'file' },
      { path: 'assets/logo.png', kind: 'file' },
      { path: 'specs', kind: 'folder' },
    ]);
  });

  test('a successful fetch loads once and caches — no re-fetch on the next @', async () => {
    let calls = 0;
    const fetch = () => {
      calls += 1;
      return Promise.resolve([PAGE]);
    };
    const corpus = createMentionCorpus(fetch);

    await corpus.getItems('');
    await corpus.getItems('not');
    expect(calls).toBe(1);
    expect(corpus.snapshot()).toEqual({ loaded: true, error: false });
  });

  test('reset() clears the cache so the next @ re-fetches', async () => {
    let calls = 0;
    const fetch = () => {
      calls += 1;
      return Promise.resolve([PAGE]);
    };
    const corpus = createMentionCorpus(fetch);

    await corpus.getItems('');
    corpus.reset();
    expect(corpus.snapshot()).toEqual({ loaded: false, error: false });
    await corpus.getItems('');
    expect(calls).toBe(2);
  });
});

describe('createMentionCorpus — what the empty picker shows first', () => {
  const pages: PageItem[] = [
    { docName: 'changesets/a', title: 'A' },
    { docName: 'changesets/b', title: 'B' },
    { docName: 'plan', title: 'Plan' },
    { docName: 'notes/today', title: 'Today' },
    { docName: 'specs/api', title: 'API' },
  ];
  const corpus = () => createMentionCorpus(async () => pages);

  test('the document being edited comes first, then what the chat already attached', async () => {
    const items = await corpus().getItems('', {
      currentDocName: 'notes/today',
      recentPaths: ['specs/api.md', 'plan.md'],
    });

    expect(items.map((item) => item.path)).toEqual([
      'notes/today.md',
      'specs/api.md',
      'plan.md',
      'changesets/a.md',
      'changesets/b.md',
    ]);
  });

  test('with nothing to go on, the order is the workspace order as before', async () => {
    const items = await corpus().getItems('');

    expect(items.map((item) => item.path)).toEqual([
      'changesets/a.md',
      'changesets/b.md',
      'plan.md',
      'notes/today.md',
      'specs/api.md',
    ]);
  });

  test('a typed query searches as it always did and ignores recency', async () => {
    const items = await corpus().getItems('changesets', {
      currentDocName: 'notes/today',
      recentPaths: ['plan.md'],
    });

    expect(items.map((item) => item.path)).toEqual(['changesets/a.md', 'changesets/b.md']);
  });

  test('an attached path that is no longer in the workspace is simply skipped', async () => {
    const items = await corpus().getItems('', {
      currentDocName: null,
      recentPaths: ['gone.md', 'plan.md'],
    });

    expect(items[0]?.path).toBe('plan.md');
    expect(items).toHaveLength(5);
  });

  test('a folder the chat attached is pinned like a file', async () => {
    const withFolder: PageItem[] = [...pages, { kind: 'folder', docName: 'specs', title: 'specs' }];
    const items = await createMentionCorpus(async () => withFolder).getItems('', {
      currentDocName: null,
      recentPaths: ['specs'],
    });

    expect(items[0]).toMatchObject({ path: 'specs', kind: 'folder' });
  });

  test('an extension-qualified open doc still pins its page', async () => {
    const items = await corpus().getItems('', {
      currentDocName: 'notes/today.md',
      recentPaths: [],
    });

    expect(items[0]?.path).toBe('notes/today.md');
  });

  test('a long chat cannot push the workspace out of the default list', async () => {
    const many: PageItem[] = Array.from({ length: 12 }, (_, i) => ({
      docName: `a/${i}`,
      title: `A${i}`,
    }));
    const attached = many
      .slice(3)
      .reverse()
      .map((page) => `${page.docName}.md`);
    const items = await createMentionCorpus(async () => many).getItems('', {
      currentDocName: null,
      recentPaths: attached,
    });

    expect(items.map((i) => i.path)).toEqual([
      'a/11.md',
      'a/10.md',
      'a/9.md',
      'a/8.md',
      'a/0.md',
      'a/1.md',
      'a/2.md',
      'a/3.md',
    ]);
  });
});
