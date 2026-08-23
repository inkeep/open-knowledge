/**
 * State + decisions for surfacing branch-driven content recycles. Without a
 * notice, a CC1 `branch-switched` (or an auth-refusal-driven replay) silently
 * recycles every provider, and a NON-converging refusal loop (server pinned to
 * a different branch than this window's claim) renders the whole app empty
 * with no explanation — read as "all my skills are gone".
 *
 * Kept pure (no React) so the escalation and visibility rules are unit-tested
 * without a DOM; `DocumentContext` owns the state, `BranchRecycleBanner`
 * renders it.
 */

export type ContentRecycleNotice =
  /** A branch switch went through — content is being re-synced. Transient. */
  | { kind: 'branch-switch'; branch: string; at: number }
  /**
   * The server refused this window's content sessions repeatedly (branch
   * mismatch that a server-info refresh did not resolve). Persistent until
   * dismissed or superseded by a successful switch.
   */
  | { kind: 'refused'; at: number };

/** How long the transient branch-switch notice stays up. */
export const BRANCH_SWITCH_NOTICE_MS = 6_000;

/** Dispatch window for calling a refusal loop "stuck" rather than one-off. */
export const REFUSAL_WINDOW_MS = 60_000;

/**
 * Record a branch-mismatch auth-refusal dispatch. A single dispatch is the
 * normal recovery path (refresh server info, recycle, reconnect) and stays
 * silent; a SECOND dispatch inside the window means that recovery did not
 * converge — the server is still refusing — and that must become visible.
 * Returns the pruned timestamp list and whether to escalate.
 */
export function recordBranchMismatchDispatch(
  priorTimes: readonly number[],
  now: number,
): { times: number[]; escalate: boolean } {
  const times = priorTimes.filter((t) => now - t < REFUSAL_WINDOW_MS);
  times.push(now);
  return { times, escalate: times.length >= 2 };
}

export type RecycleBannerMode = 'hidden' | 'switch' | 'refused';

/**
 * What the banner shows right now. `refused` never times out on its own.
 * Expiry arrives as a flag (the component's effect timer owns the clock) so
 * render stays pure — React Compiler rejects `Date.now()` during render.
 */
export function computeRecycleBannerMode(
  notice: ContentRecycleNotice | null | undefined,
  switchExpired: boolean,
): RecycleBannerMode {
  // == on purpose: test harnesses that mock the document context omit the
  // field entirely, and a missing notice must read as hidden, not crash.
  if (notice == null) return 'hidden';
  if (notice.kind === 'refused') return 'refused';
  return switchExpired ? 'hidden' : 'switch';
}
