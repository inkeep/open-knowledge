/**
 * Host-liveness watch for the `ok mcp` stdio server.
 *
 * The keepalive WS (`@inkeep/open-knowledge-core/keepalive`) keeps the Node
 * event loop alive, which disables the passive "stdin EOF -> loop drains ->
 * exit" path the MCP server otherwise relies on for host-disconnect. Without
 * an active signal, an `ok mcp` whose launching host dies keeps running — it is
 * reparented to launchd (ppid 1) and holds its keepalive WS open, surfacing as
 * a permanent ghost agent-presence entry (the server's keepalive-close cleanup
 * never fires because the socket never closes).
 *
 * This watch polls the parent pid and fires `onHostGone` the moment it differs
 * from the boot-time parent — i.e. the original host exited and we were
 * reparented. `process.ppid` reflects reparenting on each read (verified on
 * Bun and Node), so polling is sufficient and portable; macOS has no
 * `PR_SET_PDEATHSIG` equivalent, so a death-signal approach is not available.
 *
 * A parent's pid only changes when that parent dies (the child is reparented),
 * so "ppid changed from boot" is an unambiguous "the host is gone" signal — it
 * cannot false-positive while the original parent is alive.
 */

/** Injectable scheduler so the watch is deterministically unit-testable. */
export interface HostLivenessScheduler {
  setInterval: (cb: () => void, ms: number) => ReturnType<typeof globalThis.setInterval>;
  clearInterval: (handle: ReturnType<typeof globalThis.setInterval>) => void;
}

export interface HostLivenessWatchOptions {
  /** Reads the current parent pid. Production passes `() => process.ppid`. */
  getPpid: () => number;
  /** Invoked once, when the boot-time parent is detected to have exited. */
  onHostGone: (reason: string) => void;
  /** Poll cadence. Default 1000ms — responsive without being chatty. */
  intervalMs?: number;
  scheduler?: HostLivenessScheduler;
}

export interface HostLivenessWatchHandle {
  /** Stop polling. Idempotent. */
  stop: () => void;
}

const DEFAULT_INTERVAL_MS = 1000;

export function startHostLivenessWatch(opts: HostLivenessWatchOptions): HostLivenessWatchHandle {
  const scheduler: HostLivenessScheduler = opts.scheduler ?? {
    setInterval: (cb, ms) => globalThis.setInterval(cb, ms),
    clearInterval: (handle) => globalThis.clearInterval(handle),
  };
  const bootPpid = opts.getPpid();

  // No meaningful parent to watch: we were either already orphaned or launched
  // directly by init/launchd, so there is no host whose death should reap us.
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

  // Must NOT keep the event loop alive solely for this watch: a server with no
  // keepalive WS open still needs the passive stdin-EOF drain to exit, which an
  // un-unref'd interval would prevent. When a keepalive is open it keeps the
  // loop alive on its own, so the poll still fires.
  (timer as { unref?: () => void }).unref?.();

  return { stop: () => scheduler.clearInterval(timer) };
}
