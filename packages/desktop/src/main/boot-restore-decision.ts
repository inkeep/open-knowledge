import { type RestoredWindow, restoreSurvivorPath, windowRestoreKey } from './state-store.ts';

export interface BootRestoreInput {
  pendingRestore: RestoredWindow[] | null;
  lastOpenedProject: string | null;
  optionHeld: boolean;
  pathExists: (p: string) => boolean;
  /**
   * `true` when a launch-claiming URL that opens its own window has been seen
   * this run: a single-file deep-link (`ok <file>` → `openknowledge://open?file=`)
   * or a valid share. The URL flush owns the initial window, so the boot path
   * opens NO default window. Restoring the previous project / Navigator alongside
   * the URL-driven window both clutters the launch and races it for focus (two
   * overlapping windows, one of them the splash). Ranked ABOVE the clean-exit
   * window-restore snapshot: an explicit file or share open is a deliberate "view
   * just this" intent, so the prior session's windows stay closed. The snapshot
   * is still consumed (`clearSnapshot`) so it cannot resurface on the next boot.
   */
  urlLaunch: boolean;
}

export type BootRestoreDecision =
  | { clearSnapshot: boolean; action: 'restore'; windows: RestoredWindow[] }
  | { clearSnapshot: boolean; action: 'lastOpened'; project: string }
  | { clearSnapshot: boolean; action: 'navigator' }
  | { clearSnapshot: boolean; action: 'none' };

// Pure boot-restore decision. Priority order: a launch-claiming URL first, then
// a surviving clean-exit snapshot, then `lastOpenedProject`, then Navigator.
//
// When a launch-claiming URL owns the window (`urlLaunch`, a single-file
// deep-link or a valid share), open no default window: the URL flush owns the
// initial window set, so restoring the previous project / Navigator on top would
// only clutter and race it. A non-null `pendingRestore` means the previous run
// exited cleanly and snapshotted its window set. Every clean exit writes one
// (normal quit, "Relaunch now" update, and install-on-quit alike), not just
// update relaunches. It is always consumed (`clearSnapshot`) even when Option or
// a URL launch suppresses the actual restore. A non-null-but-empty/all-missing
// snapshot opens the Navigator and deliberately does NOT fall through to
// `lastOpenedProject`: the relaunch is honored as "nothing was open" rather than
// reopening a stale project. A null snapshot is the cold-boot path that restores
// `lastOpenedProject`.
export function bootRestoreDecision(input: BootRestoreInput): BootRestoreDecision {
  const { pendingRestore, lastOpenedProject, optionHeld, pathExists, urlLaunch } = input;
  const clearSnapshot = pendingRestore !== null;

  if (urlLaunch) {
    return { clearSnapshot, action: 'none' };
  }

  // Filter each entry by whether its target still exists on disk — a project
  // folder or loose file deleted/moved since the snapshot is silently skipped
  // (`windowRestoreKey` is the project path or the canonical file path). The
  // file→project re-derivation + duplicate collapse happens in
  // `resolveRestoreActions` (called at open time from `index.ts`); the pure
  // decision only survivor-filters.
  const restorable =
    pendingRestore !== null && !optionHeld
      ? pendingRestore.filter((w) => pathExists(restoreSurvivorPath(w)))
      : [];

  if (restorable.length > 0) {
    return { clearSnapshot, action: 'restore', windows: restorable };
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

  // A pop-out attaches to its project's server, so it can only restore if that
  // project restores too. An orphan is dropped SILENTLY: the user removed the
  // project or its window did not survive, and an error window for a document
  // they did not ask to reopen would be worse than its absence.
  //
  // Surviving pop-outs then sort after every project window. The open loop is
  // sequential, so this is what makes "project first" true rather than
  // incidental — a pop-out opened before its project would have no server to
  // attach to. Within each group the focus order above is preserved, so the
  // final key is still the raise target.
  const restoredProjects = new Set(
    [...actionByKey.values()]
      .filter(
        (action): action is Extract<RestoredWindow, { kind: 'project' }> =>
          action.kind === 'project',
      )
      .map((action) => action.projectPath),
  );
  const projectKeys: string[] = [];
  const docKeys: string[] = [];
  for (const key of orderedKeys) {
    const action = actionByKey.get(key);
    if (action?.kind !== 'doc') {
      projectKeys.push(key);
      continue;
    }
    if (restoredProjects.has(action.projectPath)) docKeys.push(key);
    else actionByKey.delete(key);
  }
  return { orderedKeys: [...projectKeys, ...docKeys], actionByKey };
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
 * share was delivered, leaving a cold-start share buried by whichever default
 * it should have outranked: the clean-exit window-restore snapshot (the common
 * case, since every clean quit writes one) or `lastOpenedProject`. The producer
 * (OS event delivery) cannot be ordered from here, so the barrier lives on this
 * consumer boundary.
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
