/**
 * Post-restore focus coordination for the update-relaunch window snapshot.
 *
 * A multi-window update-relaunch restores every project that was open, opening
 * each in its own window. The OS-level `BrowserWindow.show()` for each window is
 * deferred behind its own dual-signal show gate (see `show-gate.ts`), which
 * releases in nondeterministic order. `show()` steals key-window focus on macOS,
 * so whichever window's gate releases LAST would end up frontmost — not the
 * window the user was working in.
 *
 * The restore snapshot is ordered least → most recently focused (see
 * `sortByFocusSequence`), so its last entry is the window to land in. Raising
 * that window right after the open promises settle is not enough: those promises
 * resolve after `loadURL`, well before the deferred `show()` calls, so a sibling
 * window that shows later steals focus back. This module waits until EVERY
 * restored window has revealed, then raises the target so its `show()`/`focus()`
 * is the last one to win. Waiting for all reveals also guarantees the target is
 * already shown before the raise, so `bringToFront` never bypasses its own gate.
 *
 * Electron-free by construction: `RevealableWindow` is a structural subset and
 * timers are injected, so tests exercise the ordering without a real
 * BrowserWindow.
 */

/** Structural subset of BrowserWindow used to observe reveal state. */
export interface RevealableWindow {
  isDestroyed?(): boolean;
  isVisible?(): boolean;
  /** Fires when the window is shown (Electron emits `show` on `show()`). */
  once(event: 'show', listener: () => void): void;
}

export interface RestoreFocusDeps {
  /** Production wires `(cb, ms) => setTimeout(cb, ms)`; tests inject a captured-timer mock. */
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /**
   * Safety bound so a window whose `show()` never emits `show` (a pathological
   * native failure) can't stall the raise forever. Must comfortably exceed the
   * show gate's own timeout, since a genuinely gated window emits `show` when
   * that gate force-shows it.
   */
  timeoutMs: number;
}

/**
 * Comfortably above the show gate's 5 s force-show timeout: a window still
 * waiting on its dual-signal gate emits `show` when that gate fires, so this
 * only backstops a `show()` that throws or never dispatches `show`.
 */
export const RESTORE_REVEAL_TIMEOUT_MS = 8_000;

/**
 * Resolve once a window has revealed — it is already visible, it was destroyed
 * (closed mid-restore), it fires `show`, or the safety timeout elapses.
 */
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

/**
 * After a multi-window restore, wait for every restored window to reveal, then
 * raise the most-recently-focused one (the snapshot's last entry) so it wins the
 * final `show()`. Windows that failed to open (fell back to the Navigator) or
 * were destroyed mid-restore are skipped; if the target itself is gone, nothing
 * is raised.
 *
 * @param projects Restored project paths, ordered least → most recently focused.
 */
export async function raiseMostRecentlyFocusedAfterRestore(input: {
  projects: readonly string[];
  getWindow: (projectPath: string) => RevealableWindow | undefined;
  raise: (projectPath: string) => void;
  deps: RestoreFocusDeps;
}): Promise<void> {
  const { projects, getWindow, raise, deps } = input;
  const target = projects[projects.length - 1];
  if (target === undefined) return;

  await Promise.all(
    projects.map((projectPath) => {
      const win = getWindow(projectPath);
      if (!win || win.isDestroyed?.() === true) return Promise.resolve();
      return whenWindowRevealed(win, deps);
    }),
  );

  const targetWin = getWindow(target);
  if (!targetWin || targetWin.isDestroyed?.() === true) return;
  raise(target);
}
