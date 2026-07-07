/**
 * Wires the per-window PTY reap into a BrowserWindow's `'closed'` event so a
 * closed window never leaks its shell. The app-quit reap (`killAll`) is wired
 * inline in the `will-quit` handler alongside the other teardowns; this module
 * owns the per-window half because the eager-id-capture below is the one piece
 * with a real failure mode worth isolating and testing.
 *
 * Decoupled from `electron` so the wiring is unit-testable: it depends only on
 * the structural `ClosableWindow` (an `id` + a `'closed'` subscription) and the
 * `TerminalReaper` surface that `terminal-manager.ts` already satisfies.
 */

/** The reap surface the manager exposes; `TerminalManager` satisfies it structurally. */
export interface TerminalReaper {
  killForWindow(windowId: number): void;
  killAll(): void;
}

/** Minimal BrowserWindow shape the reap wiring reads — id + a close subscription. */
export interface ClosableWindow {
  readonly id: number;
  on(event: 'closed', cb: () => void): void;
}

/**
 * Reap a window's PTY host when the window closes. `id` is captured eagerly:
 * reading `BrowserWindow.id` inside the `'closed'` callback would touch an
 * already-destroyed native window and throw (cross-time mutation — the window
 * is gone by the time the event fires), so the closure must close over the id
 * snapshotted now, not defer the read.
 *
 * `onReap` lets the caller clear any other per-window state keyed by the same id
 * (e.g. the dock-visibility map) on the same eagerly-captured id, without this
 * module taking a dependency on that state.
 */
export function wireWindowTerminalReap(
  win: ClosableWindow,
  reaper: TerminalReaper,
  onReap?: (windowId: number) => void,
): void {
  const windowId = win.id;
  win.on('closed', () => {
    reaper.killForWindow(windowId);
    onReap?.(windowId);
  });
}
