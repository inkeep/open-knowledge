export function shouldRevealInactiveNow(state: {
  restoreInProgress: boolean;
  appHasEverBeenActive: boolean;
  appIsActive: boolean;
}): boolean {
  return state.restoreInProgress && state.appHasEverBeenActive && !state.appIsActive;
}

export interface RevealableWindow {
  isDestroyed?(): boolean;
  isVisible?(): boolean;
  once(event: 'show', listener: () => void): void;
}

export interface RestoreFocusDeps {
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  timeoutMs: number;
}

export const RESTORE_REVEAL_TIMEOUT_MS = 8_000;

export function whenWindowRevealed(win: RevealableWindow, deps: RestoreFocusDeps): Promise<void> {
  return new Promise<void>((resolve) => {
    if (win.isDestroyed?.() === true || win.isVisible?.() === true) {
      resolve();
      return;
    }
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (handle !== undefined) deps.clearTimeout(handle);
      resolve();
    };
    const handle = deps.setTimeout(finish, deps.timeoutMs);
    win.once('show', finish);
  });
}

export async function raiseMostRecentlyFocusedAfterRestore(input: {
  windowKeys: readonly string[];
  getWindow: (key: string) => RevealableWindow | undefined;
  raise: (key: string, opts: { activate: boolean }) => void;
  shouldActivate?: () => boolean;
  deps: RestoreFocusDeps;
}): Promise<void> {
  const { windowKeys, getWindow, raise, shouldActivate, deps } = input;
  const target = windowKeys[windowKeys.length - 1];
  if (target === undefined) return;

  await Promise.all(
    windowKeys.map((key) => {
      const win = getWindow(key);
      if (!win || win.isDestroyed?.() === true) return Promise.resolve();
      return whenWindowRevealed(win, deps);
    }),
  );

  const targetWin = getWindow(target);
  if (!targetWin || targetWin.isDestroyed?.() === true) return;
  raise(target, { activate: shouldActivate === undefined || shouldActivate() });
}
