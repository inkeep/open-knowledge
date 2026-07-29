/**
 * Reports a desktop window's aggregate unsynced-work state to the main process
 * so main can key the window's Chromium background-throttling to it.
 *
 * Installed only in the Electron host (the caller gates on `window.okDesktop`).
 * Dedupes to the true↔false edge: every keystroke bumps a provider's
 * `unsyncedChanges`, so a typing burst collapses to one report when work
 * begins and one when the doc finishes syncing.
 */
export interface BackgroundThrottleReporterDeps {
  /** The `bridge.backgroundThrottle.enabled` kill-switch, resolved renderer-side. */
  enabled: boolean;
  /** Current aggregate: does any open doc hold unsynced work. */
  hasAnyUnsyncedWork: () => boolean;
  /** Subscribe to unsynced-work edges; returns an unsubscribe. */
  addUnsyncedWorkListener: (cb: () => void) => () => void;
  /** Push the signal to main (the `okDesktop` bridge). */
  report: (signal: { hasPendingWork: boolean; enabled: boolean }) => void;
}

export function installBackgroundThrottleReporter(
  deps: BackgroundThrottleReporterDeps,
): () => void {
  let lastReported: boolean | null = null;
  const push = (): void => {
    const hasPendingWork = deps.hasAnyUnsyncedWork();
    if (hasPendingWork === lastReported) return;
    lastReported = hasPendingWork;
    deps.report({ hasPendingWork, enabled: deps.enabled });
  };
  // Seed main with the current state on install, then track edges.
  push();
  return deps.addUnsyncedWorkListener(push);
}
