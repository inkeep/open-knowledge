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
