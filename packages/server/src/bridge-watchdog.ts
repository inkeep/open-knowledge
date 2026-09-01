/**
 * Server-side bridge invariant watchdog.
 *
 * Y.Text-is-truth contract assertion site: after Observer B Phase 1 derives
 * fragment from `parse(ytext)`, the watchdog asserts that the post-write
 * bridge invariant holds:
 *
 *   normalizeBridge(ytext.toString())
 *     === normalizeBridge(prependFrontmatter(fm, mdManager.serialize(fragment)))
 *
 * Outside the `normalizeBridge` tolerance set, the watchdog fires:
 *   - dev (`NODE_ENV=test` or `OK_BRIDGE_THROW_ON_VIOLATION=1`):
 *     throws `BridgeInvariantViolationError` so integration tests + fuzz
 *     runs surface the regression loudly.
 *   - prod: emits a structured `bridge-invariant-violation` console.warn
 *     event (machine-readable JSON) + increments
 *     `bridgeInvariantViolations`. Rate-limited per (site, doc) tuple so
 *     a single buggy doc cannot drown the signal.
 *
 * Lives in its own module because precedent #13(b) bans wall-clock
 * SCHEDULING (`setTimeout`, `setInterval`) in `server-observers.ts` —
 * see `bridge-no-wallclock.test.ts` for the enforced gate's `FORBIDDEN`
 * regex array. The rate-limiter needs `Date.now()` for window comparison;
 * co-locating it here keeps timer machinery isolated even though the
 * precedent gate doesn't cover `Date.now()` directly (server-observers.ts
 * itself uses `new Date().toISOString()` for the timestamp field of its
 * own structured-log events).
 *
 * Telemetry payload is bounded-cardinality and content-redacted by default:
 * site, docName-or-null, the tolerance-class label (`'untracked'` for
 * unknown classes — the comparator stack tolerates known byte classes plus
 * the parse-equivalence fallback, so a violation past ALL of them is by
 * definition untracked), and FNV-1a digests of the
 * ytext + fragment snapshots for cross-event correlation. The truncated
 * unifiedDiff is included as `diff` ONLY when `OK_TELEMETRY_VERBOSE=1`
 * (mirrors the sibling `bridge-merge-content-loss` opt-in pattern). Full
 * snapshots travel only on the thrown error for dev triage; never logged.
 *
 * @see packages/core/src/bridge/normalize.ts (tolerance set)
 * @see packages/core/src/bridge/bridge-invariant.ts (error type)
 */

import type { MarkdownManager } from '@inkeep/open-knowledge-core';
import {
  type BridgeInvariantSite,
  type BridgeInvariantViolation,
  BridgeInvariantViolationError,
  type BridgeToleranceSignal,
  detectAppliedToleranceClasses,
  emitToleranceFire,
  isParseEquivalentBridge,
  locateBridgeDivergence,
  normalizeBridge,
  PARSE_EQUIVALENCE_TOLERANCE,
  toBridgeInvariantLog,
} from '@inkeep/open-knowledge-core';
import { getLogger } from './logger.ts';
import {
  incrementBridgeInvariantViolations,
  incrementBridgeInvariantViolationsSuppressed,
  incrementBridgeSplitBrainRederivesSuppressed,
  incrementBridgeToleranceApplied,
  incrementObserverAPathBFiresSuppressed,
} from './metrics.ts';

const log = getLogger('bridge-watchdog');

const DEFAULT_DEBOUNCE_S = 60;

const lastEmitMs = new Map<string, number>();

const MAX_VIOLATION_RATE_TUPLES = 1024;

const lastToleranceEmitMs = new Map<string, number>();

const lastPathBEmitMs = new Map<string, number>();

export type BridgeSplitBrainSite =
  | 'identity-gate'
  | 'post-merge'
  | 'error-recovery'
  | 'duplication-guard';

const lastSplitBrainEmitMs = new Map<string, number>();

function toleranceRateKey(site: BridgeInvariantSite, cls: BridgeToleranceSignal): string {
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
  toleranceClass: BridgeToleranceSignal,
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
  } else {
    log.debug(
      { docName },
      '[bridge-watchdog] Observer A Path B fired (slow-path Y.Text divergence merge)',
    );
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
  } else {
    log.debug({ site, docName }, '[bridge-watchdog] split-brain re-derive detected');
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

type DocParseSurface = Pick<
  NonNullable<Parameters<MarkdownManager['parseWithFallback']>[1]>,
  'resolveEmbed' | 'resolveSize'
> & { docName?: string };

export function createDocCanonicalizer(
  mdManager: MarkdownManager,
  opts: DocParseSurface,
): (body: string) => string {
  const parseOpts =
    opts.resolveEmbed && opts.docName
      ? {
          resolveEmbed: opts.resolveEmbed,
          resolveSize: opts.resolveSize,
          sourcePath: opts.docName,
        }
      : undefined;
  return (body: string): string =>
    mdManager.serialize(mdManager.parseWithFallback(body, parseOpts));
}

interface AssertBridgeInvariantOpts {
  site: BridgeInvariantSite;
  docName?: string;
  origin?: unknown;
  nowMs?: number;
  suppressDevThrow?: boolean;
  /**
   * Parse-equivalence fallback (`isParseEquivalentBridge`). When the inputs
   * diverge beyond every `normalizeBridge` byte class, canonicalize the
   * ytext body through the caller's own parse→serialize pipeline and accept
   * the pair when the canonical forms match — the fragment then IS
   * `parse(ytext)` (precedent #38), so a resting serializer canonicalization
   * (CommonMark lazy continuations: an unindented wrapped list line, a
   * paragraph glued under a list, a `> `-less blockquote continuation) is a
   * tolerated equivalence, not a violation. Reported through the
   * `bridge-tolerance-applied` channel as `parse-equivalence`.
   *
   * Callers MUST bind the same parse options the doc's fragment derivation
   * uses (embed resolution, source path) — a mismatched pipeline degrades
   * safely toward alerting, never masking. Omitting the callback preserves
   * the strict normalize-only behavior.
   */
  canonicalizeBody?: (body: string) => string;
}

export function assertBridgeInvariant(
  ytextSnapshot: string,
  fragmentMdSnapshot: string,
  opts: AssertBridgeInvariantOpts,
): boolean {
  const reportTolerated = (classes: readonly BridgeToleranceSignal[]): void => {
    const emittedClasses = classes.filter((cls) =>
      shouldEmitBridgeToleranceApplied(opts.site, cls, opts.nowMs),
    );
    if (classes.length > 0) {
      emitToleranceFire(classes, ytextSnapshot, fragmentMdSnapshot, opts.docName);
    }
    if (emittedClasses.length > 0) {
      log.debug(
        { site: opts.site, docName: opts.docName, classes: emittedClasses },
        '[bridge-watchdog] tolerance classes applied',
      );
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
  };

  const ytextNorm = normalizeBridge(ytextSnapshot);
  const fragNorm = normalizeBridge(fragmentMdSnapshot);
  if (ytextNorm === fragNorm) {
    if (ytextSnapshot !== fragmentMdSnapshot) {
      reportTolerated(detectAppliedToleranceClasses(ytextSnapshot, fragmentMdSnapshot));
    }
    return true;
  }

  if (
    opts.canonicalizeBody &&
    isParseEquivalentBridge(ytextSnapshot, fragmentMdSnapshot, opts.canonicalizeBody)
  ) {
    reportTolerated([
      ...detectAppliedToleranceClasses(ytextSnapshot, fragmentMdSnapshot),
      PARSE_EQUIVALENCE_TOLERANCE,
    ]);
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
  const divergence = locateBridgeDivergence(ytextNorm, fragNorm);
  log.warn(
    {
      site: opts.site,
      docName: opts.docName,
      ytextBytes: ytextSnapshot.length,
      fragmentBytes: fragmentMdSnapshot.length,
      normalizedYtextBytes: ytextNorm.length,
      normalizedFragmentBytes: fragNorm.length,
      firstDivergenceIndex: divergence.index,
      normalizedLine: divergence.normalizedLine,
      normalizedColumn: divergence.normalizedColumn,
      ytextLineKind: divergence.ytextLineKind,
      fragmentLineKind: divergence.fragmentLineKind,
      precedingLineKind: divergence.precedingLineKind,
    },
    `[bridge-watchdog] bridge invariant violation at ${opts.site}${
      opts.docName ? ` for '${opts.docName}'` : ''
    }`,
  );
  const verbose = process.env.OK_TELEMETRY_VERBOSE === '1';
  console.warn(JSON.stringify(toBridgeInvariantLog(violation, { verbose })));
  return false;
}
