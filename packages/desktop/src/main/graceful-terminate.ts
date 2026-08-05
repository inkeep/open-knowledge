/**
 * SIGTERM → grace-poll → SIGKILL process teardown, extracted so the slides deck
 * reap can reuse the ladder the desktop already runs for its detached servers
 * (`window-manager.ts`'s `stopAllOwnedServers` / `terminateServerByPid`) rather
 * than force-killing outright. A hard SIGKILL denies a Vite-backed dev server
 * the chance to release its port and flush its on-disk cache; SIGTERM first,
 * escalating only if a bounded grace expires, gives it that chance.
 *
 * Pure over its injected `sendSignal` / `isAlive` / clock, so the escalation is
 * unit-testable on a virtual clock with no real subprocess and no wall-clock
 * wait. The grace + poll cadence default to the shared `@inkeep/open-knowledge-
 * core` lifecycle constants, so slides teardown stays calibrated in lockstep
 * with the server-teardown paths that own those numbers.
 */

import { DEFAULT_SIGTERM_GRACE_MS, DEFAULT_SIGTERM_POLL_MS } from '@inkeep/open-knowledge-core';

export interface GracefulTerminateDeps {
  /** Deliver `signal` to the target. Must be total (swallow "already gone"):
   *  the caller owns a possibly-dead process, so a send is best-effort. */
  sendSignal(signal: 'SIGTERM' | 'SIGKILL'): void;
  /** Whether the target is still running — polled during the grace window to
   *  decide whether escalation is needed. */
  isAlive(): boolean;
  /** Monotonic-enough clock for the deadline (real: `Date.now`). */
  now(): number;
  /** Sleep `ms` between liveness polls (real: `setTimeout`-backed). */
  sleep(ms: number): Promise<void>;
  /** Grace before escalating to SIGKILL. Defaults to the shared 10 s. */
  graceMs?: number;
  /** Liveness poll cadence within the grace. Defaults to the shared 200 ms. */
  pollMs?: number;
}

/**
 * SIGTERM the target, then poll its liveness every `pollMs` until it exits or
 * `graceMs` elapses; escalate to SIGKILL only if it is still alive at the
 * deadline. Returns `{ escalated: true }` iff SIGKILL was sent — i.e. the grace
 * expired with the process still running.
 *
 * A process that exits within the grace is never SIGKILLed. A process that has
 * already exited before the first poll is likewise only SIGTERM'd (a no-op the
 * `sendSignal` contract absorbs) and reported not-escalated.
 */
export async function gracefulTerminate(
  deps: GracefulTerminateDeps,
): Promise<{ escalated: boolean }> {
  const graceMs = deps.graceMs ?? DEFAULT_SIGTERM_GRACE_MS;
  const pollMs = deps.pollMs ?? DEFAULT_SIGTERM_POLL_MS;

  deps.sendSignal('SIGTERM');
  const deadline = deps.now() + graceMs;
  while (deps.now() < deadline) {
    if (!deps.isAlive()) return { escalated: false };
    await deps.sleep(pollMs);
  }
  deps.sendSignal('SIGKILL');
  return { escalated: true };
}
