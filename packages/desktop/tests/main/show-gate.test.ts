import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  type BrowserWindowLike,
  createShowGateRegistry,
  type ShowGateRegistry,
} from '../../src/main/show-gate.ts';

interface CapturedTimer {
  cb: () => void;
  ms: number;
  handle: unknown;
}

interface MockWindow extends BrowserWindowLike {
  show: ReturnType<typeof mock>;
  fireReadyToShow: () => void;
  markDestroyed: () => void;
  markVisible: () => void;
}

function makeWindow(): MockWindow {
  let readyToShowCb: (() => void) | null = null;
  let destroyed = false;
  let visible = false;
  const show = mock(() => {
    visible = true;
  });
  return {
    show,
    isDestroyed: mock(() => destroyed),
    isVisible: mock(() => visible),
    on: mock(() => {}) as BrowserWindowLike['on'],
    once: mock((event: 'ready-to-show', cb: () => void) => {
      if (event === 'ready-to-show') readyToShowCb = cb;
    }) as BrowserWindowLike['once'],
    focus: mock(() => {}),
    isMinimized: mock(() => false),
    restore: mock(() => {}),
    webContents: {
      send: mock(() => {}),
      once: mock(() => {}),
      setWindowOpenHandler: mock(() => {}),
      on: mock(() => {}) as BrowserWindowLike['webContents']['on'],
    },
    loadFile: mock(() => Promise.resolve()),
    loadURL: mock(() => Promise.resolve()),
    fireReadyToShow: () => readyToShowCb?.(),
    markDestroyed: () => {
      destroyed = true;
    },
    markVisible: () => {
      visible = true;
    },
  };
}

interface TestEnv {
  timers: CapturedTimer[];
  cleared: unknown[];
  warns: Array<{ obj: object; msg: string }>;
  registry: ShowGateRegistry;
}

function buildEnv(opts?: { timeoutMs?: number }): TestEnv {
  const timers: CapturedTimer[] = [];
  const cleared: unknown[] = [];
  const warns: Array<{ obj: object; msg: string }> = [];
  const registry = createShowGateRegistry({
    log: {
      warn: (obj, msg) => {
        warns.push({ obj, msg });
      },
    },
    setTimeout: (cb, ms) => {
      const handle = { id: timers.length };
      timers.push({ cb, ms, handle });
      return handle;
    },
    clearTimeout: (handle) => {
      cleared.push(handle);
    },
    timeoutMs: opts?.timeoutMs,
  });
  return { timers, cleared, warns, registry };
}

describe('createShowGateRegistry — dual-signal show contract', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = buildEnv();
  });

  test('both signals (ready-to-show first) → show called exactly once', () => {
    const win = makeWindow();
    env.registry.register(win, { kind: 'editor' });

    win.fireReadyToShow();
    expect(win.show).not.toHaveBeenCalled();

    env.registry.fireThemeApplied(win);
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  test('both signals (theme-applied first) → show called exactly once', () => {
    const win = makeWindow();
    env.registry.register(win);

    env.registry.fireThemeApplied(win);
    expect(win.show).not.toHaveBeenCalled();

    win.fireReadyToShow();
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  test('only ready-to-show → show NOT called (theme signal still pending)', () => {
    const win = makeWindow();
    env.registry.register(win);
    win.fireReadyToShow();
    expect(win.show).not.toHaveBeenCalled();
    expect(env.warns).toHaveLength(0);
  });

  test('only theme-applied → show NOT called (chrome signal still pending)', () => {
    const win = makeWindow();
    env.registry.register(win);
    env.registry.fireThemeApplied(win);
    expect(win.show).not.toHaveBeenCalled();
    expect(env.warns).toHaveLength(0);
  });

  test('show is idempotent — duplicate signal arrival does not double-fire', () => {
    const win = makeWindow();
    env.registry.register(win);
    win.fireReadyToShow();
    env.registry.fireThemeApplied(win);
    expect(win.show).toHaveBeenCalledTimes(1);
    env.registry.fireThemeApplied(win);
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  test('register schedules a 5_000ms safety timer by default', () => {
    const win = makeWindow();
    env.registry.register(win);
    expect(env.timers).toHaveLength(1);
    expect(env.timers[0]?.ms).toBe(5_000);
  });

  test('register passes the configured timeoutMs through to setTimeout', () => {
    const customEnv = buildEnv({ timeoutMs: 50 });
    const win = makeWindow();
    customEnv.registry.register(win);
    expect(customEnv.timers).toHaveLength(1);
    expect(customEnv.timers[0]?.ms).toBe(50);
  });
});

describe('createShowGateRegistry — timeout fallback', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = buildEnv();
  });

  test('neither signal + timeout fires → show called with structured warn missing=both', () => {
    const win = makeWindow();
    env.registry.register(win, { kind: 'editor' });
    env.timers[0]?.cb();
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(env.warns).toHaveLength(1);
    expect(env.warns[0]?.obj).toEqual({
      event: 'show-gate-timeout',
      missing: 'both',
      windowKind: 'editor',
    });
  });

  test('only ready-to-show + timeout → show called with missing=theme-applied', () => {
    const win = makeWindow();
    env.registry.register(win, { kind: 'editor' });
    win.fireReadyToShow();
    expect(win.show).not.toHaveBeenCalled();
    env.timers[0]?.cb();
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(env.warns[0]?.obj).toEqual({
      event: 'show-gate-timeout',
      missing: 'theme-applied',
      windowKind: 'editor',
    });
  });

  test('only theme-applied + timeout → show called with missing=ready-to-show', () => {
    const win = makeWindow();
    env.registry.register(win, { kind: 'navigator' });
    env.registry.fireThemeApplied(win);
    expect(win.show).not.toHaveBeenCalled();
    env.timers[0]?.cb();
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(env.warns[0]?.obj).toEqual({
      event: 'show-gate-timeout',
      missing: 'ready-to-show',
      windowKind: 'navigator',
    });
  });

  test('both signals before timeout → timeout no-ops (idempotent)', () => {
    const win = makeWindow();
    env.registry.register(win);
    win.fireReadyToShow();
    env.registry.fireThemeApplied(win);
    expect(win.show).toHaveBeenCalledTimes(1);
    env.timers[0]?.cb();
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(env.warns).toHaveLength(0);
  });

  test('window destroyed before signals + timeout → no show, no warn', () => {
    const win = makeWindow();
    env.registry.register(win);
    win.markDestroyed();
    env.timers[0]?.cb();
    expect(win.show).not.toHaveBeenCalled();
    expect(env.warns).toHaveLength(0);
  });

  test('window already visible before timeout → no show, no warn (race race-resolved)', () => {
    const win = makeWindow();
    env.registry.register(win);
    win.markVisible();
    env.timers[0]?.cb();
    expect(win.show).not.toHaveBeenCalled();
    expect(env.warns).toHaveLength(0);
  });

  test('windowKind defaults to editor when omitted', () => {
    const win = makeWindow();
    env.registry.register(win);
    env.timers[0]?.cb();
    expect(env.warns[0]?.obj).toMatchObject({ windowKind: 'editor' });
  });
});

describe('createShowGateRegistry — dispose + cleanup', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = buildEnv();
  });

  test('dispose() before either signal → subsequent fireThemeApplied is no-op', () => {
    const win = makeWindow();
    const dispose = env.registry.register(win);
    dispose();
    win.fireReadyToShow();
    env.registry.fireThemeApplied(win);
    expect(win.show).not.toHaveBeenCalled();
  });

  test('dispose() before either signal → timeout is no-op (no warn, no show)', () => {
    const win = makeWindow();
    const dispose = env.registry.register(win);
    dispose();
    env.timers[0]?.cb();
    expect(win.show).not.toHaveBeenCalled();
    expect(env.warns).toHaveLength(0);
  });

  test('fireThemeApplied for an unregistered window → no-op (no throw)', () => {
    const stranger = makeWindow();
    expect(() => env.registry.fireThemeApplied(stranger)).not.toThrow();
    expect(stranger.show).not.toHaveBeenCalled();
  });

  test('two windows are tracked independently — one signaling does not show the other', () => {
    const a = makeWindow();
    const b = makeWindow();
    env.registry.register(a);
    env.registry.register(b);

    a.fireReadyToShow();
    env.registry.fireThemeApplied(a);
    expect(a.show).toHaveBeenCalledTimes(1);
    expect(b.show).not.toHaveBeenCalled();

    b.fireReadyToShow();
    env.registry.fireThemeApplied(b);
    expect(b.show).toHaveBeenCalledTimes(1);
  });

  test('shown window is removed from registry — late fireThemeApplied is no-op', () => {
    const win = makeWindow();
    env.registry.register(win);
    win.fireReadyToShow();
    env.registry.fireThemeApplied(win);
    expect(win.show).toHaveBeenCalledTimes(1);
    env.registry.fireThemeApplied(win);
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  test('dispose() clears the safety timer so the closure is not pinned past dispose', () => {
    const win = makeWindow();
    const dispose = env.registry.register(win);
    expect(env.timers).toHaveLength(1);
    expect(env.cleared).toHaveLength(0);
    dispose();
    expect(env.cleared).toHaveLength(1);
    expect(env.cleared[0]).toBe(env.timers[0]?.handle);
  });

  test('show after both signals also clears the safety timer', () => {
    const win = makeWindow();
    env.registry.register(win);
    win.fireReadyToShow();
    env.registry.fireThemeApplied(win);
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(env.cleared).toHaveLength(1);
    expect(env.cleared[0]).toBe(env.timers[0]?.handle);
  });
});

describe('createShowGateRegistry — destroyed-window race on the happy path', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = buildEnv();
  });

  test('window destroyed between both signals and maybeShow → does not call show', () => {
    const win = makeWindow();
    env.registry.register(win);
    win.fireReadyToShow();
    win.markDestroyed();
    env.registry.fireThemeApplied(win);
    expect(win.show).not.toHaveBeenCalled();
  });

  test('window already-visible between both signals and maybeShow → does not double-show', () => {
    const win = makeWindow();
    env.registry.register(win);
    win.fireReadyToShow();
    win.markVisible();
    env.registry.fireThemeApplied(win);
    expect(win.show).not.toHaveBeenCalled();
  });
});

describe('createShowGateRegistry — show() throws past the destroyed-window guard', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = buildEnv();
  });

  function makeThrowingWindow(): MockWindow {
    const win = makeWindow();
    win.show = mock(() => {
      throw new Error('Object has been destroyed');
    });
    return win;
  }

  test('happy-path show throws → catch logs structured warn + does not propagate', () => {
    const win = makeThrowingWindow();
    env.registry.register(win, { kind: 'editor' });
    win.fireReadyToShow();
    expect(() => env.registry.fireThemeApplied(win)).not.toThrow();
    const failure = env.warns.find(
      (w) => (w.obj as { event?: unknown }).event === 'show-gate-show-failed',
    );
    expect(failure).toBeDefined();
    expect(failure?.obj).toMatchObject({
      event: 'show-gate-show-failed',
      windowKind: 'editor',
      error: 'Object has been destroyed',
    });
  });

  test('happy-path show throws → states Map entry is released (no leak)', () => {
    const win = makeThrowingWindow();
    env.registry.register(win);
    win.fireReadyToShow();
    env.registry.fireThemeApplied(win);
    win.show = mock(() => {});
    env.registry.fireThemeApplied(win);
    expect(win.show).not.toHaveBeenCalled();
  });

  test('timeout-path show throws → catch logs warn + does not escape setTimeout', () => {
    const win = makeThrowingWindow();
    env.registry.register(win, { kind: 'navigator' });
    expect(() => env.timers[0]?.cb()).not.toThrow();
    const failure = env.warns.find(
      (w) => (w.obj as { event?: unknown }).event === 'show-gate-show-failed',
    );
    expect(failure).toBeDefined();
    expect(failure?.obj).toMatchObject({
      event: 'show-gate-show-failed',
      windowKind: 'navigator',
      error: 'Object has been destroyed',
    });
    const timeout = env.warns.find(
      (w) => (w.obj as { event?: unknown }).event === 'show-gate-timeout',
    );
    expect(timeout).toBeDefined();
  });
});
