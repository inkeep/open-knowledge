/**
 * Panel-open fetch behavior for {@link useGitWorktreeStatus}.
 *
 * The throttle is module-scoped state, so each case re-imports the module via
 * `vi.resetModules()` to get a fresh window rather than inheriting the previous
 * test's timestamp.
 */
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

/** Fire a CC1 `sync-status` signal at every mounted hook, as the engine does. */
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
    // Opening a panel headed "2 behind" is the user asking about remote state;
    // `fetch` is the read-only op that can answer without moving their files.
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
    // The throttle outlives the unmount on purpose: without that, fidgeting
    // with the popover would hit the remote on every open.
    await waitFor(() => expect(triggered).toEqual(['fetch']));
  });

  test('a failed fetch frees the window so the next open can retry', async () => {
    // Offline is the common failure. Burning the throttle window on a call that
    // never reached the engine would leave the panel stale for no reason.
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
  /**
   * A status read is four git subprocesses, and a sync cycle signals CC1 on
   * every state transition — so an open popover during a sync would otherwise
   * issue a burst of them, and a slower EARLIER response could land after (and
   * overwrite) a newer listing.
   */
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

    // The mount read is in flight and unresolved.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Five transitions land while it is still open.
    for (let i = 0; i < 5; i++) signalSyncStatus();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Releasing the first issues exactly ONE trailing re-run, not five.
    respond(0, { staged: [], readable: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // And that re-run does not itself cascade.
    respond(1, { staged: [], readable: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  test('a late slow response cannot overwrite a newer listing', async () => {
    const { fetchMock, respond } = deferredFetch();
    const useGitHook = await loadHook();
    const { result } = renderHook(() => useGitHook(true));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    signalSyncStatus();

    // Resolve the mount read with the OLD listing; the queued re-run fires.
    respond(0, { staged: [{ path: 'stale.md', code: 'M' }], readable: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    respond(1, { staged: [{ path: 'fresh.md', code: 'M' }], readable: true });
    await waitFor(() => expect(result.current.status?.staged?.[0]?.path).toBe('fresh.md'));

    // Single-flight means there is no third in-flight read left to land late.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('an unreadable read keeps the last good listing rather than blanking it', async () => {
    // A 200 with empty lists is truthy, so the keep-last-good guard cannot see
    // the difference — `readable: false` is what distinguishes "git failed"
    // from "genuinely clean", and showing a false-clean tree would tell the
    // user a push has nothing to send.
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
    // `readable !== false`, not `readable === true`: under version skew an old
    // server sends nothing, and treating that as unreadable would freeze the
    // panel permanently.
    const { fetchMock, respond } = deferredFetch();
    const useGitHook = await loadHook();
    const { result } = renderHook(() => useGitHook(true));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    respond(0, { staged: [{ path: 'old-server.md', code: 'M' }] });

    await waitFor(() => expect(result.current.status?.staged?.[0]?.path).toBe('old-server.md'));
  });
});
