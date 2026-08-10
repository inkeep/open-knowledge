import { describe, expect, test, vi } from 'vitest';
import { beginNavigatorHandoff, createNavigatorWindow } from '../../src/main/navigator-window.ts';
import type { ShowGateRegistry } from '../../src/main/show-gate.ts';
import type { ShareNavigatorPayload } from '../../src/main/url-scheme.ts';
import type { BrowserWindowLike } from '../../src/main/window-manager.ts';

/**
 * Close-path unit tests — exercise the three branches (null / destroyed /
 * alive) and the throw-swallow guarantee in milliseconds, instead of relying
 * solely on the smoke E2E to catch a regression that moves the close call out
 * of the `try` block. The close itself is module-private, so these drive it
 * through the handoff that owns it.
 */

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
    // null branch — caller never opened the Navigator (cold launch with
    // lastOpenedProject set). Must not throw and must not log.
    beginNavigatorHandoff(null).close({ projectPath: '/p' }, log);
    expect(log).not.toHaveBeenCalled();
  });

  test('no-op when window is destroyed', () => {
    const nav = makeNav({ destroyed: true });
    const log = vi.fn(() => {});
    // Race: the close listener nulls navigatorWindow on user-initiated
    // close, but in a renderer-crash window between createProjectWindow
    // resolving and reaching the close call the variable could still
    // reference a destroyed BrowserWindow. close() throws on destroyed in
    // real Electron — the guard avoids the throw and the spurious log.
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
    // The throw must NOT propagate — propagation would land in
    // openProjectOrFallbackToNavigator's catch and surface "Unable to open
    // project" to the user even though the project did open. The log
    // captures the failure for triage.
    expect(() =>
      beginNavigatorHandoff(nav).close({ projectPath: '/path/to/proj' }, log),
    ).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'failed to close Navigator after project open',
      expect.objectContaining({
        projectPath: '/path/to/proj',
        err: 'Object has been destroyed',
      }),
    );
  });

  test('stringifies non-Error throws so the log carries diagnostic signal', () => {
    const nav = makeNav({
      closeImpl: () => {
        // Native Electron paths can throw non-Error values; the logger
        // must produce a string instead of `undefined`.
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
  /**
   * The module-global `navigatorWindow` is mutable and the opens that consult
   * it are slow, so these tests model the call sites as: snapshot, mutate the
   * "global" the way a mid-open user action would, then close.
   */
  test('closes the Navigator that was up when the open began', () => {
    const nav = makeNav();
    const handoff = beginNavigatorHandoff(nav);
    handoff.close({ projectPath: '/p' });
    expect(nav.closeMock).toHaveBeenCalledTimes(1);
  });

  test('leaves a Navigator summoned after the open began alone', () => {
    // Boot with `lastOpenedProject`: no launcher is up when the open starts,
    // and the user hits File → Project Navigator while the project window is
    // still loading. Closing it here is what made the summoned window flash
    // and vanish, and what rejected its in-flight load with ERR_FAILED.
    // `navigatorWindow` stands in for main's module-global of the same name:
    // reassigning it after the handoff begins is the mid-open summon, and the
    // binding under assertion is the one an end-of-open read would have hit.
    let navigatorWindow: MockNav | null = null;
    const handoff = beginNavigatorHandoff(navigatorWindow);
    navigatorWindow = makeNav();
    handoff.close({ projectPath: '/p' });
    expect(navigatorWindow.closeMock).not.toHaveBeenCalled();
  });

  test('a summoned Navigator survives even when one was already up', () => {
    // Switch-Project: the launcher that picked the project still closes, but a
    // second one summoned during the open is the user's and stays.
    const pickedFrom = makeNav();
    let navigatorWindow: MockNav | null = pickedFrom;
    const handoff = beginNavigatorHandoff(navigatorWindow);
    navigatorWindow = makeNav();
    handoff.close({ projectPath: '/p' });
    expect(pickedFrom.closeMock).toHaveBeenCalledTimes(1);
    expect(navigatorWindow.closeMock).not.toHaveBeenCalled();
  });

  test('adopt transfers ownership to a Navigator the open put up itself', () => {
    // The `fresh` discovery branch opens a launcher to host the consent
    // dialog when none was up; it must not outlive the project it onboarded.
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
  // Light-weight fakes mirroring window-manager.test.ts's makeWindow shape but
  // pared to what `createNavigatorWindow` actually touches: `webContents.once`,
  // `webContents.send`, `loadFile`/`loadURL`, `on('closed')`, and the
  // structural surface BrowserWindowLike asks for. We capture the dom-ready
  // and did-finish-load callbacks so tests can fire them deterministically.
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
    // Mirrors window-manager's pendingDeepLinkDoc regression: registering
    // the listener after loadFile silently misses dom-ready on a fast load.
    const win = makeNavWindow();
    createNavigatorWindow({
      createWindow: () => win,
      rendererEntryPath: '/fake/index.html',
      appVersion: '9.9.9-test',
      showGate: makeShowGate(),
      pendingPayload: makePayload(),
    });

    // Pre-loadFile, the dom-ready listener is in place.
    expect(win.onceCalledBeforeLoad).toBe(true);

    // Payload has NOT fired yet.
    expect(
      (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => c[0] === 'ok:share:received',
      ),
    ).toBeUndefined();

    // Firing dom-ready triggers the send.
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
    // The default Navigator open path (no share in flight) must not register
    // a stray listener. Without this assertion, a regression that always
    // registered `once('dom-ready')` would fire a phantom share event on
    // every Navigator open.
    const win = makeNavWindow();
    createNavigatorWindow({
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
