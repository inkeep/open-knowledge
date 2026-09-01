import { isSystemDoc } from '@/editor/is-system-doc';
import { mark } from '@/lib/perf';
import { readNumericOverride } from '@/lib/perf/env-override';
import { recordPrewarm } from './prewarm-correlation';

const HOVER_INTENT_MS = readNumericOverride('HOVER_INTENT_MS', 80);
const MAX_CONCURRENT_PREWARMS = 3;
const MAX_ALREADY_PREWARMED = 20;

type PrewarmFn = (docName: string) => string | null;

interface PendingEntry {
  timer: ReturnType<typeof setTimeout>;
  prewarm: PrewarmFn;
}

const pendingTimers = new Map<string, PendingEntry>();
const inflight = new Set<string>();
const queued: Array<{ docName: string; prewarm: PrewarmFn }> = [];
const alreadyPrewarmed = new Map<string, true>();

function markAlreadyPrewarmed(docName: string): void {
  alreadyPrewarmed.delete(docName);
  alreadyPrewarmed.set(docName, true);
  while (alreadyPrewarmed.size > MAX_ALREADY_PREWARMED) {
    const oldest = alreadyPrewarmed.keys().next().value;
    if (oldest === undefined) break;
    alreadyPrewarmed.delete(oldest);
  }
}

function finishInflight(docName: string): void {
  inflight.delete(docName);
  drainQueue();
}

function emitPrewarmSuccess(docName: string, poolEventId: string): void {
  const t = Date.now();
  mark('ok/sidebar/prewarm-success', { docName, t, poolEventId });
  recordPrewarm(docName, poolEventId, t);
}

function drainQueue(): void {
  while (inflight.size < MAX_CONCURRENT_PREWARMS && queued.length > 0) {
    const next = queued.shift();
    if (!next) break;
    if (alreadyPrewarmed.has(next.docName)) continue;
    inflight.add(next.docName);
    markAlreadyPrewarmed(next.docName);
    try {
      const poolEventId = next.prewarm(next.docName);
      if (poolEventId) emitPrewarmSuccess(next.docName, poolEventId);
    } catch (err) {
      mark('ok/sidebar/prewarm-failed', {
        docName: next.docName,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      finishInflight(next.docName);
    }
  }
}

export function scheduleHoverPrewarm(docName: string, prewarm: PrewarmFn): void {
  if (isSystemDoc(docName)) return;
  if (alreadyPrewarmed.has(docName)) return;
  const prior = pendingTimers.get(docName);
  if (prior) clearTimeout(prior.timer);

  const timer = setTimeout(() => {
    pendingTimers.delete(docName);
    if (inflight.size >= MAX_CONCURRENT_PREWARMS) {
      queued.push({ docName, prewarm });
      return;
    }
    markAlreadyPrewarmed(docName);
    inflight.add(docName);
    try {
      const poolEventId = prewarm(docName);
      if (poolEventId) emitPrewarmSuccess(docName, poolEventId);
    } catch (err) {
      mark('ok/sidebar/prewarm-failed', {
        docName,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      finishInflight(docName);
    }
  }, HOVER_INTENT_MS);

  pendingTimers.set(docName, { timer, prewarm });
}

export function cancelHoverPrewarm(docName: string): void {
  const pending = pendingTimers.get(docName);
  if (pending) {
    clearTimeout(pending.timer);
    pendingTimers.delete(docName);
  }
}

export function __resetSidebarHoverPrewarmForTests(): void {
  for (const { timer } of pendingTimers.values()) {
    clearTimeout(timer);
  }
  pendingTimers.clear();
  inflight.clear();
  queued.length = 0;
  alreadyPrewarmed.clear();
}
