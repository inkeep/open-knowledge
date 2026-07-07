export interface BootRestoreInput {
  pendingRestore: string[] | null;
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
   * update-relaunch restore (which must never be dropped) and above
   * `lastOpenedProject` / Navigator.
   */
  urlLaunch: boolean;
}

export type BootRestoreDecision =
  | { clearSnapshot: boolean; action: 'restore'; projects: string[] }
  | { clearSnapshot: boolean; action: 'lastOpened'; project: string }
  | { clearSnapshot: boolean; action: 'navigator' }
  | { clearSnapshot: boolean; action: 'none' };

// Pure boot-restore decision. A non-null `pendingRestore` means an update
// relaunch happened, so the snapshot is always consumed (`clearSnapshot`) even
// when Option suppresses the actual restore. A non-null-but-empty/all-missing
// snapshot opens the Navigator and deliberately does NOT fall through to
// `lastOpenedProject` — the relaunch is honored as "nothing was open" rather
// than reopening a stale project. A null snapshot is the normal cold-boot path
// that restores `lastOpenedProject`. When a single-file deep-link claims the
// launch (`urlLaunch`), open no default window — the URL flush owns it.
export function bootRestoreDecision(input: BootRestoreInput): BootRestoreDecision {
  const { pendingRestore, lastOpenedProject, optionHeld, pathExists, urlLaunch } = input;
  const clearSnapshot = pendingRestore !== null;
  const restorable =
    pendingRestore !== null && !optionHeld ? pendingRestore.filter(pathExists) : [];

  if (restorable.length > 0) {
    return { clearSnapshot, action: 'restore', projects: restorable };
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
