/**
 * Pins the stale-while-revalidate contract for the Cmd+K command-palette
 * search-results slot. Without this, the visible list passes through THREE
 * populations on every keystroke (prev API → local-corpus fallback for new
 * query → new API), producing the per-keystroke flicker.
 *
 * Contract for `computeVisibleSearchResults`:
 *   - When prior API results exist, return them — even while a new fetch is
 *     in flight (stale-while-revalidate). Load-bearing.
 *   - When `searchResults` is empty AND status === 'success', return `[]`.
 *     The current query genuinely has no matches.
 *   - Otherwise (empty + non-success), surface `fallbackSearchResults` so
 *     the user sees something during the first keystroke or recovery
 *     after error / tag-mode exit.
 */

import { describe, expect, test } from 'bun:test';
import type { WorkspaceEntry, WorkspaceSearchEntry } from './command-palette-search';

// Dynamic import so a missing export surfaces as an assertion error in the
// first test, not as a collection-time error that aborts the whole file.

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

    // After typing 'q' and the API resolved, searchResults holds the
    // prior population. Typing 'u' kicks off a new fetch. During the
    // fetch's loading window, the user must continue to see the prior
    // population — NOT the fallback (different algorithm's output).
    const visible = helper({
      searchResults: apiResultsForPriorQuery,
      fallbackSearchResults: fallbackResults,
      searchStatus: 'loading',
    });

    // Load-bearing: helper preserves prior results during the fetch.
    expect(visible).toEqual(apiResultsForPriorQuery);
  });

  test('loading with empty results: fall back to local corpus', async () => {
    const helper = await loadHelper();
    if (!helper) {
      expect(typeof helper).toBe('function');
      return;
    }

    // First keystroke after the palette opens (or after a tag-mode exit):
    // no API success has landed yet. Showing the fallback (local title
    // corpus) gives the user immediate feedback while the first API
    // request is in flight.
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

    // After the search effect's cleanup path runs (palette close, tag mode
    // activation, query cleared), status returns to 'idle' with empty
    // searchResults. Behavior matches the empty-non-success branch — show
    // the local-corpus fallback rather than a stale empty.
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

    // After the API errors (network failure, server error, timeout), the
    // catch handler clears searchResults and sets status to 'error'.
    // Surfacing the local-corpus fallback gives the user something to act
    // on while the next request retries — better than an empty list.
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

    // The API resolved successfully with zero matches. The user typed a
    // query that genuinely has no results — show the empty list. Routing
    // through the fallback here would mislead (different algorithm's
    // output appears as if it were the API answer).
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

    // After the new fetch resolves, the helper returns the new population.
    const visible = helper({
      searchResults: apiResultsForCurrentQuery,
      fallbackSearchResults: fallbackResults,
      searchStatus: 'success',
    });

    expect(visible).toEqual(apiResultsForCurrentQuery);
  });
});
