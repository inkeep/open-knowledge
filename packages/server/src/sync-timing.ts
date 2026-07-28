/**
 * Pure timing helpers for SyncEngine restart recovery.
 *
 * Extracted so they can be unit-tested without importing simple-git
 * (which has a broken symlink in the server package's local node_modules).
 */

/**
 * Compute how many milliseconds remain before the next scheduled cycle.
 *
 * Formula: max(0, (lastUtc + intervalSeconds * 1000) - now)
 *
 * - If `lastUtc` is null (never run), returns 0 (run immediately / use default interval).
 * - If the interval has already elapsed, returns 0 (run immediately).
 * - Otherwise returns the positive remaining milliseconds.
 *
 * @param lastUtc        ISO-8601 timestamp of the last successful cycle, or null.
 * @param intervalSeconds  Nominal interval in seconds.
 * @param now            Current time in ms (injectable for tests, defaults to Date.now()).
 */
export function computeRemainingMs(
  lastUtc: string | null,
  intervalSeconds: number,
  now = Date.now(),
): number {
  if (!lastUtc) return 0;
  const lastMs = new Date(lastUtc).getTime();
  if (Number.isNaN(lastMs)) return 0;
  const nextMs = lastMs + intervalSeconds * 1000;
  return Math.max(0, nextMs - now);
}

/**
 * Minimum seconds between pull cycles for an anonymous (unauthenticated)
 * pull-only follower. A single follower polling is far under GitHub's
 * per-client guidance; the real exposure is aggregate read pressure across
 * every anonymous follower of one public repo, and that population is the
 * least accountable and least freshness-sensitive, so it polls at a gentler
 * floor than signed-in followers. Hard-coded by design — cadence is not a
 * config knob.
 */
export const ANONYMOUS_PULL_MIN_SECONDS = 180;

/** Which credential tier a pull-only follower will fetch as. */
export type PullAuthTier = 'authenticated' | 'anonymous';

/**
 * Base pull interval (seconds) for a pull-only follower given its auth tier.
 * Signed-in followers keep the responsive base interval; anonymous followers
 * are floored to {@link ANONYMOUS_PULL_MIN_SECONDS} (a base already above the
 * floor is preserved). The caller applies jitter and backoff on top, so both
 * tiers keep the same ±15% spread and failure backoff.
 */
export function pullIntervalSecondsForAuthTier(
  baseIntervalSeconds: number,
  tier: PullAuthTier,
): number {
  return tier === 'anonymous'
    ? Math.max(ANONYMOUS_PULL_MIN_SECONDS, baseIntervalSeconds)
    : baseIntervalSeconds;
}
