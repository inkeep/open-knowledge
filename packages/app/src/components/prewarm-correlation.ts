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

export function __peekPrewarmRecord(docName: string): RecentPrewarm | undefined {
  return recentPrewarms.get(docName);
}

export function __resetPrewarmCorrelation(): void {
  recentPrewarms.clear();
  if (sweepTimer !== null) {
    clearTimeout(sweepTimer);
    sweepTimer = null;
  }
}
