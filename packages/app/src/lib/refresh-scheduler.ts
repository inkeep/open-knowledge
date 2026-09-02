interface RefreshScheduler {
  request: () => void;
  dispose: () => void;
}

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
        cancel?.();
        return;
      }
      void run();
    },
    dispose() {
      disposed = true;
      pending = false;
      cancel?.();
    },
  };
}
