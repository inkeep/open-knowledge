import { describe, expect, test } from 'bun:test';
import type { WorkspaceEntry, WorkspaceSearchEntry } from './command-palette-search';

interface VisibleSearchResultsHelperArgs {
  searchResults: readonly WorkspaceSearchEntry[];
  fallbackSearchResults: readonly WorkspaceEntry[];
  searchStatus: 'idle' | 'loading' | 'success' | 'error';
}

type VisibleSearchResultsHelper = (
  args: VisibleSearchResultsHelperArgs,
) => readonly (WorkspaceEntry | WorkspaceSearchEntry)[];

async function loadHelper(): Promise<VisibleSearchResultsHelper | undefined> {
  const mod = (await import('./CommandPalette')) as Record<string, unknown>;
  const candidate = mod.computeVisibleSearchResults;
  return typeof candidate === 'function' ? (candidate as VisibleSearchResultsHelper) : undefined;
}

const apiResultsForPriorQuery: readonly WorkspaceSearchEntry[] = [
  { kind: 'file', path: 'aa.md', name: 'aa', snippet: 'queue manager handles items' },
  { kind: 'file', path: 'bb.md', name: 'bb', snippet: 'quartz crystal vibrates' },
];

const apiResultsForCurrentQuery: readonly WorkspaceSearchEntry[] = [
  { kind: 'file', path: 'aa.md', name: 'aa', snippet: 'queue manager handles items' },
];

const fallbackResults: readonly WorkspaceEntry[] = [{ kind: 'file', path: 'cc.md', name: 'cc' }];

describe('computeVisibleSearchResults — stale-while-revalidate contract', () => {
  test('helper is exported and is a function', async () => {
    const helper = await loadHelper();
    expect(typeof helper).toBe('function');
  });

  test('mid-keystroke loading: prior API results stay visible (stale-while-revalidate)', async () => {
    const helper = await loadHelper();
    if (!helper) {
      expect(typeof helper).toBe('function');
      return;
    }

    const visible = helper({
      searchResults: apiResultsForPriorQuery,
      fallbackSearchResults: fallbackResults,
      searchStatus: 'loading',
    });

    expect(visible).toEqual(apiResultsForPriorQuery);
  });

  test('loading with empty results: fall back to local corpus', async () => {
    const helper = await loadHelper();
    if (!helper) {
      expect(typeof helper).toBe('function');
      return;
    }

    const visible = helper({
      searchResults: [],
      fallbackSearchResults: fallbackResults,
      searchStatus: 'loading',
    });

    expect(visible).toEqual(fallbackResults);
  });

  test('idle with empty results: fall back to local corpus', async () => {
    const helper = await loadHelper();
    if (!helper) {
      expect(typeof helper).toBe('function');
      return;
    }

    const visible = helper({
      searchResults: [],
      fallbackSearchResults: fallbackResults,
      searchStatus: 'idle',
    });

    expect(visible).toEqual(fallbackResults);
  });

  test('error with empty results: fall back to local corpus', async () => {
    const helper = await loadHelper();
    if (!helper) {
      expect(typeof helper).toBe('function');
      return;
    }

    const visible = helper({
      searchResults: [],
      fallbackSearchResults: fallbackResults,
      searchStatus: 'error',
    });

    expect(visible).toEqual(fallbackResults);
  });

  test('success with empty result: empty list, NOT fallback', async () => {
    const helper = await loadHelper();
    if (!helper) {
      expect(typeof helper).toBe('function');
      return;
    }

    const visible = helper({
      searchResults: [],
      fallbackSearchResults: fallbackResults,
      searchStatus: 'success',
    });

    expect(visible).toEqual([]);
  });

  test('post-fetch swap: new API results replace prior results', async () => {
    const helper = await loadHelper();
    if (!helper) {
      expect(typeof helper).toBe('function');
      return;
    }

    const visible = helper({
      searchResults: apiResultsForCurrentQuery,
      fallbackSearchResults: fallbackResults,
      searchStatus: 'success',
    });

    expect(visible).toEqual(apiResultsForCurrentQuery);
  });
});
