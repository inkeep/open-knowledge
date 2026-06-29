import {
  type BridgeInvariantSite,
  type BridgeInvariantViolation,
  BridgeInvariantViolationError,
  type BridgeToleranceClass,
  detectAppliedToleranceClasses,
  emitToleranceFire,
  normalizeBridge,
  toBridgeInvariantLog,
} from '@inkeep/open-knowledge-core';
import {
  incrementBridgeInvariantViolations,
  incrementBridgeInvariantViolationsSuppressed,
  incrementBridgeSplitBrainRederivesSuppressed,
  incrementBridgeToleranceApplied,
  incrementObserverAPathBFiresSuppressed,
} from './metrics.ts';

const DEFAULT_DEBOUNCE_S = 60;

/** Map<rateKey, last-emit-Unix-ms>. rateKey = `${site}::${docName ?? '__nodoc__'}`.
 *  Bounded by lazy pruning (see `MAX_VIOLATION_RATE_TUPLES`) — without it the
 *  map would grow indefinitely as docs are renamed/deleted/created over a
 *  long-lived server: every (site, docName) tuple that ever emitted a
 *  violation leaves a permanent entry. The leak only manifests in pathological
 *  cases (the exact regime the watchdog targets), so growth must be bounded
 *  even though steady-state target is ~0 violations.
 *
 *  WARN: module-level state. Today this is correct because exactly one server
 *  runs per `contentDir` per process (enforced by `server.lock`). If multi-
 *  server-per-process is ever adopted (multi-vault desktop, cloud multi-
 *  tenant), this map would conflate (site, docName) tuples across servers —
 *  Server A's violation rate-limit window would suppress Server B's
 *  violation event for the same docName within the same window, degrading
 *  the per-tenant signal. The fix at that point is closure-scoping per
 *  server (compare `persistence.ts:configLkgCache`), threading the cache
 *  through `assertBridgeInvariant` instead of capturing it at module scope.
 *  Tracking here so the future-fix is discoverable. */
const lastEmitMs = new Map<string, number>();

/** Lazy-pruning threshold for `lastEmitMs`. When the map exceeds this, the
 *  next `shouldEmitBridgeInvariantViolation` walks past-window entries
 *  (older than `debounceMs`) and deletes them — those entries already permit
 *  emission so dropping them is functionally identical to keeping them.
 *
 *  Conditional bound: pruning reclaims keys whose last-emit is past the
 *  debounce window. Under a truly sustained burst (>1024 distinct (site, doc)
 *  tuples ALL emitting within the same window), every entry is within-window,
 *  the prune walk deletes nothing, and the map continues to grow until the
 *  burst cools. Acceptable because (a) repeat violations on the same key do
 *  NOT add new entries (rate-limiter overwrites), so pathological growth
 *  requires N distinct doc names violating concurrently within one window —
 *  rare in practice; (b) once any subset cools below the window, the next
 *  emission reclaims them. 1024 keeps the audit signal (recent doc names
 *  emitting violations) intact across short wall windows. */
const MAX_VIOLATION_RATE_TUPLES = 1024;

/** Map<rateKey, last-emit-Unix-ms> for the bridge-tolerance-applied event.
 *  rateKey = `${site}::${class}`. Bounded cardinality: 16 classes × 3 sites =
 *  48 entries max globally. Per-(site, class) windows let operators see how
 *  often each site relies on each tolerance class — observer-b CRLF rates
 *  vs persistence CRLF rates surface separately.
 *
 *  WARN: same module-level state caveat as `lastEmitMs` above. The 48-entry
 *  bound is global; under multi-server-per-process, a single server's
 *  tolerance event would suppress another server's same-class event in
 *  the same window. Less concerning than the violation rate-limiter
 *  because tolerance events are informational (they're documented
 *  tolerated bytes), not signals of regression. */
const lastToleranceEmitMs = new Map<string, number>();

/** Map<docName, last-emit-Unix-ms> for the observer-a-path-b-fired event.
 *  Per-doc keying so a single chatty doc cannot suppress events from other
 *  docs. The counter (`observerAPathBFires`) increments only on emit,
 *  matching the bridge-invariant-violation pattern; the suppressed counter
 *  is bumped when this gate closes. Each Path B fire bumps exactly one of
 *  the two, so the documented identity `actual_rate = fires + suppressed`
 *  holds. Sentinel `__nodoc__` covers the rare path where a Y.Doc has no
 *  docName attribution.
 *
 *  WARN: same module-level state caveat as `lastEmitMs` above. */
const lastPathBEmitMs = new Map<string, number>();

/** Observer A settlement-check site that detected a drain settling
 *  split-brain. Three production sites in `server-observers.ts`: the
 *  identity gate (fragment changed but its serialization didn't move),
 *  the post-merge baseline check (after a Path A/B Y.Text write), and
 *  the error-recovery catch (sync work threw before the settlement check,
 *  so the baseline reset must not witness a divergent Y.Text). */
export type BridgeSplitBrainSite = 'identity-gate' | 'post-merge' | 'error-recovery';

/** Map<rateKey, last-emit-Unix-ms> for the bridge-split-brain-rederive
 *  event. rateKey = `${site}::${docName ?? '__nodoc__'}` — per-(site, doc)
 *  so a chatty doc can't suppress signal from quieter docs and the two
 *  detection sites surface independently. Bounded: 2 sites × docs, with
 *  the same lazy prune as `lastEmitMs`.
 *
 *  WARN: same module-level state caveat as `lastEmitMs` above. */
const lastSplitBrainEmitMs = new Map<string, number>();

function toleranceRateKey(site: BridgeInvariantSite, cls: BridgeToleranceClass): string {
  return `${site}::${cls}`;
}

function readDebounceMs(): number {
  const raw = process.env.OK_BRIDGE_VIOLATION_DEBOUNCE_S;
  if (raw === undefined) return DEFAULT_DEBOUNCE_S * 1000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DEBOUNCE_S * 1000;
  return parsed * 1000;
}

function rateKey(site: BridgeInvariantSite, docName: string | undefined): string {
  return `${site}::${docName ?? '__nodoc__'}`;
}

export function shouldEmitBridgeInvariantViolation(
  site: BridgeInvariantSite,
  docName: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  const key = rateKey(site, docName);
  const last = lastEmitMs.get(key);
  const debounceMs = readDebounceMs();
  if (last !== undefined && nowMs - last < debounceMs) return false;
  if (lastEmitMs.size >= MAX_VIOLATION_RATE_TUPLES) {
    for (const [k, lastMs] of lastEmitMs) {
      if (nowMs - lastMs >= debounceMs) lastEmitMs.delete(k);
    }
  }
  lastEmitMs.set(key, nowMs);
  return true;
}

export function shouldEmitBridgeToleranceApplied(
  site: BridgeInvariantSite,
  toleranceClass: BridgeToleranceClass,
  nowMs: number = Date.now(),
): boolean {
  const key = toleranceRateKey(site, toleranceClass);
  const last = lastToleranceEmitMs.get(key);
  const debounceMs = readDebounceMs();
  if (last !== undefined && nowMs - last < debounceMs) return false;
  lastToleranceEmitMs.set(key, nowMs);
  return true;
}

export function shouldEmitObserverAPathBFired(
  docName: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  const key = docName ?? '__nodoc__';
  const last = lastPathBEmitMs.get(key);
  const debounceMs = readDebounceMs();
  if (last !== undefined && nowMs - last < debounceMs) return false;
  if (lastPathBEmitMs.size >= MAX_VIOLATION_RATE_TUPLES) {
    for (const [k, lastMs] of lastPathBEmitMs) {
      if (nowMs - lastMs >= debounceMs) lastPathBEmitMs.delete(k);
    }
  }
  lastPathBEmitMs.set(key, nowMs);
  return true;
}

export function emitObserverAPathBFired(docName: string | undefined, nowMs?: number): boolean {
  const shouldEmit = shouldEmitObserverAPathBFired(docName, nowMs);
  if (!shouldEmit) {
    incrementObserverAPathBFiresSuppressed();
  }
  return shouldEmit;
}

export function shouldEmitBridgeSplitBrainRederive(
  site: BridgeSplitBrainSite,
  docName: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  const key = `${site}::${docName ?? '__nodoc__'}`;
  const last = lastSplitBrainEmitMs.get(key);
  const debounceMs = readDebounceMs();
  if (last !== undefined && nowMs - last < debounceMs) return false;
  if (lastSplitBrainEmitMs.size >= MAX_VIOLATION_RATE_TUPLES) {
    for (const [k, lastMs] of lastSplitBrainEmitMs) {
      if (nowMs - lastMs >= debounceMs) lastSplitBrainEmitMs.delete(k);
    }
  }
  lastSplitBrainEmitMs.set(key, nowMs);
  return true;
}

export function emitBridgeSplitBrainRederive(
  site: BridgeSplitBrainSite,
  docName: string | undefined,
  nowMs?: number,
): boolean {
  const shouldEmit = shouldEmitBridgeSplitBrainRederive(site, docName, nowMs);
  if (!shouldEmit) {
    incrementBridgeSplitBrainRederivesSuppressed();
  }
  return shouldEmit;
}

export function __resetBridgeWatchdogForTests(): void {
  lastEmitMs.clear();
  lastToleranceEmitMs.clear();
  lastPathBEmitMs.clear();
  lastSplitBrainEmitMs.clear();
}

export function __getViolationRateTupleCountForTests(): number {
  return lastEmitMs.size;
}

export function __getSplitBrainRateTupleCountForTests(): number {
  return lastSplitBrainEmitMs.size;
}

export function shouldThrowOnBridgeInvariantViolation(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.NODE_ENV === 'test' || env.OK_BRIDGE_THROW_ON_VIOLATION === '1';
}

interface AssertBridgeInvariantOpts {
  site: BridgeInvariantSite;
  docName?: string;
  origin?: unknown;
  nowMs?: number;
  suppressDevThrow?: boolean;
}

export function assertBridgeInvariant(
  ytextSnapshot: string,
  fragmentMdSnapshot: string,
  opts: AssertBridgeInvariantOpts,
): boolean {
  const ytextNorm = normalizeBridge(ytextSnapshot);
  const fragNorm = normalizeBridge(fragmentMdSnapshot);
  if (ytextNorm === fragNorm) {
    if (ytextSnapshot !== fragmentMdSnapshot) {
      const classes = detectAppliedToleranceClasses(ytextSnapshot, fragmentMdSnapshot);
      const emittedClasses = classes.filter((cls) =>
        shouldEmitBridgeToleranceApplied(opts.site, cls, opts.nowMs),
      );
      if (classes.length > 0) {
        emitToleranceFire(classes, ytextSnapshot, fragmentMdSnapshot, opts.docName);
      }
      for (const cls of emittedClasses) {
        incrementBridgeToleranceApplied(cls);
        console.warn(
          JSON.stringify({
            event: 'bridge-tolerance-applied',
            site: opts.site,
            class: cls,
          }),
        );
      }
    }
    return true;
  }

  const violation: BridgeInvariantViolation = {
    site: opts.site,
    origin: opts.origin,
    docName: opts.docName,
    ytextSnapshot,
    fragmentMdSnapshot,
    unifiedDiff: `  ytext: ${ytextNorm.slice(0, 300)}\n  frag:  ${fragNorm.slice(0, 300)}`,
    stack: new Error().stack,
  };

  if (shouldThrowOnBridgeInvariantViolation() && !opts.suppressDevThrow) {
    throw new BridgeInvariantViolationError(violation);
  }

  const shouldEmit = shouldEmitBridgeInvariantViolation(opts.site, opts.docName, opts.nowMs);
  if (!shouldEmit) {
    incrementBridgeInvariantViolationsSuppressed();
    return false;
  }
  incrementBridgeInvariantViolations();
  const verbose = process.env.OK_TELEMETRY_VERBOSE === '1';
  console.warn(JSON.stringify(toBridgeInvariantLog(violation, { verbose })));
  return false;
}
