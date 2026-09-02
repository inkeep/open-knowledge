import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const triggered: string[] = [];
let triggerResult: Promise<void> = Promise.resolve();

vi.mock('@/lib/trigger-sync', () => ({
  triggerSync: (op: string) => {
    triggered.push(op);
    return triggerResult;
  },
}));

const cc1Listeners: ((channels: string[]) => void)[] = [];

vi.mock('@/lib/documents-events', () => ({
  subscribeToDocumentsChanged: (fn: (channels: string[]) => void) => {
    cc1Listeners.push(fn);
    return () => {
      const i = cc1Listeners.indexOf(fn);
      if (i >= 0) cc1Listeners.splice(i, 1);
    };
  },
}));

function signalSyncStatus() {
  for (const fn of cc1Listeners) fn(['sync-status']);
}

async function loadHook() {
  vi.resetModules();
  const mod = await import('./use-git-worktree-status');
  return mod.useGitWorktreeStatus;
}

beforeEach(() => {
  triggered.length = 0;
  cc1Listeners.length = 0;
  triggerResult = Promise.resolve();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ staged: [] }) })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useGitWorktreeStatus panel-open fetch', () => {
  test('refreshes remote refs when the panel opens', async () => {
    const useGitWorktreeStatus = await loadHook();
    renderHook(() => useGitWorktreeStatus(true));

    await waitFor(() => expect(triggered).toEqual(['fetch']));
  });

  test('never fetches while the panel is closed', async () => {
    const useGitWorktreeStatus = await loadHook();
    renderHook(() => useGitWorktreeStatus(false));

    expect(triggered).toEqual([]);
  });

  test('throttles a reopen — open/close/open is one network call', async () => {
    const useGitWorktreeStatus = await loadHook();
    const first = renderHook(() => useGitWorktreeStatus(true));
    await waitFor(() => expect(triggered).toEqual(['fetch']));
    first.unmount();

    renderHook(() => useGitWorktreeStatus(true));
    await waitFor(() => expect(triggered).toEqual(['fetch']));
  });

  test('a failed fetch frees the window so the next open can retry', async () => {
    triggerResult = Promise.reject(new Error('offline'));
    const useGitWorktreeStatus = await loadHook();
    const first = renderHook(() => useGitWorktreeStatus(true));
    await waitFor(() => expect(triggered).toEqual(['fetch']));
    first.unmount();

    triggerResult = Promise.resolve();
    renderHook(() => useGitWorktreeStatus(true));
    await waitFor(() => expect(triggered).toEqual(['fetch', 'fetch']));
  });
});

describe('useGitWorktreeStatus single-flight', () => {
  function deferredFetch() {
    const resolvers: ((value: unknown) => void)[] = [];
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const respond = (index: number, body: unknown) => {
      resolvers[index]?.({ ok: true, json: async () => body });
    };
    return { fetchMock, resolvers, respond };
  }

  test('collapses a burst of signals into one trailing re-run', async () => {
    const { fetchMock, respond } = deferredFetch();
    const useGitWorktreeStatus = await loadHook();
    renderHook(() => useGitWorktreeStatus(true));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    for (let i = 0; i < 5; i++) signalSyncStatus();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    respond(0, { staged: [], readable: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    respond(1, { staged: [], readable: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  test('a late slow response cannot overwrite a newer listing', async () => {
    const { fetchMock, respond } = deferredFetch();
    const useGitHook = await loadHook();
    const { result } = renderHook(() => useGitHook(true));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    signalSyncStatus();

    respond(0, { staged: [{ path: 'stale.md', code: 'M' }], readable: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    respond(1, { staged: [{ path: 'fresh.md', code: 'M' }], readable: true });
    await waitFor(() => expect(result.current.status?.staged?.[0]?.path).toBe('fresh.md'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('an unreadable read keeps the last good listing rather than blanking it', async () => {
    const { fetchMock, respond } = deferredFetch();
    const useGitHook = await loadHook();
    const { result } = renderHook(() => useGitHook(true));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    respond(0, { staged: [{ path: 'real.md', code: 'M' }], readable: true });
    await waitFor(() => expect(result.current.status?.staged?.[0]?.path).toBe('real.md'));

    signalSyncStatus();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    respond(1, { staged: [], readable: false });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(result.current.status?.staged?.[0]?.path).toBe('real.md');
  });

  test('a server predating the readable field is still trusted', async () => {
    const { fetchMock, respond } = deferredFetch();
    const useGitHook = await loadHook();
    const { result } = renderHook(() => useGitHook(true));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    respond(0, { staged: [{ path: 'old-server.md', code: 'M' }] });

    await waitFor(() => expect(result.current.status?.staged?.[0]?.path).toBe('old-server.md'));
  });
});
