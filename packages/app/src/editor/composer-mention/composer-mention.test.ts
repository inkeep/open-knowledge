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
