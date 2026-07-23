import { describe, expect, test } from 'vitest';
import {
  type RestoreFocusDeps,
  type RevealableWindow,
  raiseMostRecentlyFocusedAfterRestore,
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
      projects: ['/a', '/b'],
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
      projects: ['/a', '/b'],
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
      projects: ['/b'],
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
      projects: [],
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
      projects: ['/a', '/b'],
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
});
