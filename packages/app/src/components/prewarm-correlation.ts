/**
 * Prewarm-then-click correlation by deterministic `poolEventId`.
 *
 * The hover-intent prewarm path emits `ok/sidebar/prewarm-success` and
 * records `(docName, poolEventId, emittedAt)` here. The user-click path
 * (`DocumentContext.openDocument`) reads this map: when the pool entry's
 * `poolEventId` matches a recorded prewarm within
 * `PREWARM_CORRELATION_WINDOW_MS`, the click emits
 * `ok/sidebar/prewarm-clicked` and `mark.count('ok/sidebar/prewarm',
 * { hit: true })`. On TTL expiry without a click the cleanup tick emits
 * `mark.count('ok/sidebar/prewarm', { hit: false })`.
 *
 * JOIN DISCIPLINE: the join is by `poolEventId` equality (deterministic).
 * The window is purely a TTL for in-memory cleanup — it is NEVER the
 * join primitive. Two concurrent prewarms for different pool entries
 * never confuse each other, even when their docNames or timestamps
 * overlap.
 */

import { mark } from '@/lib/perf';
import { readNumericOverride } from '@/lib/perf/env-override';

interface RecentPrewarm {
  poolEventId: string;
  emittedAt: number;
}

const recentPrewarms = new Map<string, RecentPrewarm>();
let sweepTimer: ReturnType<typeof setTimeout> | null = null;

function getTtlMs(): number {
  return readNumericOverride('PREWARM_CORRELATION_WINDOW_MS', 5_000);
}

function scheduleSweep(): void {
  if (sweepTimer !== null) return;
  // Sweep slightly after each TTL window so expired entries get processed
  // approximately once per window. Using a half-window cadence balances
  // latency vs cost.
  const cadence = Math.max(50, Math.floor(getTtlMs() / 2));
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    sweepExpired(Date.now());
    if (recentPrewarms.size > 0) scheduleSweep();
  }, cadence);
}

function sweepExpired(now: number): void {
  const ttl = getTtlMs();
  for (const [docName, entry] of recentPrewarms) {
    if (now - entry.emittedAt >= ttl) {
      recentPrewarms.delete(docName);
      mark.count('ok/sidebar/prewarm', { hit: false });
    }
  }
}

/**
 * Record that a prewarm fired for `docName` with the given `poolEventId`.
 *
 * Overwrites any prior record for the same docName (the latest prewarm
 * wins). When an overwrite happens, the prior record's hit:false signal
 * is emitted at overwrite time — hit:false means "the prewarm didn't
 * lead to its own click within TTL," and an overwritten record can no
 * longer be matched, so the verdict is settled. Without this emission,
 * overwritten entries would never increment hit:false (the TTL sweep
 * can't find them after delete) and the prewarm-effectiveness counter
 * would silently bias toward over-counting hits / under-counting misses.
 */
export function recordPrewarm(
  docName: string,
  poolEventId: string,
  now: number = Date.now(),
): void {
  if (recentPrewarms.has(docName)) {
    mark.count('ok/sidebar/prewarm', { hit: false });
  }
  recentPrewarms.set(docName, { poolEventId, emittedAt: now });
  scheduleSweep();
}

/**
 * Check whether opening `docName` with the given `poolEventId` matches a
 * recent prewarm record within TTL. On match: emits the
 * prewarm-clicked mark + counter, removes the record, returns true.
 * On no match: returns false (caller does not emit).
 */
export function consumePrewarmClick(
  docName: string,
  poolEventId: string,
  now: number = Date.now(),
): boolean {
  const record = recentPrewarms.get(docName);
  if (!record) return false;
  if (record.poolEventId !== poolEventId) return false;
  if (now - record.emittedAt >= getTtlMs()) return false;
  recentPrewarms.delete(docName);
  mark('ok/sidebar/prewarm-clicked', { docName, t: now, poolEventId });
  mark.count('ok/sidebar/prewarm', { hit: true });
  return true;
}

/** Test-only: snapshot of recorded prewarms. */
export function __peekPrewarmRecord(docName: string): RecentPrewarm | undefined {
  return recentPrewarms.get(docName);
}

/** Test-only: clear state between tests + cancel pending sweep. */
export function __resetPrewarmCorrelation(): void {
  recentPrewarms.clear();
  if (sweepTimer !== null) {
    clearTimeout(sweepTimer);
    sweepTimer = null;
  }
}
