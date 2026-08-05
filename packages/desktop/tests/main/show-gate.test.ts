import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type BrowserWindowLike,
  createShowGateRegistry,
  type ShowGateRegistry,
} from '../../src/main/show-gate.ts';

/**
 * Show-gate registry unit tests.
 *
 * Pure DI'd module — no Electron, no real timers. The registry coordinates the
 * dual-signal contract:
 *   - `ready-to-show` from BrowserWindow chrome-readiness
 *   - `ok:theme:applied` from renderer ConfigProvider after first sync settles
 *
 * Both must arrive before `window.show()` fires. A 5 s safety timeout falls
 * back to show with a structured warn so a stalled signal can't trap the user
 * with no visible window.
 */

interface CapturedTimer {
  cb: () => void;
  ms: number;
  handle: unknown;
}

interface MockWindow extends BrowserWindowLike {
  show: ReturnType<typeof vi.fn>;
  showInactive: ReturnType<typeof vi.fn>;
  fireReadyToShow: () => void;
  markDestroyed: () => void;
  markVisible: () => void;
}

function makeWindow(): MockWindow {
  let readyToShowCb: (() => void) | null = null;
  let destroyed = false;
  let visible = false;
  const show = vi.fn(() => {
    visible = true;
  });
  const showInactive = vi.fn(() => {
    visible = true;
  });
  return {
    show,
    showInactive,
    isDestroyed: vi.fn(() => destroyed),
    isVisible: vi.fn(() => visible),
    on: vi.fn(() => {}) as BrowserWindowLike['on'],
    once: vi.fn((event: 'ready-to-show', cb: () => void) => {
      if (event === 'ready-to-show') readyToShowCb = cb;
    }) as BrowserWindowLike['once'],
    focus: vi.fn(() => {}),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(() => {}),
    webContents: {
      send: vi.fn(() => {}),
      once: vi.fn(() => {}),
      setWindowOpenHandler: vi.fn(() => {}),
      on: vi.fn(() => {}) as BrowserWindowLike['webContents']['on'],
    },
    loadFile: vi.fn(() => Promise.resolve()),
    loadURL: vi.fn(() => Promise.resolve()),
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

function buildEnv(opts?: { timeoutMs?: number; shouldRevealInactive?: () => boolean }): TestEnv {
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
    shouldRevealInactive: opts?.shouldRevealInactive,
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

  test('onShown fires once with the window kind after a successful show', () => {
    const onShown = vi.fn((_kind: 'editor' | 'navigator') => {});
    const registry = createShowGateRegistry({
      log: { warn: () => {} },
      setTimeout: (cb, ms) => ({ cb, ms }),
      clearTimeout: () => {},
      onShown,
    });
    const win = makeWindow();
    registry.register(win, { kind: 'editor' });
    win.fireReadyToShow();
    expect(onShown).not.toHaveBeenCalled();
    registry.fireThemeApplied(win);
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(onShown).toHaveBeenCalledTimes(1);
    expect(onShown).toHaveBeenCalledWith('editor');
  });

  test('a throwing onShown is isolated and does not break show', () => {
    const registry = createShowGateRegistry({
      log: { warn: () => {} },
      setTimeout: (cb, ms) => ({ cb, ms }),
      clearTimeout: () => {},
      onShown: () => {
        throw new Error('boom');
      },
    });
    const win = makeWindow();
    registry.register(win, { kind: 'editor' });
    win.fireReadyToShow();
    expect(() => registry.fireThemeApplied(win)).not.toThrow();
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
    // Without clearTimeout, the timer's closure pins the BrowserWindowLike
    // reference for up to 5 s after the window closes. The fireTimeout
    // callback short-circuits via `states.get(window) === undefined`, so the
    // timer is functionally inert — but pinning closures across rapid
    // open/close cycles burns memory until each timer fires.
    const win = makeWindow();
    const dispose = env.registry.register(win);
    expect(env.timers).toHaveLength(1);
    expect(env.cleared).toHaveLength(0);
    dispose();
    expect(env.cleared).toHaveLength(1);
    expect(env.cleared[0]).toBe(env.timers[0]?.handle);
  });

  test('show after both signals also clears the safety timer', () => {
    // The happy path also frees the timer slot — once the window has been
    // shown, the safety timer is no longer needed and the closure can be
    // released immediately rather than waiting for the timer to fire and
    // no-op against a missing Map entry.
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
    // Mirror of the fireTimeout guard at the timeout path. If both signals
    // arrive after the window is destroyed (user closes during cold launch
    // — second signal arrives before the `closed` listener disposes the
    // gate state), maybeShow must not call show(). Electron's
    // destroyed-window show() throws; optional chaining only saves us when
    // `show` is undefined, not when it's a real method on a destroyed
    // window.
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
  // Mirrors `reduced-transparency-handler.ts`'s per-call try/catch. The
  // isDestroyed guard handles the common shutdown race; the catch isolates
  // residual cases — close events that fire between the guard and the
  // native call, or unexpected native errors surfaced through Electron's
  // binding. Without it, a throw from window.show() would either escape to
  // Node's unhandled-exception handler (fireTimeout path, runs from
  // setTimeout) or leave gate state corrupted (state.shown set before show
  // throws, Map entry never deleted, timer cleared but closure pinned).
  let env: TestEnv;

  beforeEach(() => {
    env = buildEnv();
  });

  function makeThrowingWindow(): MockWindow {
    const win = makeWindow();
    win.show = vi.fn(() => {
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
    });
    expect((failure?.obj as { err?: Error }).err?.message).toBe('Object has been destroyed');
  });

  test('happy-path show throws → states Map entry is released (no leak)', () => {
    // Without the catch reordering, state.shown was set BEFORE show — when
    // show threw, state stayed in the Map with shown=true (a lie) and the
    // entry leaked. The fix runs states.delete() in both success and
    // failure branches, so a follow-up fireThemeApplied is a no-op via
    // states.get returning undefined.
    const win = makeThrowingWindow();
    env.registry.register(win);
    win.fireReadyToShow();
    env.registry.fireThemeApplied(win);
    // Re-firing must be a no-op — entry is gone, show is not invoked again.
    win.show = vi.fn(() => {});
    env.registry.fireThemeApplied(win);
    expect(win.show).not.toHaveBeenCalled();
  });

  test('timeout-path show throws → catch logs warn + does not escape setTimeout', () => {
    // fireTimeout runs from a setTimeout callback. A throw there escapes to
    // Node's unhandled-exception handler with no diagnostic trail. Wrap +
    // structured warn keeps the failure observable.
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
    });
    expect((failure?.obj as { err?: Error }).err?.message).toBe('Object has been destroyed');
    // The timeout warn (`show-gate-timeout`) still fires — the failure warn
    // is additive, not a replacement.
    const timeout = env.warns.find(
      (w) => (w.obj as { event?: unknown }).event === 'show-gate-timeout',
    );
    expect(timeout).toBeDefined();
  });
});

describe('createShowGateRegistry — inactive reveal', () => {
  /** Drive a registered window through both gate signals so it reveals. */
  function reveal(registry: ShowGateRegistry, win: MockWindow): void {
    registry.register(win, { kind: 'editor' });
    win.fireReadyToShow();
    registry.fireThemeApplied(win);
  }

  test('predicate false → reveals with a focusing show()', () => {
    const env = buildEnv({ shouldRevealInactive: () => false });
    const win = makeWindow();
    reveal(env.registry, win);
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.showInactive).not.toHaveBeenCalled();
  });

  test('predicate omitted → reveals with a focusing show()', () => {
    const env = buildEnv();
    const win = makeWindow();
    reveal(env.registry, win);
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.showInactive).not.toHaveBeenCalled();
  });

  test('predicate true → reveals via showInactive(), never show()', () => {
    const env = buildEnv({ shouldRevealInactive: () => true });
    const win = makeWindow();
    reveal(env.registry, win);
    expect(win.showInactive).toHaveBeenCalledTimes(1);
    expect(win.show).not.toHaveBeenCalled();
    expect(win.isVisible?.()).toBe(true);
  });

  test('predicate is read at reveal time, not at registration time', () => {
    // Registration happens before `loadURL`; the reveal lands seconds later. A
    // restore that finishes between the two must not leave a later window
    // revealing under the stale answer.
    let inactive = true;
    const env = buildEnv({ shouldRevealInactive: () => inactive });
    const early = makeWindow();
    const late = makeWindow();
    env.registry.register(early, { kind: 'editor' });
    env.registry.register(late, { kind: 'editor' });

    early.fireReadyToShow();
    env.registry.fireThemeApplied(early);
    expect(early.showInactive).toHaveBeenCalledTimes(1);

    inactive = false;
    late.fireReadyToShow();
    env.registry.fireThemeApplied(late);
    expect(late.show).toHaveBeenCalledTimes(1);
    expect(late.showInactive).not.toHaveBeenCalled();
  });

  test('the timeout fallback honors the predicate too', () => {
    // A window whose second signal never arrives is force-shown by the safety
    // timeout. That path must not become a foreground steal either.
    const env = buildEnv({ shouldRevealInactive: () => true });
    const win = makeWindow();
    env.registry.register(win, { kind: 'editor' });
    win.fireReadyToShow();
    env.timers[0]?.cb();
    expect(win.showInactive).toHaveBeenCalledTimes(1);
    expect(win.show).not.toHaveBeenCalled();
  });

  test('a throwing predicate degrades to show() and warns rather than stranding the window', () => {
    // No window at all is strictly worse than a window with the wrong focus
    // posture, so the predicate must never be able to block a reveal.
    const env = buildEnv({
      shouldRevealInactive: () => {
        throw new Error('predicate exploded');
      },
    });
    const win = makeWindow();
    env.registry.register(win, { kind: 'navigator' });
    win.fireReadyToShow();
    env.registry.fireThemeApplied(win);
    expect(win.show).toHaveBeenCalledTimes(1);
    const warn = env.warns.find(
      (w) => (w.obj as { event?: unknown }).event === 'show-gate-reveal-predicate-failed',
    );
    // Carries the same windowKind its sibling warns do — a navigator, editor,
    // or terminal revealing with the wrong posture are different user impacts.
    expect(warn?.obj).toMatchObject({ windowKind: 'navigator' });
  });

  test('a window without showInactive still reveals when the predicate is true', () => {
    const env = buildEnv({ shouldRevealInactive: () => true });
    const win = makeWindow();
    // Model a window-like that predates the inactive-reveal capability.
    (win as { showInactive?: unknown }).showInactive = undefined;
    reveal(env.registry, win);
    expect(win.show).toHaveBeenCalledTimes(1);
  });
});
