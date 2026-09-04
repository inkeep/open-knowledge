import { addsBlankLines, normalizeBridge } from '@inkeep/open-knowledge-core';
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
import { normalizedSourceForm } from './persistence.ts';

const log = getLogger('persistence-staleness');

export class StructuralDiskReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructuralDiskReadError';
  }
}

const DEFAULT_STALENESS_GRACE_MS = 5 * 60_000;
const DEFAULT_STALENESS_SWEEP_INTERVAL_MS = 60_000;

export interface StalenessWatchdogOptions {
  getLoadedDocuments: () => Iterable<readonly [string, Y.Doc]>;
  forceStore: (document: Y.Doc, documentName: string) => Promise<void>;
  readDiskBytes: (documentName: string) => string | null;
  graceMs?: number;
  sweepIntervalMs?: number;
  now?: () => number;
  getBase: (documentName: string) => string | undefined;
  isBatchActive: () => boolean;
  peekInFlight: (documentName: string) => string | undefined;
  msSinceLastUserTx?: (doc: Y.Doc, nowMs: number) => number | null;
}

export interface StalenessWatchdogHandle {
  sweep: () => Promise<void>;
  dispose: () => Promise<void>;
}

interface AttemptRecord {
  fingerprint: string;
  atMs: number;
  firstDetectedAtMs: number;
  declined: boolean;
}

export function createPersistenceStalenessWatchdog(
  options: StalenessWatchdogOptions,
): StalenessWatchdogHandle {
  const graceMs = options.graceMs ?? DEFAULT_STALENESS_GRACE_MS;
  const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_STALENESS_SWEEP_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const { getBase, isBatchActive, peekInFlight } = options;
  const msSinceLastUserTx = options.msSinceLastUserTx ?? getMsSinceLastUserTx;

  const attempts = new Map<string, AttemptRecord>();
  let disposed = false;
  let sweepInFlight: Promise<void> | null = null;

  function candidateFromRaw(rawYText: string): string {
    return normalizedSourceForm(rawYText);
  }

  function normalizedBaseFor(base: string | undefined): string | undefined {
    return base === undefined ? undefined : normalizeBridge(base);
  }

  function isDivergent(
    candidate: string,
    normalizedBase: string | undefined,
    rawYText: string,
    base: string | undefined,
  ): boolean {
    if (normalizedBase === undefined) return candidate !== '';
    if (candidate !== normalizedBase) return true;
    return base !== undefined && addsBlankLines(base, rawYText);
  }

  async function sweepOnce(): Promise<void> {
    if (disposed) return;
    if (isBatchActive()) return;

    const startedMs = now();
    let scanned = 0;
    let divergent = 0;
    let forced = 0;
    let stoodDown = 0;
    const seen = new Set<string>();
    for (const [documentName, document] of options.getLoadedDocuments()) {
      if (disposed) return;
      seen.add(documentName);
      if (isPersistenceExcludedDoc(documentName)) continue;
      if (frozenDocLifecycleStatus(document) !== null) {
        continue;
      }
      if (peekInFlight(documentName) !== undefined) continue;

      scanned++;
      const rawYText = document.getText('source').toString();
      const base = getBase(documentName);
      if (base !== undefined && rawYText === base) {
        attempts.delete(documentName);
        continue;
      }
      const candidate = candidateFromRaw(rawYText);
      const normalizedBase = normalizedBaseFor(base);
      if (!isDivergent(candidate, normalizedBase, rawYText, base)) {
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
          standDownReason = 'disk-read-refused';
          log.error(
            { err, docName: documentName },
            '[persistence-staleness] disk read refused; standing down until content changes',
          );
        } else {
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
        log.error(
          { err, docName: documentName, staleForMs },
          `[persistence-staleness] Forced store failed for ${documentName}; will retry`,
        );
        continue;
      }
      if (disposed) return;
      if (isBatchActive()) return;

      const afterRawYText = document.getText('source').toString();
      const afterBase = getBase(documentName);
      const afterCandidate = candidateFromRaw(afterRawYText);
      const afterNormalizedBase = normalizedBaseFor(afterBase);
      if (
        isDivergent(afterCandidate, afterNormalizedBase, afterRawYText, afterBase) &&
        afterCandidate === candidate
      ) {
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

    for (const name of attempts.keys()) {
      if (!seen.has(name)) attempts.delete(name);
    }

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
