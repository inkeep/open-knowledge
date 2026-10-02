import { describe, expect, test } from 'vitest';
import { computeVisibleSearchResults } from './CommandPalette';
import type { WorkspaceEntry, WorkspaceSearchEntry } from './command-palette-search';

type VisibleSearchResultsHelper = typeof computeVisibleSearchResults;

const helper: VisibleSearchResultsHelper = computeVisibleSearchResults;

const apiResultsForPriorQuery: readonly WorkspaceSearchEntry[] = [
  { kind: 'file', path: 'aa.md', name: 'aa', snippet: 'queue manager handles items' },
  { kind: 'file', path: 'bb.md', name: 'bb', snippet: 'quartz crystal vibrates' },
];

const apiResultsForCurrentQuery: readonly WorkspaceSearchEntry[] = [
  { kind: 'file', path: 'aa.md', name: 'aa', snippet: 'queue manager handles items' },
];

const fallbackResults: readonly WorkspaceEntry[] = [{ kind: 'file', path: 'cc.md', name: 'cc' }];

describe('computeVisibleSearchResults — stale-while-revalidate contract', () => {
  test('helper is exported and is a function', () => {
    expect(typeof helper).toBe('function');
  });

  test('mid-keystroke loading: prior API results stay visible (stale-while-revalidate)', () => {
    const visible = helper({
      searchResults: apiResultsForPriorQuery,
      fallbackSearchResults: fallbackResults,
      searchStatus: 'loading',
    });

    expect(visible).toEqual(apiResultsForPriorQuery);
  });

  test('loading with empty results: fall back to local corpus', () => {
    const visible = helper({
      searchResults: [],
      fallbackSearchResults: fallbackResults,
      searchStatus: 'loading',
    });

    expect(visible).toEqual(fallbackResults);
  });

  test('idle with empty results: fall back to local corpus', () => {
    const visible = helper({
      searchResults: [],
      fallbackSearchResults: fallbackResults,
      searchStatus: 'idle',
    });

    expect(visible).toEqual(fallbackResults);
  });

  test('error with empty results: fall back to local corpus', () => {
    const visible = helper({
      searchResults: [],
      fallbackSearchResults: fallbackResults,
      searchStatus: 'error',
    });

    expect(visible).toEqual(fallbackResults);
  });

  test('success with empty result: empty list, NOT fallback', () => {
    const visible = helper({
      searchResults: [],
      fallbackSearchResults: fallbackResults,
      searchStatus: 'success',
    });

    expect(visible).toEqual([]);
  });

  test('post-fetch swap: new API results replace prior results', () => {
    const visible = helper({
      searchResults: apiResultsForCurrentQuery,
      fallbackSearchResults: fallbackResults,
      searchStatus: 'success',
    });

    expect(visible).toEqual(apiResultsForCurrentQuery);
  });
});
