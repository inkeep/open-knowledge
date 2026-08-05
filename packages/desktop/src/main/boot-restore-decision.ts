import { type RestoredWindow, windowRestoreKey } from './state-store.ts';

export interface BootRestoreInput {
  pendingRestore: RestoredWindow[] | null;
  lastOpenedProject: string | null;
  optionHeld: boolean;
  pathExists: (p: string) => boolean;
  /**
   * `true` when a launch-claiming URL that opens its own window has been seen
   * this run — a single-file deep-link (`ok <file>` → `openknowledge://open?file=`)
   * OR a valid share. The URL flush owns the initial window, so the boot path
   * opens NO default window — restoring the previous project / Navigator
   * alongside the URL-driven window both clutters the launch and races it for
   * focus (the reported "two windows, one is the splash"). Ranked below the
   * clean-exit window-restore snapshot (which must never be dropped) and above
   * `lastOpenedProject` / Navigator.
   */
  urlLaunch: boolean;
}

export type BootRestoreDecision =
  | { clearSnapshot: boolean; action: 'restore'; windows: RestoredWindow[] }
  | { clearSnapshot: boolean; action: 'lastOpened'; project: string }
  | { clearSnapshot: boolean; action: 'navigator' }
  | { clearSnapshot: boolean; action: 'none' };

// Pure boot-restore decision. A non-null `pendingRestore` means the previous
// run exited cleanly and snapshotted its window set — every clean exit writes
// one (normal quit, "Relaunch now" update, and install-on-quit alike), not just
// update relaunches. It is always consumed (`clearSnapshot`) even when Option
// suppresses the actual restore. A non-null-but-empty/all-missing snapshot
// opens the Navigator and deliberately does NOT fall through to
// `lastOpenedProject` — the relaunch is honored as "nothing was open" rather
// than reopening a stale project. A null snapshot is the cold-boot path that
// restores `lastOpenedProject`. When a single-file deep-link claims the
// launch (`urlLaunch`), open no default window — the URL flush owns it.
export function bootRestoreDecision(input: BootRestoreInput): BootRestoreDecision {
  const { pendingRestore, lastOpenedProject, optionHeld, pathExists, urlLaunch } = input;
  const clearSnapshot = pendingRestore !== null;
  // Filter each entry by whether its target still exists on disk — a project
  // folder or loose file deleted/moved since the snapshot is silently skipped
  // (`windowRestoreKey` is the project path or the canonical file path). The
  // file→project re-derivation + duplicate collapse happens in
  // `resolveRestoreActions` (called at open time from `index.ts`); the pure
  // decision only survivor-filters.
  const restorable =
    pendingRestore !== null && !optionHeld
      ? pendingRestore.filter((w) => pathExists(windowRestoreKey(w)))
      : [];

  if (restorable.length > 0) {
    return { clearSnapshot, action: 'restore', windows: restorable };
  }
  if (urlLaunch) {
    return { clearSnapshot, action: 'none' };
  }
  if (
    pendingRestore === null &&
    lastOpenedProject !== null &&
    !optionHeld &&
    pathExists(lastOpenedProject)
  ) {
    return { clearSnapshot, action: 'lastOpened', project: lastOpenedProject };
  }
  return { clearSnapshot, action: 'navigator' };
}

/**
 * Resolve a restore snapshot into the ordered, de-duplicated set of windows to
 * open. Each `file` entry is re-derived via `resolveFileTarget` — matching
 * `openEphemeralFile`'s own logic, a loose file whose realpath now sits inside a
 * project collapses onto that project (a `project` action); a file that can't be
 * resolved (missing / non-markdown) returns null and is skipped. Entries that
 * collapse onto the same key de-dupe, with the LATER (more recently focused)
 * occurrence winning position, so `orderedKeys`'s last entry is the window to
 * raise after restore.
 *
 * Pure: the filesystem / project derivation is injected, so the collapse +
 * ordering — the load-bearing duplicate-window guard — is unit-testable without
 * Electron. `index.ts` passes a `resolveFileTarget` that wraps
 * `prepareSingleFileOpen`.
 */
export function resolveRestoreActions(
  windows: readonly RestoredWindow[],
  resolveFileTarget: (filePath: string) => RestoredWindow | null,
): { orderedKeys: string[]; actionByKey: Map<string, RestoredWindow> } {
  const orderedKeys: string[] = [];
  const actionByKey = new Map<string, RestoredWindow>();
  for (const w of windows) {
    let action: RestoredWindow;
    if (w.kind === 'file') {
      const resolved = resolveFileTarget(w.filePath);
      if (resolved === null) continue;
      action = resolved;
    } else {
      action = w;
    }
    const key = windowRestoreKey(action);
    // Later (more-recent) duplicate wins position: move the key to the end so
    // the raise target stays the most-recently-focused window.
    const existingIdx = orderedKeys.indexOf(key);
    if (existingIdx !== -1) orderedKeys.splice(existingIdx, 1);
    orderedKeys.push(key);
    actionByKey.set(key, action);
  }
  return { orderedKeys, actionByKey };
}

/**
 * Coordinator input for the async boot-restore seam. Mirrors `BootRestoreInput`
 * but replaces the eager `urlLaunch: boolean` with a settle-then-read pair:
 * `waitForUrlLaunchSettled` is awaited BEFORE `urlLaunchOwnsWindow` is read, so
 * the launch flag reflects cold-start URL delivery rather than a stale snapshot.
 */
export interface SettledBootRestoreInput extends Omit<BootRestoreInput, 'urlLaunch'> {
  /** Read AFTER `waitForUrlLaunchSettled` resolves, never before. */
  urlLaunchOwnsWindow: () => boolean;
  /**
   * Resolves once cold-start URL delivery has settled — a launch-claiming URL
   * flipped the flag, or a bounded grace window elapsed. On macOS the `open-url`
   * Apple Event is delivered asynchronously and can land after the boot path's
   * synchronous read; awaiting this orders the flag read after that delivery.
   */
  waitForUrlLaunchSettled: () => Promise<void>;
}

/**
 * Async coordinator for the boot-restore decision. Withholds the decision until
 * cold-start URL delivery has settled, then reads the launch flag and delegates
 * to the pure `bootRestoreDecision`. This closes the ordering race where the
 * boot path read `urlLaunchOwnsWindow` before the macOS Apple Event carrying a
 * share was delivered — leaving a cold-start share buried by the
 * `lastOpenedProject` restore. The producer (OS event delivery) cannot be
 * ordered from here, so the barrier lives on this consumer boundary.
 */
export async function resolveBootRestoreDecision(
  input: SettledBootRestoreInput,
): Promise<BootRestoreDecision> {
  await input.waitForUrlLaunchSettled();
  return bootRestoreDecision({
    pendingRestore: input.pendingRestore,
    lastOpenedProject: input.lastOpenedProject,
    optionHeld: input.optionHeld,
    pathExists: input.pathExists,
    urlLaunch: input.urlLaunchOwnsWindow(),
  });
}
