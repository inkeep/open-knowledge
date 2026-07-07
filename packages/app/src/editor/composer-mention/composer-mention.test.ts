import { describe, expect, test } from 'bun:test';
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

describe('createMentionCorpus — fetch retry contract', () => {
  const PAGE: PageItem = { kind: 'page', docName: 'notes', title: 'Notes' };

  test('a rejected first fetch leaves the corpus unloaded so the next @ re-fetches', async () => {
    let calls = 0;
    const fetch = () => {
      calls += 1;
      // First `@`: reject (the regression locked the corpus empty here). Second
      // `@`: resolve, proving the retry path is reachable.
      return calls === 1 ? Promise.reject(new Error('network down')) : Promise.resolve([PAGE]);
    };
    const corpus = createMentionCorpus(fetch);

    const first = await corpus.getItems('');
    expect(calls).toBe(1);
    expect(first).toEqual([]);
    // The fix: a failed first fetch must NOT mark the corpus loaded, or the
    // session is permanently empty. Only `error` flips.
    expect(corpus.snapshot()).toEqual({ loaded: false, error: true });

    const second = await corpus.getItems('');
    // The corpus re-fetched (calls === 2) rather than serving the empty cache.
    expect(calls).toBe(2);
    expect(second.map((i) => i.path)).toEqual(['notes.md']);
    expect(corpus.snapshot()).toEqual({ loaded: true, error: false });
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
