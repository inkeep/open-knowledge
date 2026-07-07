/**
 * Window-show dual-signal gate.
 *
 * Coordinates `BrowserWindow.show()` so a window doesn't appear until BOTH:
 *   (a) `ready-to-show` — Chromium has composited the renderer's first frame,
 *   (b) `ok:theme:applied` — the renderer's ConfigProvider settled and pushed
 *       the user's `themeSource` to main, so chrome (vibrancy + native menus
 *       + native dialogs + traffic lights) is in the user-intended theme.
 *
 * Eliminates the cold-launch staleness window. Without the second signal,
 * the editor + Navigator would appear on `ready-to-show` alone, painting a
 * frame whose chrome could still reflect the prior `nativeTheme.themeSource`
 * until the renderer's setThemeSource IPC roundtripped through main. Under
 * `transparent: true` + vibrancy, that frame would visibly flash the wrong
 * material.
 *
 * A 5 s safety timeout shows the window even if either signal stalls — the
 * user-visible failure mode of "no window at all" is strictly worse than
 * "window appears with chrome that catches up a frame later". Structured
 * `console.warn` surfaces which signal stalled so future debugging has a
 * trail.
 *
 * Not coupled to Electron — `BrowserWindowLike` is a structural subset.
 * Tests inject mock windows + a captured-timer setTimeout; production wires
 * the real Electron BrowserWindow + global setTimeout via index.ts.
 */

import type { BrowserWindowLike } from './window-manager.ts';

interface ShowGateLogger {
  warn(obj: object, msg: string): void;
}

interface ShowGateRegistryDeps {
  log?: ShowGateLogger;
  /**
   * Schedule the safety timeout. Production wires `(cb, ms) => setTimeout(cb, ms)`;
   * tests inject a captured-timer mock so they can fire timeouts deterministically.
   */
  setTimeout: (cb: () => void, ms: number) => unknown;
  /**
   * Cancel a scheduled safety timeout. Production wires
   * `(handle) => clearTimeout(handle)`; tests track cleared handles to assert
   * the registry releases them on dispose / show. Optional for back-compat
   * with older test envs — when omitted, the timer fires and no-ops via the
   * states-Map miss check, but its closure stays pinned until then.
   */
  clearTimeout?: (handle: unknown) => void;
  /**
   * Window-show gate timeout. Default 5_000ms — long enough to allow
   * first-paint + first CRDT sync; short enough that a hung renderer
   * surfaces in dev. Tests inject a smaller value.
   */
  timeoutMs?: number;
  /**
   * Invoked once per window the instant it is successfully shown (after
   * `state.shown` flips). Used by the startup-instrumentation waterfall to mark
   * the `windowShown` phase. Kept electron-free: receives only the window kind,
   * never the window. Optional; omitted in tests that don't assert show timing.
   */
  onShown?: (kind: WindowKind) => void;
}

export interface ShowGateRegistry {
  /**
   * Wire a window into the dual-signal show gate. Listens once for
   * `ready-to-show` on the window; arms a safety timeout. The IPC handler
   * fires the second signal via {@link ShowGateRegistry.fireThemeApplied}.
   *
   * Returns a `dispose()` the caller MUST invoke on window 'closed' so a
   * window destroyed before either signal arrives doesn't hold stale state.
   *
   * @param window - The window to register.
   * @param opts.kind - Kind of window for diagnostic warns. 'editor', 'navigator', or 'terminal'.
   */
  register(window: BrowserWindowLike, opts?: { kind?: WindowKind }): () => void;
  /**
   * Signal `ok:theme:applied` for a window. Fired by the IPC handler that
   * resolves `event.sender` → BrowserWindow. No-op if the window isn't
   * registered (already shown / disposed) — the IPC handler doesn't need to
   * know which windows are currently gated.
   */
  fireThemeApplied(window: BrowserWindowLike): void;
}

type WindowKind = 'editor' | 'navigator' | 'terminal';

interface PerWindowGateState {
  readyToShow: boolean;
  themeApplied: boolean;
  shown: boolean;
  kind: WindowKind;
  /**
   * Handle returned by `deps.setTimeout`. Captured so the registry can
   * cancel the timer on dispose() / happy-path show() instead of leaving
   * the closure pinned for up to `timeoutMs` after the gate has resolved.
   */
  timerHandle: unknown;
}

export function createShowGateRegistry(deps: ShowGateRegistryDeps): ShowGateRegistry {
  const states = new Map<BrowserWindowLike, PerWindowGateState>();
  const timeoutMs = deps.timeoutMs ?? 5_000;

  function clearTimer(state: PerWindowGateState): void {
    if (state.timerHandle === undefined) return;
    deps.clearTimeout?.(state.timerHandle);
    state.timerHandle = undefined;
  }

  function safeShow(window: BrowserWindowLike, state: PerWindowGateState): void {
    // Mirror of `reduced-transparency-handler.ts`'s per-call try/catch. The
    // isDestroyed/isVisible guards above handle the common shutdown race;
    // the catch isolates residual cases — close events that fire between
    // the guard and the native call, or unexpected native errors surfaced
    // through Electron's binding. State.shown flips AFTER successful show
    // so a throw doesn't leave the gate in a state that lies about visibility.
    // states.delete() runs in both branches so the Map entry never leaks.
    try {
      window.show?.();
      state.shown = true;
      // Startup waterfall: the window is now visible. Fire AFTER `state.shown`
      // flips so a throw from `show()` doesn't emit a false windowShown mark.
      // Its own try/catch isolates a misbehaving callback from the show path.
      try {
        deps.onShown?.(state.kind);
      } catch (cbErr) {
        deps.log?.warn(
          {
            event: 'show-gate-on-shown-failed',
            windowKind: state.kind,
            error: cbErr instanceof Error ? cbErr.message : String(cbErr),
          },
          'show-gate onShown callback threw',
        );
      }
    } catch (err) {
      deps.log?.warn(
        {
          event: 'show-gate-show-failed',
          windowKind: state.kind,
          error: err instanceof Error ? err.message : String(err),
        },
        'window.show() threw past the destroyed-window guard',
      );
    }
  }

  function maybeShow(window: BrowserWindowLike, state: PerWindowGateState): void {
    if (state.shown) return;
    if (!(state.readyToShow && state.themeApplied)) return;
    // Mirror of the fireTimeout guard. If the window destroyed (or was
    // forced visible by another path) between the second signal arriving
    // and this handler running, calling show() would either throw on a
    // destroyed BrowserWindow or double-show an already-visible one.
    if (window.isDestroyed?.() === true || window.isVisible?.() === true) {
      clearTimer(state);
      states.delete(window);
      return;
    }
    clearTimer(state);
    safeShow(window, state);
    states.delete(window);
  }

  function fireTimeout(window: BrowserWindowLike, state: PerWindowGateState): void {
    state.timerHandle = undefined;
    if (state.shown) {
      states.delete(window);
      return;
    }
    if (window.isDestroyed?.() === true || window.isVisible?.() === true) {
      states.delete(window);
      return;
    }
    const missing: 'both' | 'ready-to-show' | 'theme-applied' =
      !state.readyToShow && !state.themeApplied
        ? 'both'
        : !state.readyToShow
          ? 'ready-to-show'
          : 'theme-applied';
    deps.log?.warn(
      { event: 'show-gate-timeout', missing, windowKind: state.kind },
      'show gate timed out before both signals arrived — falling back',
    );
    safeShow(window, state);
    states.delete(window);
  }

  return {
    register(window, opts) {
      const kind = opts?.kind ?? 'editor';
      const state: PerWindowGateState = {
        readyToShow: false,
        themeApplied: false,
        shown: false,
        kind,
        timerHandle: undefined,
      };
      states.set(window, state);
      window.once('ready-to-show', () => {
        const s = states.get(window);
        if (!s) return;
        s.readyToShow = true;
        maybeShow(window, s);
      });
      state.timerHandle = deps.setTimeout(() => {
        const s = states.get(window);
        if (!s) return;
        fireTimeout(window, s);
      }, timeoutMs);
      return () => {
        clearTimer(state);
        states.delete(window);
      };
    },
    fireThemeApplied(window) {
      const s = states.get(window);
      if (!s) return;
      s.themeApplied = true;
      maybeShow(window, s);
    },
  };
}

export type { BrowserWindowLike };
