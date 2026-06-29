
import type { BrowserWindowLike } from './window-manager.ts';

interface ShowGateLogger {
  warn(obj: object, msg: string): void;
}

interface ShowGateRegistryDeps {
  log?: ShowGateLogger;
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  timeoutMs?: number;
}

export interface ShowGateRegistry {
  register(window: BrowserWindowLike, opts?: { kind?: WindowKind }): () => void;
  fireThemeApplied(window: BrowserWindowLike): void;
}

type WindowKind = 'editor' | 'navigator';

interface PerWindowGateState {
  readyToShow: boolean;
  themeApplied: boolean;
  shown: boolean;
  kind: WindowKind;
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
    try {
      window.show?.();
      state.shown = true;
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
