import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
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
    const respondWithHttpError = (index: number, status: number) => {
      resolvers[index]?.({ ok: false, status, json: async () => ({}) });
    };
    return { fetchMock, resolvers, respond, respondWithHttpError };
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

    await waitFor(() => expect(result.current.unreadable).toBe(true));
    expect(result.current.status?.staged?.[0]?.path).toBe('real.md');
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

describe('useGitWorktreeStatus staleness', () => {
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
    const respondWithHttpError = (index: number, status: number) => {
      resolvers[index]?.({ ok: false, status, json: async () => ({}) });
    };
    return { fetchMock, respond, respondWithHttpError };
  }

  test('a request that never settles is abandoned so a later refresh can read again', async () => {
    vi.useFakeTimers();
    try {
      const aborted: unknown[] = [];
      const fetchMock = vi.fn((_url: string, init: { signal: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            aborted.push(init.signal.reason);
            reject(init.signal.reason);
          });
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      const useGitHook = await loadHook();
      const { result } = renderHook(() => useGitHook(true));
      expect(fetchMock).toHaveBeenCalledTimes(1);

      signalSyncStatus();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });

      expect(aborted).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.current.unreadable).toBe(true);
      expect(result.current.loading).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('an http error keeps the last good listing and reports it as possibly out of date', async () => {
    const { fetchMock, respond, respondWithHttpError } = deferredFetch();
    const useGitHook = await loadHook();
    const { result } = renderHook(() => useGitHook(true));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    respond(0, { staged: [{ path: 'real.md', code: 'M' }], readable: true });
    await waitFor(() => expect(result.current.status?.staged?.[0]?.path).toBe('real.md'));
    const firstReadAt = result.current.lastReadAt;
    expect(firstReadAt).toBeTypeOf('number');
    expect(result.current.stale).toBe(false);

    signalSyncStatus();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    respondWithHttpError(1, 500);

    await waitFor(() => expect(result.current.stale).toBe(true));
    expect(result.current.status?.staged?.[0]?.path).toBe('real.md');
    expect(result.current.lastReadAt).toBe(firstReadAt);
  });

  test('a network error reports staleness without discarding the listing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ staged: [], readable: true }) })
      .mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);

    const useGitHook = await loadHook();
    const { result } = renderHook(() => useGitHook(true));

    await waitFor(() => expect(result.current.status).not.toBeNull());
    signalSyncStatus();

    await waitFor(() => expect(result.current.stale).toBe(true));
    expect(result.current.status).not.toBeNull();
  });

  test('an unreadable tree is never also reported as a stale listing', async () => {
    const { fetchMock, respond, respondWithHttpError } = deferredFetch();
    const useGitHook = await loadHook();
    const { result } = renderHook(() => useGitHook(true));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    respond(0, { staged: [{ path: 'real.md', code: 'M' }], readable: true });
    await waitFor(() => expect(result.current.status?.staged?.[0]?.path).toBe('real.md'));

    signalSyncStatus();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    respond(1, { staged: [], readable: false });
    await waitFor(() => expect(result.current.unreadable).toBe(true));
    expect(result.current.stale).toBe(false);

    signalSyncStatus();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    respondWithHttpError(2, 403);
    signalSyncStatus();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(result.current.unreadable).toBe(true);
    expect(result.current.stale).toBe(false);
  });

  test('a later readable response clears both the unreadable and the stale signals', async () => {
    const { fetchMock, respond, respondWithHttpError } = deferredFetch();
    const useGitHook = await loadHook();
    const { result } = renderHook(() => useGitHook(true));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    respond(0, { staged: [{ path: 'real.md', code: 'M' }], readable: true });
    await waitFor(() => expect(result.current.status?.staged?.[0]?.path).toBe('real.md'));

    signalSyncStatus();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    respondWithHttpError(1, 403);
    await waitFor(() => expect(result.current.stale).toBe(true));

    signalSyncStatus();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    respond(2, { staged: [], readable: false });
    await waitFor(() => expect(result.current.unreadable).toBe(true));
    expect(result.current.stale).toBe(false);

    signalSyncStatus();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    respond(3, { staged: [{ path: 'fresh.md', code: 'M' }], readable: true });

    await waitFor(() => expect(result.current.status?.staged?.[0]?.path).toBe('fresh.md'));
    expect(result.current.unreadable).toBe(false);
    expect(result.current.stale).toBe(false);
    expect(result.current.lastReadAt).toBeTypeOf('number');
  });

  test('a first read that fails outright stops claiming the tree is still being read', async () => {
    const { fetchMock, respondWithHttpError } = deferredFetch();
    const useGitHook = await loadHook();
    const { result } = renderHook(() => useGitHook(true));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(result.current.loading).toBe(true);
    respondWithHttpError(0, 500);

    await waitFor(() => expect(result.current.unreadable).toBe(true));
    expect(result.current.loading).toBe(false);
    expect(result.current.status).toBeNull();
    expect(result.current.stale).toBe(false);
  });

  test('a cold start that fails and then succeeds drops the unreadable verdict', async () => {
    const { fetchMock, respond, respondWithHttpError } = deferredFetch();
    const useGitHook = await loadHook();
    const { result } = renderHook(() => useGitHook(true));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    respondWithHttpError(0, 500);
    await waitFor(() => expect(result.current.unreadable).toBe(true));

    signalSyncStatus();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    respond(1, { staged: [{ path: 'fresh.md', code: 'M' }], readable: true });

    await waitFor(() => expect(result.current.status?.staged?.[0]?.path).toBe('fresh.md'));
    expect(result.current.unreadable).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  test('the first read still reports loading until a listing arrives', async () => {
    const { fetchMock, respond } = deferredFetch();
    const useGitHook = await loadHook();
    const { result } = renderHook(() => useGitHook(true));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    respond(0, { staged: [], readable: true });

    await waitFor(() => expect(result.current.loading).toBe(false));
  });
});
