export interface HostLivenessScheduler {
  setInterval: (cb: () => void, ms: number) => ReturnType<typeof globalThis.setInterval>;
  clearInterval: (handle: ReturnType<typeof globalThis.setInterval>) => void;
}

export interface HostLivenessWatchOptions {
  getPpid: () => number;
  onHostGone: (reason: string) => void;
  intervalMs?: number;
  scheduler?: HostLivenessScheduler;
}

export interface HostLivenessWatchHandle {
  stop: () => void;
}

const DEFAULT_INTERVAL_MS = 1000;

export function startHostLivenessWatch(opts: HostLivenessWatchOptions): HostLivenessWatchHandle {
  const scheduler: HostLivenessScheduler = opts.scheduler ?? {
    setInterval: (cb, ms) => globalThis.setInterval(cb, ms),
    clearInterval: (handle) => globalThis.clearInterval(handle),
  };
  const bootPpid = opts.getPpid();

  if (bootPpid <= 1) return { stop: () => {} };

  let fired = false;
  const timer = scheduler.setInterval(() => {
    if (fired) return;
    const current = opts.getPpid();
    if (current !== bootPpid) {
      fired = true;
      scheduler.clearInterval(timer);
      opts.onHostGone(`host process exited (ppid ${bootPpid} -> ${current})`);
    }
  }, opts.intervalMs ?? DEFAULT_INTERVAL_MS);

  (timer as { unref?: () => void }).unref?.();

  return { stop: () => scheduler.clearInterval(timer) };
}
