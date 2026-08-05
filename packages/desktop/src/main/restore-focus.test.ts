import { describe, expect, test } from 'vitest';
import {
  type RestoreFocusDeps,
  type RevealableWindow,
  raiseMostRecentlyFocusedAfterRestore,
  shouldRevealInactiveNow,
  whenWindowRevealed,
} from './restore-focus.ts';

/** Captured-timer harness so tests fire the safety timeout deterministically. */
function makeTimers(timeoutMs = 8_000): {
  deps: RestoreFocusDeps;
  fireAll: () => void;
  pending: () => number;
} {
  const timers = new Map<number, () => void>();
  let nextId = 1;
  return {
    deps: {
      setTimeout: (cb) => {
        const id = nextId++;
        timers.set(id, cb);
        return id;
      },
      clearTimeout: (handle) => {
        timers.delete(handle as number);
      },
      timeoutMs,
    },
    fireAll: () => {
      const snapshot = [...timers.values()];
      timers.clear();
      for (const cb of snapshot) cb();
    },
    pending: () => timers.size,
  };
}

interface FakeWindow extends RevealableWindow {
  emitShow: () => void;
  destroy: () => void;
}

function makeWindow(opts: { visible?: boolean; destroyed?: boolean } = {}): FakeWindow {
  let visible = opts.visible ?? false;
  let destroyed = opts.destroyed ?? false;
  const showListeners: Array<() => void> = [];
  return {
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    once: (_event, listener) => {
      showListeners.push(listener);
    },
    emitShow: () => {
      visible = true;
      const snapshot = [...showListeners];
      showListeners.length = 0;
      for (const l of snapshot) l();
    },
    destroy: () => {
      destroyed = true;
    },
  };
}

const flush = () => Promise.resolve();

describe('shouldRevealInactiveNow', () => {
  // Full truth table. All three terms are load-bearing, and only one row is
  // true — pinning every combination is what makes a dropped term fail here
  // rather than in a user's window stack.
  test.each([
    { restoreInProgress: false, appHasEverBeenActive: false, appIsActive: false, expected: false },
    { restoreInProgress: false, appHasEverBeenActive: false, appIsActive: true, expected: false },
    { restoreInProgress: false, appHasEverBeenActive: true, appIsActive: false, expected: false },
    { restoreInProgress: false, appHasEverBeenActive: true, appIsActive: true, expected: false },
    { restoreInProgress: true, appHasEverBeenActive: false, appIsActive: false, expected: false },
    { restoreInProgress: true, appHasEverBeenActive: false, appIsActive: true, expected: false },
    { restoreInProgress: true, appHasEverBeenActive: true, appIsActive: false, expected: true },
    { restoreInProgress: true, appHasEverBeenActive: true, appIsActive: true, expected: false },
  ])('restore=$restoreInProgress everActive=$appHasEverBeenActive active=$appIsActive → $expected', ({
    expected,
    ...state
  }) => {
    expect(shouldRevealInactiveNow(state)).toBe(expected);
  });

  test('a restore that has never been frontmost reveals normally, not quietly', () => {
    // The anti-self-suppression row, called out because it is the one that
    // reads redundant. `showInactive()` never activates the app, so if the
    // first restored window also revealed quietly the app would never become
    // active, never observe a departure, and never come forward — a user who
    // clicked Relaunch and waited would get their session back behind whatever
    // macOS promoted when OpenKnowledge quit.
    expect(
      shouldRevealInactiveNow({
        restoreInProgress: true,
        appHasEverBeenActive: false,
        appIsActive: false,
      }),
    ).toBe(false);
  });
});

describe('whenWindowRevealed', () => {
  test('resolves immediately when already visible', async () => {
    const { deps, pending } = makeTimers();
    await whenWindowRevealed(makeWindow({ visible: true }), deps);
    // No safety timer should linger for an already-visible window.
    expect(pending()).toBe(0);
  });

  test('resolves immediately when destroyed', async () => {
    const { deps, pending } = makeTimers();
    await whenWindowRevealed(makeWindow({ destroyed: true }), deps);
    expect(pending()).toBe(0);
  });

  test('resolves on show and clears the safety timer', async () => {
    const { deps, pending } = makeTimers();
    const win = makeWindow();
    let resolved = false;
    const p = whenWindowRevealed(win, deps).then(() => {
      resolved = true;
    });
    expect(pending()).toBe(1);
    win.emitShow();
    await p;
    expect(resolved).toBe(true);
    expect(pending()).toBe(0);
  });

  test('resolves via the safety timeout when show never fires', async () => {
    const { deps, fireAll } = makeTimers();
    const win = makeWindow();
    let resolved = false;
    const p = whenWindowRevealed(win, deps).then(() => {
      resolved = true;
    });
    await flush();
    expect(resolved).toBe(false);
    fireAll();
    await p;
    expect(resolved).toBe(true);
  });
});

describe('raiseMostRecentlyFocusedAfterRestore', () => {
  test('raises the last (most recently focused) entry only after every window reveals', async () => {
    const { deps } = makeTimers();
    const winA = makeWindow();
    const winB = makeWindow();
    const wins: Record<string, FakeWindow> = { '/a': winA, '/b': winB };
    const raised: string[] = [];

    const p = raiseMostRecentlyFocusedAfterRestore({
      windowKeys: ['/a', '/b'],
      getWindow: (path) => wins[path],
      raise: (path) => raised.push(path),
      deps,
    });

    await flush();
    // The target (/b) shows first, but /a is still gated — no raise yet.
    winB.emitShow();
    await flush();
    expect(raised).toEqual([]);

    // The last sibling reveals; now the target must win the final show().
    winA.emitShow();
    await p;
    expect(raised).toEqual(['/b']);
  });

  test('does not wait on windows that fell back to the Navigator (absent)', async () => {
    const { deps } = makeTimers();
    const winB = makeWindow();
    const wins: Record<string, FakeWindow | undefined> = { '/a': undefined, '/b': winB };
    const raised: string[] = [];

    const p = raiseMostRecentlyFocusedAfterRestore({
      windowKeys: ['/a', '/b'],
      getWindow: (path) => wins[path],
      raise: (path) => raised.push(path),
      deps,
    });

    await flush();
    winB.emitShow();
    await p;
    expect(raised).toEqual(['/b']);
  });

  test('skips the raise when the target was destroyed mid-restore', async () => {
    const { deps } = makeTimers();
    const winB = makeWindow({ destroyed: true });
    const raised: string[] = [];

    await raiseMostRecentlyFocusedAfterRestore({
      windowKeys: ['/b'],
      getWindow: () => winB,
      raise: (path) => raised.push(path),
      deps,
    });

    expect(raised).toEqual([]);
  });

  test('is a no-op for an empty snapshot', async () => {
    const { deps } = makeTimers();
    const raised: string[] = [];
    await raiseMostRecentlyFocusedAfterRestore({
      windowKeys: [],
      getWindow: () => undefined,
      raise: (path) => raised.push(path),
      deps,
    });
    expect(raised).toEqual([]);
  });

  test('still raises the target when a sibling only reveals via the safety timeout', async () => {
    const { deps, fireAll } = makeTimers();
    const winA = makeWindow(); // never emits show — must time out
    const winB = makeWindow({ visible: true }); // target already visible
    const wins: Record<string, FakeWindow> = { '/a': winA, '/b': winB };
    const raised: string[] = [];

    const p = raiseMostRecentlyFocusedAfterRestore({
      windowKeys: ['/a', '/b'],
      getWindow: (path) => wins[path],
      raise: (path) => raised.push(path),
      deps,
    });

    await flush();
    expect(raised).toEqual([]);
    fireAll();
    await p;
    expect(raised).toEqual(['/b']);
  });

  test('raises across kinds — a loose-file key can be the raise target', async () => {
    // Keys are opaque (a project path OR a canonical file path); the loose-file
    // window is focused last, so it is the one raised after every window reveals.
    const { deps } = makeTimers();
    const projWin = makeWindow({ visible: true });
    const fileWin = makeWindow();
    const wins: Record<string, FakeWindow> = { '/proj': projWin, '/notes/todo.md': fileWin };
    const raised: string[] = [];

    const p = raiseMostRecentlyFocusedAfterRestore({
      windowKeys: ['/proj', '/notes/todo.md'],
      getWindow: (key) => wins[key],
      raise: (key) => raised.push(key),
      deps,
    });

    await flush();
    fileWin.emitShow();
    await p;
    expect(raised).toEqual(['/notes/todo.md']);
  });
});

describe('raiseMostRecentlyFocusedAfterRestore — foreground decision', () => {
  /** Run a two-window restore to completion, returning the raise's opts. */
  async function runRestore(
    shouldActivate?: () => boolean,
  ): Promise<Array<{ key: string; activate: boolean }>> {
    const { deps } = makeTimers();
    const a = makeWindow();
    const b = makeWindow();
    const wins: Record<string, FakeWindow> = { '/a': a, '/b': b };
    const calls: Array<{ key: string; activate: boolean }> = [];

    const p = raiseMostRecentlyFocusedAfterRestore({
      windowKeys: ['/a', '/b'],
      getWindow: (key) => wins[key],
      raise: (key, opts) => calls.push({ key, activate: opts.activate }),
      shouldActivate,
      deps,
    });

    await flush();
    a.emitShow();
    b.emitShow();
    await p;
    return calls;
  }

  test('activates when the predicate says the user is still here', async () => {
    expect(await runRestore(() => true)).toEqual([{ key: '/b', activate: true }]);
  });

  test('declines to activate when the user has moved to another app', async () => {
    // The reported bug: a restore that finishes after the user gave up waiting
    // must not drag them back out of whatever they switched to.
    expect(await runRestore(() => false)).toEqual([{ key: '/b', activate: false }]);
  });

  test('omitted predicate activates, preserving the previous behavior', async () => {
    expect(await runRestore()).toEqual([{ key: '/b', activate: true }]);
  });

  test('reads the predicate after every reveal settles, not when the restore starts', async () => {
    // This ordering is the whole point: a restore can run for many seconds, and
    // the user leaving DURING it is exactly the case being fixed. Sampling the
    // answer up front would activate anyway and reproduce the bug.
    const { deps } = makeTimers();
    const a = makeWindow();
    const b = makeWindow();
    const wins: Record<string, FakeWindow> = { '/a': a, '/b': b };
    const calls: Array<{ key: string; activate: boolean }> = [];
    let userPresent = true;

    const p = raiseMostRecentlyFocusedAfterRestore({
      windowKeys: ['/a', '/b'],
      getWindow: (key) => wins[key],
      raise: (key, opts) => calls.push({ key, activate: opts.activate }),
      shouldActivate: () => userPresent,
      deps,
    });

    await flush();
    a.emitShow();
    // The user walks away while the last window is still coming up.
    userPresent = false;
    b.emitShow();
    await p;

    expect(calls).toEqual([{ key: '/b', activate: false }]);
  });
});
