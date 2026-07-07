import { describe, expect, mock, test } from 'bun:test';

interface MockBridge {
  config: {
    collabUrl: string;
    apiOrigin: string;
    projectPath: string;
    projectName: string;
    mode: 'navigator' | 'editor';
  };
  project: {
    listRecent: ReturnType<typeof mock>;
    removeRecent: ReturnType<typeof mock>;
    getSessionState: ReturnType<typeof mock>;
    setSessionState: ReturnType<typeof mock>;
    open: ReturnType<typeof mock>;
    createNew: ReturnType<typeof mock>;
    recordCreateNewBannerShown: ReturnType<typeof mock>;
    readHeadBranch: ReturnType<typeof mock>;
    close: ReturnType<typeof mock>;
  };
  dialog: {
    openFolder: ReturnType<typeof mock>;
  };
}

function makeBridge(overrides: Partial<MockBridge> = {}): MockBridge {
  return {
    config: {
      collabUrl: '',
      apiOrigin: '',
      projectPath: '',
      projectName: 'Project Navigator',
      mode: 'navigator',
    },
    project: {
      listRecent: mock(() => Promise.resolve([])),
      removeRecent: mock(() => Promise.resolve()),
      getSessionState: mock(() =>
        Promise.resolve({
          openTabs: [],
          pinnedTabIds: [],
          activeDocName: null,
          activeTabId: null,
          updatedAt: null,
        }),
      ),
      setSessionState: mock(() => Promise.resolve()),
      open: mock(() => Promise.resolve()),
      createNew: mock(() => Promise.resolve()),
      recordCreateNewBannerShown: mock(() => Promise.resolve()),
      readHeadBranch: mock(() =>
        Promise.resolve({ currentBranch: null, headSha: null, detached: false }),
      ),
      close: mock(() => Promise.resolve()),
    },
    dialog: {
      openFolder: mock(() => Promise.resolve(null)),
    },
    ...overrides,
  };
}

describe('NavigatorApp bridge contract', () => {
  test('Component module imports cleanly', async () => {
    const mod = await import('./NavigatorApp');
    expect(typeof mod.NavigatorApp).toBe('function');
    expect(typeof mod.resolveErrorMessage).toBe('function');
    expect(typeof mod.runWithErrorStatePure).toBe('function');
  });

  test('bridge.project.listRecent returns RecentProjectEntry[] shape', async () => {
    const bridge = makeBridge({
      project: {
        listRecent: mock(() =>
          Promise.resolve([
            { path: '/tmp/a', name: 'a', lastOpenedAt: '2026-04-20T00:00:00Z' },
            { path: '/tmp/b', name: 'b', lastOpenedAt: '2026-04-19T00:00:00Z', missing: true },
          ]),
        ),
        removeRecent: mock(() => Promise.resolve()),
        getSessionState: mock(() =>
          Promise.resolve({
            openTabs: [],
            pinnedTabIds: [],
            activeDocName: null,
            activeTabId: null,
            updatedAt: null,
          }),
        ),
        setSessionState: mock(() => Promise.resolve()),
        open: mock(() => Promise.resolve()),
        createNew: mock(() => Promise.resolve()),
        recordCreateNewBannerShown: mock(() => Promise.resolve()),
        close: mock(() => Promise.resolve()),
      },
    });
    const list = await bridge.project.listRecent();
    expect(list.length).toBe(2);
    expect(list[0]?.path).toBe('/tmp/a');
    expect(list[1]?.missing).toBe(true);
  });

  test('bridge.project.removeRecent accepts a project path', async () => {
    const bridge = makeBridge();
    await bridge.project.removeRecent('/tmp/stale');
    expect(bridge.project.removeRecent).toHaveBeenCalledWith('/tmp/stale');
  });

  test('bridge.project.open accepts the new-window request shape', async () => {
    const bridge = makeBridge();
    await bridge.project.open({
      path: '/tmp/x',
      target: 'new-window',
      entryPoint: 'pick-existing',
    });
    expect(bridge.project.open).toHaveBeenCalledWith({
      path: '/tmp/x',
      target: 'new-window',
      entryPoint: 'pick-existing',
    });
  });

  test('bridge.dialog.openFolder returns string | null', async () => {
    const bridge = makeBridge({
      dialog: {
        openFolder: mock(() => Promise.resolve('/tmp/picked')),
      },
    });
    const result = await bridge.dialog.openFolder();
    expect(result).toBe('/tmp/picked');
  });

  test('bridge.project.readHeadBranch resolves to a HeadBranchInfo shape', async () => {
    const bridge = makeBridge({
      project: {
        listRecent: mock(() => Promise.resolve([])),
        removeRecent: mock(() => Promise.resolve()),
        getSessionState: mock(() =>
          Promise.resolve({
            openTabs: [],
            pinnedTabIds: [],
            activeDocName: null,
            activeTabId: null,
            updatedAt: null,
          }),
        ),
        setSessionState: mock(() => Promise.resolve()),
        open: mock(() => Promise.resolve()),
        createNew: mock(() => Promise.resolve()),
        recordCreateNewBannerShown: mock(() => Promise.resolve()),
        readHeadBranch: mock(() =>
          Promise.resolve({ currentBranch: 'feat/test', headSha: null, detached: false }),
        ),
        close: mock(() => Promise.resolve()),
      },
    });
    const info = await bridge.project.readHeadBranch('/tmp/proj');
    expect(bridge.project.readHeadBranch).toHaveBeenCalledWith('/tmp/proj');
    expect(info).toEqual({ currentBranch: 'feat/test', headSha: null, detached: false });
  });

  test('readHeadBranch sentinel collapses non-git / unreadable projects to all-null', async () => {
    const bridge = makeBridge();
    const info = await bridge.project.readHeadBranch('/tmp/no-git');
    // Default makeBridge stub returns the graceful-fail sentinel — the
    // shape NavigatorApp treats as "no branch label, render nothing."
    expect(info).toEqual({ currentBranch: null, headSha: null, detached: false });
  });
});

describe('NavigatorApp recent-project removal helpers', () => {
  test('removeRecentFromList drops only the matching path and preserves order', async () => {
    const { removeRecentFromList } = await import('./NavigatorApp');
    const next = removeRecentFromList(
      [
        { path: '/tmp/a', name: 'a', lastOpenedAt: '2026-04-20T00:00:00Z' },
        { path: '/tmp/b', name: 'b', lastOpenedAt: '2026-04-19T00:00:00Z', missing: true },
        { path: '/tmp/c', name: 'c', lastOpenedAt: '2026-04-18T00:00:00Z' },
      ],
      '/tmp/b',
    );
    expect(next.map((row) => row.path)).toEqual(['/tmp/a', '/tmp/c']);
  });

  test('removeRecentFromList is a no-op for unknown paths', async () => {
    const { removeRecentFromList } = await import('./NavigatorApp');
    const recents = [{ path: '/tmp/a', name: 'a', lastOpenedAt: '2026-04-20T00:00:00Z' }];
    expect(removeRecentFromList(recents, '/tmp/missing')).toEqual(recents);
  });
});

describe('NavigatorApp error-state helpers', () => {
  test('resolveErrorMessage prefers Error.message', async () => {
    const { resolveErrorMessage } = await import('./NavigatorApp');
    expect(resolveErrorMessage(new Error('boom'), 'fallback')).toBe('boom');
  });

  test('resolveErrorMessage falls back when message is empty', async () => {
    const { resolveErrorMessage } = await import('./NavigatorApp');
    expect(resolveErrorMessage(new Error(''), 'fallback')).toBe('fallback');
  });

  test('resolveErrorMessage falls back for non-Error throws (string, undefined, object)', async () => {
    const { resolveErrorMessage } = await import('./NavigatorApp');
    expect(resolveErrorMessage('plain-string', 'fallback')).toBe('fallback');
    expect(resolveErrorMessage(undefined, 'fallback')).toBe('fallback');
    expect(resolveErrorMessage({ weird: 'object' }, 'fallback')).toBe('fallback');
    expect(resolveErrorMessage(null, 'fallback')).toBe('fallback');
  });

  test('runWithErrorStatePure clears error state then awaits the wrapped fn', async () => {
    const { runWithErrorStatePure } = await import('./NavigatorApp');
    const setError = mock(() => {});
    const fn = mock(() => Promise.resolve());
    await runWithErrorStatePure(fn, 'fallback', setError);
    expect(setError).toHaveBeenCalledWith(null);
    expect(fn).toHaveBeenCalled();
  });

  test('runWithErrorStatePure surfaces rejections via setError with Error.message', async () => {
    const { runWithErrorStatePure } = await import('./NavigatorApp');
    const setErrorCalls: Array<string | null> = [];
    await runWithErrorStatePure(
      () => Promise.reject(new Error('boot failed')),
      'Failed to open project.',
      (msg) => {
        setErrorCalls.push(msg);
      },
    );
    expect(setErrorCalls).toEqual([null, 'boot failed']);
  });

  test('runWithErrorStatePure falls back when rejection has no usable message', async () => {
    const { runWithErrorStatePure } = await import('./NavigatorApp');
    const setErrorCalls: Array<string | null> = [];
    await runWithErrorStatePure(
      () => Promise.reject('network dropped'),
      'Failed to open project.',
      (msg) => {
        setErrorCalls.push(msg);
      },
    );
    expect(setErrorCalls).toEqual([null, 'Failed to open project.']);
  });

  test('runWithErrorStatePure does NOT re-throw on rejection (caller continues)', async () => {
    const { runWithErrorStatePure } = await import('./NavigatorApp');
    let afterAwait = false;
    await runWithErrorStatePure(
      () => Promise.reject(new Error('x')),
      'fallback',
      () => {},
    );
    afterAwait = true;
    expect(afterAwait).toBe(true);
  });
});
