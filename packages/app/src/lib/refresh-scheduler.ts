interface RefreshScheduler {
  request: () => void;
  dispose: () => void;
}

/**
 * Coalesces refresh requests so at most one `refresh()` runs at a time; a
 * request that arrives mid-run is collapsed into a single trailing re-run.
 *
 * `cancel` (optional) adds cancellation on top of coalescing: it fires when a
 * request supersedes an in-flight run, and on `dispose()`. Wire it to abort the
 * in-flight fetch so a superseded or torn-down refresh stops its server-side
 * work instead of running to completion. Coalescing is unchanged when `cancel`
 * is omitted.
 */
export function createRefreshScheduler(
  refresh: () => Promise<void> | void,
  cancel?: () => void,
): RefreshScheduler {
  let inFlight = false;
  let pending = false;
  let disposed = false;

  async function run(): Promise<void> {
    if (disposed) return;
    inFlight = true;
    try {
      await refresh();
    } finally {
      inFlight = false;
      if (disposed) {
        pending = false;
      } else if (pending) {
        pending = false;
        void run();
      }
    }
  }

  return {
    request() {
      if (disposed) return;
      if (inFlight) {
        pending = true;
        // Supersede the in-flight run: abort its fetch so the trailing re-run
        // works from fresh data instead of waiting out a stale walk.
        cancel?.();
        return;
      }
      void run();
    },
    dispose() {
      disposed = true;
      pending = false;
      // Abort any in-flight fetch on teardown (unmount / effect re-run).
      cancel?.();
    },
  };
}
