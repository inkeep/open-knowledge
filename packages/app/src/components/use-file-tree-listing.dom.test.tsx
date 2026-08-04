import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type {
  FileTreeListingRequest,
  FileTreeListingSource,
  ShowAllDepth1ListingResult,
} from './file-tree-listing-transport';
import { useFileTreeListing } from './use-file-tree-listing';

const relaunchState = vi.hoisted(() => ({ inFlight: false }));

vi.mock('@/lib/relaunch-store', () => ({
  getRelaunchInFlightSnapshot: () => relaunchState.inFlight,
  useRelaunchInFlight: () => relaunchState.inFlight,
}));

vi.mock('@/lib/documents-events', () => ({
  subscribeToDocumentsChanged: () => () => {},
}));

const messages = {
  fallbackErrorTitle: 'Failed to load documents',
  schemaMismatchTitle: 'Documents response did not match expected shape.',
  couldNotReachServerTitle: 'Could not reach server',
};

function documentEntry(docName: string) {
  return {
    kind: 'document' as const,
    docName,
    docExt: '.md',
    size: 1,
    modified: '2026-01-01T00:00:00.000Z',
  };
}

function folderEntry(path: string, hasChildren = true) {
  return {
    kind: 'folder' as const,
    path,
    size: 0,
    modified: '2026-01-01T00:00:00.000Z',
    hasChildren,
  };
}

function assetEntry(path: string) {
  return {
    kind: 'asset' as const,
    path,
    assetExt: path.split('.').pop() ?? 'file',
    mediaKind: null,
    size: 1,
    modified: '2026-01-01T00:00:00.000Z',
    referencedBy: [],
  };
}

interface PendingRequest {
  request: FileTreeListingRequest;
  resolve(result: ShowAllDepth1ListingResult): void;
  reject(cause: unknown): void;
}

function createListingSource() {
  const pending: PendingRequest[] = [];
  const source: FileTreeListingSource = {
    listDepthOne(request) {
      return new Promise((resolve, reject) => pending.push({ request, resolve, reject }));
    },
  };
  return { source, pending };
}

interface ListingVisibility {
  showHiddenFiles: boolean;
  showOnlyMarkdownFiles: boolean;
  showOkFolders: boolean;
}

const defaultVisibility: ListingVisibility = {
  showHiddenFiles: false,
  showOnlyMarkdownFiles: false,
  showOkFolders: false,
};

function renderListing(
  source: FileTreeListingSource,
  initialVisibility: ListingVisibility = defaultVisibility,
) {
  return renderHook(
    (visibility: ListingVisibility) =>
      useFileTreeListing({
        ...visibility,
        messages,
        source,
      }),
    { initialProps: initialVisibility },
  );
}

function requestRootRefresh() {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  act(() => window.dispatchEvent(new Event('focus')));
}

afterEach(() => {
  cleanup();
  relaunchState.inFlight = false;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useFileTreeListing', () => {
  test('starts one root request and publishes streamed batches before completion', async () => {
    const { source, pending } = createListingSource();
    const { result } = renderListing(source);
    await waitFor(() => expect(pending).toHaveLength(1));

    act(() => pending[0]?.request.onBatch?.([documentEntry('notes/a')]));
    await waitFor(() => expect(result.current.documents).toEqual([documentEntry('notes/a')]));
    expect(result.current.loading).toBe(false);

    await act(async () => {
      pending[0]?.resolve({
        kind: 'entries',
        entries: [documentEntry('notes/a'), documentEntry('notes/b')],
        truncated: false,
      });
    });
    await waitFor(() => expect(result.current.documents).toHaveLength(2));
  });

  test('tracks the authoritative unfiltered root count when visibility hides every entry', async () => {
    const { source, pending } = createListingSource();
    const { result } = renderListing(source, {
      ...defaultVisibility,
      showOnlyMarkdownFiles: true,
    });
    await waitFor(() => expect(pending).toHaveLength(1));

    await act(async () => {
      pending[0]?.resolve({
        kind: 'entries',
        entries: [assetEntry('data.csv')],
        truncated: false,
      });
    });

    expect(result.current.documents).toEqual([]);
    expect(result.current.unfilteredRootEntryCount).toBe(1);
  });

  test('refetches and filters with each latest visibility setting', async () => {
    const { source, pending } = createListingSource();
    const { result, rerender } = renderListing(source);
    const entries = [
      documentEntry('README'),
      documentEntry('.hidden'),
      assetEntry('data.csv'),
      folderEntry('.ok'),
    ];
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      pending[0]?.resolve({ kind: 'entries', entries, truncated: false });
    });
    expect(result.current.documents).toEqual([documentEntry('README'), assetEntry('data.csv')]);

    rerender({ ...defaultVisibility, showHiddenFiles: true });
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => {
      pending[1]?.resolve({ kind: 'entries', entries, truncated: false });
    });
    expect(result.current.documents).toEqual([
      documentEntry('README'),
      documentEntry('.hidden'),
      assetEntry('data.csv'),
    ]);

    rerender({
      ...defaultVisibility,
      showHiddenFiles: true,
      showOnlyMarkdownFiles: true,
    });
    await waitFor(() => expect(pending).toHaveLength(3));
    await act(async () => {
      pending[2]?.resolve({ kind: 'entries', entries, truncated: false });
    });
    expect(result.current.documents).toEqual([documentEntry('README'), documentEntry('.hidden')]);

    rerender({
      showHiddenFiles: true,
      showOnlyMarkdownFiles: true,
      showOkFolders: true,
    });
    await waitFor(() => expect(pending).toHaveLength(4));
    expect(pending[3]?.request.showOk).toBe(true);
    await act(async () => {
      pending[3]?.resolve({ kind: 'entries', entries, truncated: false });
    });
    expect(result.current.documents).toEqual([
      documentEntry('README'),
      documentEntry('.hidden'),
      folderEntry('.ok'),
    ]);
  });

  test('retries a relaunch outage and self-heals when the server returns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { source, pending } = createListingSource();
    const { result, rerender } = renderListing(source);
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      pending[0]?.resolve({
        kind: 'entries',
        entries: [documentEntry('before')],
        truncated: false,
      });
    });

    relaunchState.inFlight = true;
    rerender(defaultVisibility);
    await waitFor(() => expect(pending).toHaveLength(2));
    vi.useFakeTimers();
    const outage = new TypeError('server restarting');
    await act(async () => {
      pending[1]?.resolve({ kind: 'network-error', cause: outage });
    });
    expect(result.current.relaunchInFlight).toBe(true);
    expect(result.current.reconnecting).toBe(true);
    expect(result.current.error).toBeNull();
    expect(warn).toHaveBeenLastCalledWith('[FileTree] fetch failed:', outage);

    act(() => vi.advanceTimersByTime(1_999));
    expect(pending).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    expect(pending).toHaveLength(3);

    await act(async () => {
      pending[2]?.resolve({
        kind: 'entries',
        entries: [documentEntry('after')],
        truncated: false,
      });
    });
    expect(result.current.documents).toEqual([documentEntry('after')]);
    expect(result.current.reconnecting).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test('normalizes a rejected root source as a network failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { source, pending } = createListingSource();
    const { result } = renderListing(source);
    await waitFor(() => expect(pending).toHaveLength(1));
    const cause = new Error('custom source rejected');

    await act(async () => {
      pending[0]?.reject(cause);
    });

    await waitFor(() => expect(result.current.error).toBe(messages.couldNotReachServerTitle));
    expect(result.current.loading).toBe(false);
    expect(warn).toHaveBeenLastCalledWith('[FileTree] fetch failed:', cause);
  });

  test('rejects a superseded root response and aborts its public request signal', async () => {
    const { source, pending } = createListingSource();
    const { result } = renderListing(source);
    await waitFor(() => expect(pending).toHaveLength(1));
    requestRootRefresh();
    expect(pending[0]?.request.signal.aborted).toBe(true);
    expect(pending).toHaveLength(1);

    await act(async () => {
      pending[0]?.resolve({ kind: 'entries', entries: [documentEntry('old')], truncated: false });
    });
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(result.current.documents).toEqual([]);

    await act(async () => {
      pending[1]?.resolve({ kind: 'entries', entries: [documentEntry('new')], truncated: false });
    });
    await waitFor(() => expect(result.current.documents).toEqual([documentEntry('new')]));
  });

  test('starts a lazy request once per expanded folder and aborts it on unmount', async () => {
    const { source, pending } = createListingSource();
    const { result, unmount } = renderListing(source);
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      pending[0]?.resolve({
        kind: 'entries',
        entries: [folderEntry('team')],
        truncated: false,
      });
    });

    act(() => {
      result.current.observeExpandedFolderPaths(['team/']);
      result.current.observeExpandedFolderPaths(['team/']);
    });
    await waitFor(() => expect(pending).toHaveLength(2));
    unmount();
    expect(pending[1]?.request.signal.aborted).toBe(true);
  });

  test('reports a lazy network failure and recovers on a later expansion', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { source, pending } = createListingSource();
    const { result } = renderListing(source);
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      pending[0]?.resolve({ kind: 'entries', entries: [folderEntry('team')], truncated: false });
    });

    act(() => result.current.observeExpandedFolderPaths(['team/']));
    await waitFor(() => expect(pending).toHaveLength(2));
    const cause = new TypeError('connection reset');
    await act(async () => {
      pending[1]?.resolve({ kind: 'network-error', cause });
    });
    expect(result.current.error).toBe(messages.couldNotReachServerTitle);
    expect(warn).toHaveBeenLastCalledWith(
      '[FileTree] lazy folder children fetch failed:',
      'team/',
      cause,
    );

    act(() => {
      result.current.observeExpandedFolderPaths([]);
      result.current.observeExpandedFolderPaths(['team/']);
    });
    await waitFor(() => expect(pending).toHaveLength(3));
    await act(async () => {
      pending[2]?.resolve({
        kind: 'entries',
        entries: [documentEntry('team/recovered')],
        truncated: false,
      });
    });
    expect(result.current.documents).toEqual([
      folderEntry('team'),
      documentEntry('team/recovered'),
    ]);
    expect(result.current.error).toBeNull();
  });

  test('reports a lazy HTTP failure and recovers on a later expansion', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { source, pending } = createListingSource();
    const { result } = renderListing(source);
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      pending[0]?.resolve({ kind: 'entries', entries: [folderEntry('team')], truncated: false });
    });

    act(() => result.current.observeExpandedFolderPaths(['team/']));
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => {
      pending[1]?.resolve({ kind: 'http-error', title: 'Folder walk failed' });
    });
    expect(result.current.error).toBe('Folder walk failed');
    expect(warn).toHaveBeenLastCalledWith(
      '[FileTree] lazy folder children http error:',
      'team/',
      'Folder walk failed',
    );

    act(() => {
      result.current.observeExpandedFolderPaths([]);
      result.current.observeExpandedFolderPaths(['team/']);
    });
    await waitFor(() => expect(pending).toHaveLength(3));
    await act(async () => {
      pending[2]?.resolve({
        kind: 'entries',
        entries: [documentEntry('team/recovered')],
        truncated: false,
      });
    });
    expect(result.current.documents).toEqual([
      folderEntry('team'),
      documentEntry('team/recovered'),
    ]);
    expect(result.current.error).toBeNull();
  });

  test('normalizes a rejected lazy source and clears its slot for a retry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { source, pending } = createListingSource();
    const { result } = renderListing(source);
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      pending[0]?.resolve({ kind: 'entries', entries: [folderEntry('team')], truncated: false });
    });

    act(() => result.current.observeExpandedFolderPaths(['team/']));
    await waitFor(() => expect(pending).toHaveLength(2));
    const cause = new Error('custom source rejected');
    await act(async () => {
      pending[1]?.reject(cause);
    });
    expect(result.current.error).toBe(messages.couldNotReachServerTitle);
    expect(warn).toHaveBeenLastCalledWith(
      '[FileTree] lazy folder children fetch failed:',
      'team/',
      cause,
    );

    act(() => {
      result.current.observeExpandedFolderPaths([]);
      result.current.observeExpandedFolderPaths(['team/']);
    });
    await waitFor(() => expect(pending).toHaveLength(3));
  });

  test('rejects a stale child result after a root refresh advances the generation', async () => {
    const { source, pending } = createListingSource();
    const { result, unmount } = renderListing(source);
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      pending[0]?.resolve({ kind: 'entries', entries: [folderEntry('team')], truncated: false });
    });
    await waitFor(() => expect(result.current.documents).toEqual([folderEntry('team')]));

    act(() => result.current.observeExpandedFolderPaths(['team/']));
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1]?.request.dir).toBe('team');

    requestRootRefresh();
    await waitFor(() => expect(pending).toHaveLength(3));
    expect(pending[1]?.request.signal.aborted).toBe(true);

    await act(async () => {
      pending[1]?.resolve({
        kind: 'entries',
        entries: [documentEntry('team/stale')],
        truncated: false,
      });
    });
    expect(result.current.documents).toEqual([folderEntry('team')]);
    unmount();
  });

  test('preserves, confirms, and expires optimistic additions through root listings', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
    const { source, pending } = createListingSource();
    const { result } = renderListing(source);
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      pending[0]?.resolve({ kind: 'entries', entries: [], truncated: false });
    });

    const optimistic = documentEntry('optimistic');
    act(() => {
      result.current.setDocuments([optimistic]);
      result.current.recordOptimisticAdd(optimistic);
    });
    requestRootRefresh();
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => {
      pending[1]?.resolve({ kind: 'entries', entries: [], truncated: false });
    });
    await waitFor(() => expect(result.current.documents).toEqual([optimistic]));

    const confirmed = { ...optimistic, size: 42 };
    requestRootRefresh();
    await waitFor(() => expect(pending).toHaveLength(3));
    await act(async () => {
      pending[2]?.resolve({ kind: 'entries', entries: [confirmed], truncated: false });
    });
    await waitFor(() => expect(result.current.documents).toEqual([confirmed]));

    const expiring = documentEntry('expiring');
    act(() => {
      result.current.setDocuments((current) => [...current, expiring]);
      result.current.recordOptimisticAdd(expiring);
    });
    vi.setSystemTime(new Date('2026-08-03T12:00:05.001Z'));
    requestRootRefresh();
    await waitFor(() => expect(pending).toHaveLength(4));
    await act(async () => {
      pending[3]?.resolve({ kind: 'entries', entries: [confirmed], truncated: false });
    });
    await waitFor(() => expect(result.current.documents).toEqual([confirmed]));
  });

  test('aborts a pending root request when the hook unmounts', async () => {
    const { source, pending } = createListingSource();
    const { unmount } = renderListing(source);
    await waitFor(() => expect(pending).toHaveLength(1));
    unmount();
    expect(pending[0]?.request.signal.aborted).toBe(true);
  });

  test('retains the last safe truncation count when a streamed root refresh fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { source, pending } = createListingSource();
    const { result } = renderListing(source);
    await waitFor(() => expect(pending).toHaveLength(1));
    const safeEntries = [documentEntry('notes/a'), documentEntry('notes/b')];
    await act(async () => {
      pending[0]?.resolve({ kind: 'entries', entries: safeEntries, truncated: true });
    });
    await waitFor(() => expect(result.current.truncatedShownCount).toBe(2));

    requestRootRefresh();
    await waitFor(() => expect(pending).toHaveLength(2));
    const streamCause = new Error('stream failure');
    await act(async () => {
      pending[1]?.resolve({ kind: 'http-error', title: 'stream failure', cause: streamCause });
    });

    await waitFor(() => expect(result.current.error).toBe('stream failure'));
    expect(result.current.documents).toEqual(safeEntries);
    expect(result.current.truncatedShownCount).toBe(2);
    expect(warn).toHaveBeenLastCalledWith('[FileTree] fetch failed:', streamCause);
  });

  test('logs only root failures that carry a transport cause', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { source, pending } = createListingSource();
    const { result } = renderListing(source);
    await waitFor(() => expect(pending).toHaveLength(1));
    const networkCause = new TypeError('connection reset');
    await act(async () => {
      pending[0]?.resolve({ kind: 'network-error', cause: networkCause });
    });
    await waitFor(() => expect(result.current.error).toBe(messages.couldNotReachServerTitle));
    expect(warn).toHaveBeenLastCalledWith('[FileTree] fetch failed:', networkCause);

    requestRootRefresh();
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => {
      pending[1]?.resolve({ kind: 'http-error', title: 'HTTP failure' });
    });
    await waitFor(() => expect(result.current.error).toBe('HTTP failure'));
    expect(warn).toHaveBeenCalledTimes(1);

    const streamCause = new Error('stream failure');
    requestRootRefresh();
    await waitFor(() => expect(pending).toHaveLength(3));
    await act(async () => {
      pending[2]?.resolve({ kind: 'http-error', title: 'stream failure', cause: streamCause });
    });
    await waitFor(() => expect(result.current.error).toBe('stream failure'));
    expect(warn).toHaveBeenLastCalledWith('[FileTree] fetch failed:', streamCause);
  });
});
