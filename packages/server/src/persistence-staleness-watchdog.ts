/**
 * Persistence staleness watchdog — a durability backstop for the L1
 * CRDT→disk write spine.
 *
 * Hocuspocus re-arms the persistence store debounce only when a NEW Y.Doc
 * update arrives, and user docs stay resident for the whole server
 * lifetime. Any store cycle that fails or is skipped after the last edit
 * of a session (a transient disk-write error, a batch deferral dropped on
 * branch mismatch, a lifecycle race) therefore leaves the live doc newer
 * than disk with no retry scheduled — silently, for as long as the server
 * runs. The watchdog sweeps loaded docs on an interval and force-stores
 * any doc whose in-memory bytes have diverged from the persistence layer's
 * own reconciled base for longer than a generous grace window.
 *
 * Why a general sweep rather than a retry at each failure site: the
 * lost-cycle classes have no common hook point with a retry OWNER. A
 * throwing debounced store is recorded out-of-band (`storeFailures`) but
 * nothing on the debounced path ever re-drives it; a branch-mismatched
 * deferral is dropped inside `flushDeferredStores` with no owner to
 * notify; a lifecycle-race skip is by construction invisible to the
 * writer. One anti-entropy sweep over the divergence signal covers every
 * class, including ones not yet catalogued.
 *
 * Safety posture (additive; never bypasses the write spine):
 *   - The staleness predicate is memory vs `reconciledBase` — the
 *     persistence layer's own last-agreed-disk baseline — never memory vs
 *     raw disk. An external disk edit the file-watcher has ingested
 *     advances both sides, so it can never trip the predicate.
 *   - Before forcing, disk is re-read and compared to the base. Bytes on
 *     disk the base doesn't account for mean an out-of-band edit the
 *     watcher hasn't reconciled yet; the watchdog stands down (warn only)
 *     rather than clobber it. Disk stays authoritative for unseen edits,
 *     including out-of-band deletes (base set, file gone → stand down, so
 *     a forced store can't resurrect a deleted file). Residual risk: an
 *     external edit landing in the few-ms window between this pre-check
 *     and the store's atomic write is overwritten — the same window every
 *     debounce-triggered non-agent store has today (only agent-marked
 *     stores get the store-time re-check), so the watchdog adds no new
 *     clobber class; the file-watcher reconcile remains the designed
 *     recovery for that race.
 *   - The force routes through the persistence handle's `forceStore`,
 *     i.e. the exact store spine the debounced hook uses — every existing
 *     guard (lifecycle, quiescence gate, no-op skip, duplication
 *     tripwire, writeTracker registration) applies unchanged.
 */

import { normalizeBridge } from '@inkeep/open-knowledge-core';
import type * as Y from 'yjs';
import { getMsSinceLastUserTx } from './bridge-quiescence.ts';
import { isPersistenceExcludedDoc } from './cc1-broadcast.ts';
import { frozenDocLifecycleStatus } from './conflict-errors.ts';
import { getLogger } from './logger.ts';
import {
  incrementPersistenceStalenessDetected,
  incrementPersistenceStalenessForcedStores,
  incrementPersistenceStalenessStoodDown,
} from './metrics.ts';
import {
  getReconciledBase,
  isBatchInProgress,
  normalizedSourceForm,
  peekInFlightFlush,
} from './persistence.ts';

const log = getLogger('persistence-staleness');

/**
 * Throw from `readDiskBytes` for structurally permanent read refusals — a
 * content path replaced by a symlink resolving outside the content dir, or
 * an out-of-band file grown past the open byte limit. The watchdog then
 * declines the doc until its content changes (instead of retrying every
 * grace window and inflating the alertable stand-down counter forever) and
 * logs at error — a symlink-escape is security-relevant, not transient
 * I/O. Any other throw is treated as transient and retried.
 */
export class StructuralDiskReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructuralDiskReadError';
  }
}

/**
 * Generous by design: the natural flush path settles within seconds
 * (2 s debounce, 10 s maxDebounce, ~16 s quiescence-defer ceiling), so
 * anything divergent this long after its last transaction has no pending
 * store left to wait for.
 */
const DEFAULT_STALENESS_GRACE_MS = 5 * 60_000;
const DEFAULT_STALENESS_SWEEP_INTERVAL_MS = 60_000;

export interface StalenessWatchdogOptions {
  /** Live loaded-docs view, typically `() => hocuspocus.documents`. */
  getLoadedDocuments: () => Iterable<readonly [string, Y.Doc]>;
  /**
   * Force one store cycle through the persistence handle
   * (`PersistenceHandle.forceStore`). Rejections are logged and retried on
   * a later sweep.
   */
  forceStore: (document: Y.Doc, documentName: string) => Promise<void>;
  /**
   * Raw disk bytes for a docName, or `null` when the file does not exist.
   * Throws make the watchdog stand down for that doc — an unreadable file
   * must never be overwritten on a guess. A {@link StructuralDiskReadError}
   * declines the doc until its content changes (the refusal won't clear on
   * its own); any other throw is a transient inability to check and
   * retries a grace window later.
   */
  readDiskBytes: (documentName: string) => string | null;
  /** Minimum age of the newest user transaction before a doc counts as stale. */
  graceMs?: number;
  /** Sweep cadence. The interval timer is unref'd. */
  sweepIntervalMs?: number;
  /** Test seam for deterministic clocks. */
  now?: () => number;
  /** Test seams — default to the real persistence/quiescence surfaces. */
  getBase?: (documentName: string) => string | undefined;
  isBatchActive?: () => boolean;
  peekInFlight?: (documentName: string) => string | undefined;
  msSinceLastUserTx?: (doc: Y.Doc, nowMs: number) => number | null;
}

export interface StalenessWatchdogHandle {
  /** Run one sweep now. The interval skips while a sweep is in flight. */
  sweep: () => Promise<void>;
  /**
   * Stop the interval and drain: resolves after any in-flight sweep has
   * finished, so a caller tearing the server down can be sure no forced
   * store fires against a draining write spine afterwards. An in-flight
   * sweep also short-circuits at its next between-docs checkpoint.
   */
  dispose: () => Promise<void>;
}

interface AttemptRecord {
  fingerprint: string;
  atMs: number;
  /**
   * When this doc's current staleness episode was first observed, carried
   * across retries (unlike `atMs`, which paces them) so logs can report
   * how long the doc has been stale — "1 doc failing for an hour" and
   * "100 docs rescued once" are different incidents.
   */
  firstDetectedAtMs: number;
  /**
   * Retrying these exact bytes is provably futile: the store ran to
   * completion but chose not to write them (no-op classification, tripwire
   * breaker, lifecycle transition), or disk verifiably holds external
   * state the base doesn't account for (divergent bytes, out-of-band
   * delete, never-loaded file). Re-arming requires the content to change.
   * NOT set for transient conditions — a failed store, a failed disk
   * read, or a store parked by a mid-sweep batch keeps `declined: false`
   * so the next grace window retries.
   */
  declined: boolean;
}

export function createPersistenceStalenessWatchdog(
  options: StalenessWatchdogOptions,
): StalenessWatchdogHandle {
  const graceMs = options.graceMs ?? DEFAULT_STALENESS_GRACE_MS;
  const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_STALENESS_SWEEP_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const getBase = options.getBase ?? getReconciledBase;
  const isBatchActive = options.isBatchActive ?? isBatchInProgress;
  const peekInFlight = options.peekInFlight ?? peekInFlightFlush;
  const msSinceLastUserTx = options.msSinceLastUserTx ?? getMsSinceLastUserTx;

  const attempts = new Map<string, AttemptRecord>();
  let disposed = false;
  let sweepInFlight: Promise<void> | null = null;

  /**
   * The store's own no-op comparator form, via the SAME derivation
   * (`normalizedSourceForm`) `storeDocumentNow`'s
   * `markdownSemanticallyUnchanged` skip uses — the two classifiers agree
   * by construction. The store's extra ephemeral-canonical branch is NOT
   * replicated: ephemeral single-file servers don't construct a watchdog
   * at all (see the `!ephemeral` gate in server-factory), precisely
   * because this classifier would read a round-trip-unstable file at rest
   * as divergent.
   */
  function candidateFromRaw(rawYText: string): string {
    return normalizedSourceForm(rawYText);
  }

  function normalizedBaseFor(base: string | undefined): string | undefined {
    return base === undefined ? undefined : normalizeBridge(base);
  }

  function isDivergent(candidate: string, normalizedBase: string | undefined): boolean {
    return normalizedBase === undefined ? candidate !== '' : candidate !== normalizedBase;
  }

  async function sweepOnce(): Promise<void> {
    if (disposed) return;
    // A coordinated git operation owns the write spine right now; bail so
    // the sweep can't interleave with it. Within-branch deferral replay
    // covers most pending work when the batch ends; anything it drops
    // (branch-mismatched entries, discard-stale mode) re-surfaces as
    // divergence on a later sweep — this sweep is that recovery path.
    if (isBatchActive()) return;

    const startedMs = now();
    let scanned = 0;
    let divergent = 0;
    let forced = 0;
    let stoodDown = 0;
    const seen = new Set<string>();
    for (const [documentName, document] of options.getLoadedDocuments()) {
      // dispose() during a previous iteration's await must stop the sweep
      // before it touches another doc.
      if (disposed) return;
      seen.add(documentName);
      if (isPersistenceExcludedDoc(documentName)) continue;
      if (frozenDocLifecycleStatus(document) !== null) {
        // These docs intentionally hold memory != disk; the store spine
        // skips them for the same reason.
        continue;
      }
      if (peekInFlight(documentName) !== undefined) continue;

      scanned++;
      const rawYText = document.getText('source').toString();
      const base = getBase(documentName);
      // Byte-equal fast path: after any successful store or file-watcher
      // ingest the raw Y.Text equals the base verbatim, so resident clean
      // docs skip the strip/normalize comparator work entirely.
      if (base !== undefined && rawYText === base) {
        attempts.delete(documentName);
        continue;
      }
      const candidate = candidateFromRaw(rawYText);
      const normalizedBase = normalizedBaseFor(base);
      if (!isDivergent(candidate, normalizedBase)) {
        attempts.delete(documentName);
        continue;
      }
      divergent++;

      const nowMs = now();
      const ageMs = msSinceLastUserTx(document, nowMs);
      if (ageMs !== null && ageMs < graceMs) continue;

      const previous = attempts.get(documentName);
      if (previous && previous.fingerprint === candidate) {
        if (previous.declined) continue;
        if (nowMs - previous.atMs < graceMs) continue;
      }
      const firstSighting = previous?.fingerprint !== candidate;
      if (firstSighting) incrementPersistenceStalenessDetected();
      const firstDetectedAtMs = !firstSighting && previous ? previous.firstDetectedAtMs : nowMs;
      const staleForMs = nowMs - firstDetectedAtMs;

      // External-edit stand-down. Disk bytes the base doesn't account for
      // mean the file-watcher hasn't reconciled an out-of-band change yet;
      // writing memory over them would clobber it. A missing file with a
      // known base is an unreconciled out-of-band delete — same stand-down
      // (a forced store would resurrect the file). Only two shapes are
      // safe to write: disk still matches the base, or the doc has never
      // had an on-disk form at all.
      let standDownReason: string | null = null;
      let standDownRetryable = false;
      try {
        const diskBytes = options.readDiskBytes(documentName);
        if (normalizedBase === undefined) {
          if (diskBytes !== null) standDownReason = 'disk-file-never-loaded';
        } else if (diskBytes === null) {
          standDownReason = 'disk-file-missing';
        } else if (normalizeBridge(diskBytes) !== normalizedBase) {
          standDownReason = 'disk-diverged-from-base';
        }
      } catch (err) {
        if (err instanceof StructuralDiskReadError) {
          // The refusal (symlink-escape, oversized file) won't clear on its
          // own — decline until the doc's content changes so the alertable
          // stand-down counter doesn't grow forever on one bad path.
          standDownReason = 'disk-read-refused';
          log.error(
            { err, docName: documentName },
            '[persistence-staleness] disk read refused; standing down until content changes',
          );
        } else {
          // Can't verify disk, so don't write — but a transient read fault
          // says nothing about external state, so retry after the next
          // grace window rather than suppressing the doc.
          standDownReason = 'disk-read-failed';
          standDownRetryable = true;
          log.warn(
            { err, docName: documentName },
            '[persistence-staleness] disk read failed; standing down',
          );
        }
      }

      if (standDownReason !== null) {
        stoodDown++;
        incrementPersistenceStalenessStoodDown();
        attempts.set(documentName, {
          fingerprint: candidate,
          atMs: nowMs,
          firstDetectedAtMs,
          declined: !standDownRetryable,
        });
        log.warn(
          {
            docName: documentName,
            ageMs,
            staleForMs,
            candidateBytes: candidate.length,
            baseBytes: base?.length ?? 0,
            action: 'stood-down',
            reason: standDownReason,
          },
          `[persistence-staleness] Unflushed edits detected for ${documentName} but disk state is unverified or unreconciled; not overwriting`,
        );
        continue;
      }

      log.warn(
        {
          docName: documentName,
          ageMs,
          staleForMs,
          candidateBytes: candidate.length,
          baseBytes: base?.length ?? 0,
          action: 'forced-store',
        },
        `[persistence-staleness] Doc ${documentName} has unpersisted edits past the grace window with no pending store; forcing a store`,
      );
      attempts.set(documentName, {
        fingerprint: candidate,
        atMs: nowMs,
        firstDetectedAtMs,
        declined: false,
      });
      incrementPersistenceStalenessForcedStores();
      forced++;
      try {
        await options.forceStore(document, documentName);
      } catch (err) {
        // The store spine already recorded the failure out-of-band; keep
        // declined=false so the next grace window retries (a transient disk
        // condition may have cleared).
        log.error(
          { err, docName: documentName, staleForMs },
          `[persistence-staleness] Forced store failed for ${documentName}; will retry`,
        );
        continue;
      }
      if (disposed) return;
      // A batch that activated inside the forceStore await means the store
      // was PARKED (deferStore), not run — classifying the still-divergent
      // doc as declined here would permanently suppress it even if the
      // batch's replay later drops the parked entry. Bail the sweep (the
      // batch owns the spine now); the entry stays declined:false so the
      // next grace window re-checks.
      if (isBatchActive()) return;

      // Re-read both sides: a store that completed yet left the same bytes
      // divergent chose not to write them (no-op class) — mark declined so
      // we don't loop on it. Convergence (or content that moved on) re-arms.
      const afterCandidate = candidateFromRaw(document.getText('source').toString());
      const afterNormalizedBase = normalizedBaseFor(getBase(documentName));
      if (isDivergent(afterCandidate, afterNormalizedBase) && afterCandidate === candidate) {
        attempts.set(documentName, {
          fingerprint: candidate,
          atMs: nowMs,
          firstDetectedAtMs,
          declined: true,
        });
        log.info(
          { docName: documentName },
          `[persistence-staleness] Store completed without clearing divergence for ${documentName}; suppressing until content changes`,
        );
      } else {
        attempts.delete(documentName);
      }
    }

    // Docs that unloaded since the last sweep drop their bookkeeping.
    for (const name of attempts.keys()) {
      if (!seen.has(name)) attempts.delete(name);
    }

    // Sweep-health signal: the outcome counters say nothing about sweep
    // cost or a wedged sweep; this line does, without per-doc volume.
    // Eventful sweeps log at info so production log levels see them; the
    // steady-state all-clean sweep stays at debug to keep logs quiet.
    const summary = { scanned, divergent, forced, stoodDown, elapsedMs: now() - startedMs };
    if (divergent > 0 || forced > 0 || stoodDown > 0) {
      log.info(summary, '[persistence-staleness] sweep complete');
    } else {
      log.debug(summary, '[persistence-staleness] sweep complete');
    }
  }

  function sweep(): Promise<void> {
    if (sweepInFlight) return sweepInFlight;
    sweepInFlight = sweepOnce().finally(() => {
      sweepInFlight = null;
    });
    return sweepInFlight;
  }

  const timer = setInterval(() => {
    void sweep().catch((err) => {
      log.error({ err }, '[persistence-staleness] sweep failed');
    });
  }, sweepIntervalMs);
  timer.unref?.();

  return {
    sweep,
    dispose: () => {
      disposed = true;
      clearInterval(timer);
      return sweepInFlight ?? Promise.resolve();
    },
  };
}
