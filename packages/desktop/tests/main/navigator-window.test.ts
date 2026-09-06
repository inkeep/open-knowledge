import { describe, expect, test, vi } from 'vitest';
import { beginNavigatorHandoff, createNavigatorWindow } from '../../src/main/navigator-window.ts';
import type { ShowGateRegistry } from '../../src/main/show-gate.ts';
import type { ShareNavigatorPayload } from '../../src/main/url-scheme.ts';
import type { BrowserWindowLike } from '../../src/main/window-manager.ts';
import { SPAWN_WAIT_HEARTBEAT_MS } from '../../src/shared/boot-narration.ts';

interface MockNav extends BrowserWindowLike {
  closeMock: ReturnType<typeof vi.fn>;
  setDestroyed: (v: boolean) => void;
}

function makeNav(opts?: { destroyed?: boolean; closeImpl?: () => void }): MockNav {
  let destroyed = opts?.destroyed ?? false;
  const closeMock = vi.fn(() => {
    if (opts?.closeImpl) opts.closeImpl();
  });
  return {
    focus: vi.fn(() => {}),
    isDestroyed: vi.fn(() => destroyed),
    on: vi.fn(() => {}) as BrowserWindowLike['on'],
    once: vi.fn(() => {}) as BrowserWindowLike['once'],
    webContents: {
      send: vi.fn(() => {}),
      once: vi.fn(() => {}),
      setWindowOpenHandler: vi.fn(() => {}),
      on: vi.fn(() => {}),
    },
    loadFile: vi.fn(() => Promise.resolve()),
    loadURL: vi.fn(() => Promise.resolve()),
    close: closeMock,
    closeMock,
    setDestroyed: (v) => {
      destroyed = v;
    },
  };
}

describe('navigator close path', () => {
  test('no-op when navigator is null', () => {
    const log = vi.fn(() => {});
    beginNavigatorHandoff(null).close({ projectPath: '/p' }, log);
    expect(log).not.toHaveBeenCalled();
  });

  test('no-op when window is destroyed', () => {
    const nav = makeNav({ destroyed: true });
    const log = vi.fn(() => {});
    beginNavigatorHandoff(nav).close({ projectPath: '/p' }, log);
    expect(nav.closeMock).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  test('calls close() when window is alive', () => {
    const nav = makeNav();
    const log = vi.fn(() => {});
    beginNavigatorHandoff(nav).close({ projectPath: '/p' }, log);
    expect(nav.closeMock).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  test('swallows exceptions from close() and logs with projectPath', () => {
    const nav = makeNav({
      closeImpl: () => {
        throw new Error('Object has been destroyed');
      },
    });
    const log = vi.fn(() => {});
    expect(() =>
      beginNavigatorHandoff(nav).close({ projectPath: '/path/to/proj' }, log),
    ).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'failed to close Navigator after project open',
      expect.objectContaining({
        projectPath: '/path/to/proj',
        err: expect.objectContaining({ message: 'Object has been destroyed' }),
      }),
    );
  });

  test('passes a non-Error throw through untouched, for the serializer to render', () => {
    const nav = makeNav({
      closeImpl: () => {
        throw 'native-string-throw';
      },
    });
    const log = vi.fn(() => {});
    beginNavigatorHandoff(nav).close({ projectPath: '/p' }, log);
    expect(log).toHaveBeenCalledWith(
      'failed to close Navigator after project open',
      expect.objectContaining({ err: 'native-string-throw' }),
    );
  });
});

describe('beginNavigatorHandoff', () => {
  test('closes the Navigator that was up when the open began', () => {
    const nav = makeNav();
    const handoff = beginNavigatorHandoff(nav);
    handoff.close({ projectPath: '/p' });
    expect(nav.closeMock).toHaveBeenCalledTimes(1);
  });

  test('leaves a Navigator summoned after the open began alone', () => {
    let navigatorWindow: MockNav | null = null;
    const handoff = beginNavigatorHandoff(navigatorWindow);
    navigatorWindow = makeNav();
    handoff.close({ projectPath: '/p' });
    expect(navigatorWindow.closeMock).not.toHaveBeenCalled();
  });

  test('a summoned Navigator survives even when one was already up', () => {
    const pickedFrom = makeNav();
    let navigatorWindow: MockNav | null = pickedFrom;
    const handoff = beginNavigatorHandoff(navigatorWindow);
    navigatorWindow = makeNav();
    handoff.close({ projectPath: '/p' });
    expect(pickedFrom.closeMock).toHaveBeenCalledTimes(1);
    expect(navigatorWindow.closeMock).not.toHaveBeenCalled();
  });

  test('adopt transfers ownership to a Navigator the open put up itself', () => {
    const handoff = beginNavigatorHandoff(null);
    const consentHost = makeNav();
    handoff.adopt(consentHost);
    handoff.close({ projectPath: '/p' });
    expect(consentHost.closeMock).toHaveBeenCalledTimes(1);
  });

  test('adopt replaces the at-start snapshot rather than closing both', () => {
    const atStart = makeNav();
    const adopted = makeNav();
    const handoff = beginNavigatorHandoff(atStart);
    handoff.adopt(adopted);
    handoff.close({ projectPath: '/p' });
    expect(adopted.closeMock).toHaveBeenCalledTimes(1);
    expect(atStart.closeMock).not.toHaveBeenCalled();
  });

  test('a handed-off Navigator the user already closed is a no-op, not a throw', () => {
    const nav = makeNav();
    const handoff = beginNavigatorHandoff(nav);
    nav.setDestroyed(true);
    const log = vi.fn(() => {});
    expect(() => handoff.close({ projectPath: '/p' }, log)).not.toThrow();
    expect(nav.closeMock).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  test('forwards the close-failure log so the diagnostic survives the indirection', () => {
    const nav = makeNav({
      closeImpl: () => {
        throw new Error('Object has been destroyed');
      },
    });
    const log = vi.fn(() => {});
    beginNavigatorHandoff(nav).close({ projectPath: '/path/to/proj' }, log);
    expect(log).toHaveBeenCalledWith(
      'failed to close Navigator after project open',
      expect.objectContaining({ projectPath: '/path/to/proj' }),
    );
  });
});

describe('createNavigatorWindow — pendingPayload dom-ready gate (US-004)', () => {
  interface NavWin extends BrowserWindowLike {
    fireDomReady: () => void;
    fireDidFinishLoad: () => void;
    loadCallOrder: string[];
    onceCalledBeforeLoad: boolean;
  }

  function makeNavWindow(): NavWin {
    let domReadyHandler: (() => void) | null = null;
    let didFinishLoadHandler: (() => void) | null = null;
    const closeHandlers: Array<() => void> = [];
    const loadCallOrder: string[] = [];
    let onceCalledBeforeLoad = false;
    return {
      focus: vi.fn(() => {}),
      isDestroyed: vi.fn(() => false),
      on: vi.fn((_event: 'closed', cb: () => void) => {
        closeHandlers.push(cb);
      }) as BrowserWindowLike['on'],
      once: vi.fn(() => {}) as BrowserWindowLike['once'],
      webContents: {
        send: vi.fn(() => {}),
        once: vi.fn((event: 'dom-ready' | 'did-finish-load', cb: () => void) => {
          if (event === 'dom-ready') {
            domReadyHandler = cb;
            loadCallOrder.push('once-dom-ready');
          } else {
            didFinishLoadHandler = cb;
            loadCallOrder.push('once-did-finish-load');
          }
        }),
        executeJavaScript: vi.fn(() => Promise.resolve()),
        setWindowOpenHandler: vi.fn(() => {}),
        on: vi.fn(() => {}),
      },
      loadFile: vi.fn(() => {
        loadCallOrder.push('loadFile');
        if (loadCallOrder.includes('once-dom-ready')) onceCalledBeforeLoad = true;
        return Promise.resolve();
      }),
      loadURL: vi.fn(() => {
        loadCallOrder.push('loadURL');
        if (loadCallOrder.includes('once-dom-ready')) onceCalledBeforeLoad = true;
        return Promise.resolve();
      }),
      close: vi.fn(() => {
        for (const h of closeHandlers) h();
      }),
      fireDomReady: () => domReadyHandler?.(),
      fireDidFinishLoad: () => didFinishLoadHandler?.(),
      loadCallOrder,
      get onceCalledBeforeLoad() {
        return onceCalledBeforeLoad;
      },
    };
  }

  function silentNarration() {
    return {
      log: { info: () => {}, warn: () => {} },
      flushLog: () => {},
      setInterval: () => undefined,
      clearInterval: () => {},
      languagePreference: 'system' as const,
    };
  }

  function makeShowGate(): ShowGateRegistry {
    return {
      register: () => () => {},
      fireThemeApplied: () => {},
    };
  }

  function makePayload(): ShareNavigatorPayload {
    return {
      kind: 'launcher-miss',
      share: {
        owner: 'inkeep',
        repo: 'playbooks',
        branch: 'main',
        path: 'docs/getting-started.md',
        blobUrl: 'https://github.com/inkeep/playbooks/blob/main/docs/getting-started.md',
      },
    };
  }

  test("cold path: pendingPayload registers webContents.once('dom-ready') BEFORE loadFile", () => {
    const win = makeNavWindow();
    createNavigatorWindow({
      ...silentNarration(),
      createWindow: () => win,
      rendererEntryPath: '/fake/index.html',
      appVersion: '9.9.9-test',
      showGate: makeShowGate(),
      pendingPayload: makePayload(),
    });

    expect(win.onceCalledBeforeLoad).toBe(true);

    expect(
      (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => c[0] === 'ok:share:received',
      ),
    ).toBeUndefined();

    win.fireDomReady();
    const shareCall = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'ok:share:received',
    );
    expect(shareCall).toBeDefined();
    expect(shareCall?.[1]).toEqual({
      kind: 'launcher-miss',
      share: {
        owner: 'inkeep',
        repo: 'playbooks',
        branch: 'main',
        path: 'docs/getting-started.md',
        blobUrl: 'https://github.com/inkeep/playbooks/blob/main/docs/getting-started.md',
      },
    });
  });

  test('cold path: no pendingPayload → no ok:share:received event fires on dom-ready', () => {
    const win = makeNavWindow();
    createNavigatorWindow({
      ...silentNarration(),
      createWindow: () => win,
      rendererEntryPath: '/fake/index.html',
      appVersion: '9.9.9-test',
      showGate: makeShowGate(),
    });

    win.fireDomReady();
    const sendCalls = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls;
    expect(sendCalls.find((c) => c[0] === 'ok:share:received')).toBeUndefined();
  });

  test('cold path: launcher-consent payload is also delivered (variant coverage)', () => {
    const win = makeNavWindow();
    const payload: ShareNavigatorPayload = {
      kind: 'launcher-consent',
      share: {
        owner: 'inkeep',
        repo: 'playbooks',
        branch: 'main',
        path: 'docs/getting-started.md',
        blobUrl: 'https://github.com/inkeep/playbooks/blob/main/docs/getting-started.md',
      },
      candidatePath: '/Users/me/playbooks/worktrees/wt-1',
    };
    createNavigatorWindow({
      ...silentNarration(),
      createWindow: () => win,
      rendererEntryPath: '/fake/index.html',
      appVersion: '9.9.9-test',
      showGate: makeShowGate(),
      pendingPayload: payload,
    });

    win.fireDomReady();
    const shareCall = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'ok:share:received',
    );
    expect(shareCall?.[1]).toEqual(payload);
  });
});

describe('navigator boot narration (the phase consent-dialog waits over)', () => {
  function makeShowGate(): ShowGateRegistry {
    return {
      register: () => () => {},
      fireThemeApplied: () => {},
    };
  }

  function harness(loadResult: Promise<void>) {
    const intervals: { cb: () => void; ms: number; cleared: boolean }[] = [];
    const lines: Record<string, unknown>[] = [];
    let flushes = 0;
    const win = {
      focus: vi.fn(() => {}),
      isDestroyed: vi.fn(() => false),
      on: vi.fn(() => {}) as BrowserWindowLike['on'],
      close: vi.fn(() => {}),
      loadFile: vi.fn(() => loadResult),
      loadURL: vi.fn(() => loadResult),
      webContents: { send: vi.fn(() => {}), once: vi.fn(() => {}), isLoading: vi.fn(() => false) },
    } as unknown as BrowserWindowLike;
    const deps = {
      createWindow: () => win,
      rendererEntryPath: '/fake/index.html',
      appVersion: '9.9.9-test',
      showGate: makeShowGate(),
      log: {
        info: (obj: Record<string, unknown>) => {
          lines.push({ ...obj, level: 'info' });
        },
        warn: (obj: Record<string, unknown>) => {
          lines.push({ ...obj, level: 'warn' });
        },
      },
      flushLog: () => {
        flushes += 1;
      },
      setInterval: (cb: () => void, ms: number) => {
        const rec = { cb, ms, cleared: false };
        intervals.push(rec);
        return rec;
      },
      clearInterval: (handle: unknown) => {
        (handle as { cleared: boolean }).cleared = true;
      },
    };
    return { deps, intervals, lines, flushes: () => flushes };
  }

  test('narrates while the navigator renderer is still loading, on the app cadence', () => {
    let resolveLoad: (() => void) | undefined;
    const h = harness(
      new Promise<void>((r) => {
        resolveLoad = r;
      }),
    );
    createNavigatorWindow(h.deps);

    const beat = h.intervals.find((i) => !i.cleared);
    expect(beat).toBeDefined();
    expect(beat?.ms).toBe(SPAWN_WAIT_HEARTBEAT_MS);
    beat?.cb();
    beat?.cb();
    expect(h.lines.filter((l) => l.event === 'desktop-navigator-load-progress')).toHaveLength(2);
    expect(h.flushes()).toBe(2);
    resolveLoad?.();
  });

  test('stops narrating and records the terminal line once the renderer resolves', async () => {
    const h = harness(Promise.resolve());
    createNavigatorWindow(h.deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.intervals.every((i) => i.cleared)).toBe(true);
    expect(h.lines.map((l) => l.event)).toContain('desktop-navigator-load-resolved');
  });

  test('a load failure reaches the boot log instead of only the console', async () => {
    const h = harness(Promise.reject(new Error('ERR_FILE_NOT_FOUND')));
    createNavigatorWindow(h.deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.intervals.every((i) => i.cleared)).toBe(true);
    const failure = h.lines.find((l) => l.event === 'desktop-navigator-load-failed');
    expect(failure).toMatchObject({ level: 'warn' });
    expect((failure?.err as Error).message).toBe('ERR_FILE_NOT_FOUND');
    const resolved = h.lines.find((l) => l.event === 'desktop-navigator-load-resolved');
    expect(resolved).toBeUndefined();
  });
});
