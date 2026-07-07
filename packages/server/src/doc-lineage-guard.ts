/**
 * `onAuthenticate` check for the per-doc lineage fence (registered as the
 * `doc-lineage-guard` extension in `server-factory.ts`). Extracted from
 * the registration site, mirroring `removal-redirect-guard.ts`, so the
 * claim-vs-live-epoch comparison and the defensive fall-through are
 * unit-testable without a full Hocuspocus instance.
 *
 * Contract — third axis of the stale-client-persistence defense
 * (instance → branch → doc lineage):
 *   1. Absent / empty claims are accepted unconditionally. Legacy clients
 *      never claim, and the client's post-rejection reopen deliberately
 *      claims nothing (its record was just deleted) — an absent claim is
 *      what makes an infinite rejection loop structurally impossible.
 *   2. System / config docs short-circuit at entry (STOP rule) —
 *      synthetic docs never carry a lineage epoch.
 *   3. Doc not loaded: REJECT. The epoch lives only on the live Y.Doc and
 *      the next load re-mints a fresh one (`persistence.ts`
 *      onLoadDocument), so any claim against an unloaded doc is stale by
 *      construction. Rejecting here — before the load and before any Yjs
 *      sync — is the entire point: the client clears its stale IDB and
 *      reopens claim-less instead of union-merging two materializations.
 *   4. Doc loaded: reject when the live epoch is missing or differs from
 *      the claim; admit on exact match.
 *   5. Unexpected errors log a structured warn and ADMIT — same fail-open
 *      philosophy as `runRemovalRedirectGuard`: crashing every connect
 *      over a guard bug costs more than letting one stale tab through,
 *      and the persistence tripwire remains the last line downstream.
 */

import type * as Y from 'yjs';
import { HocuspocusAuthRejection, LINEAGE_EPOCH_KEY } from './auth-token-schema.ts';
import { isConfigDoc, isSystemDoc } from './cc1-broadcast.ts';
import { incrementAuthDocLineageGuardError, incrementAuthDocLineageMismatch } from './metrics.ts';
import { setActiveSpanAttributes } from './telemetry.ts';

/**
 * Dependency shape for `runDocLineageGuard`. Exported so tests can type
 * their stubs structurally — the production caller in `server-factory.ts`
 * constructs the value inline from `hocuspocus.documents`.
 */
export interface DocLineageGuardDeps {
  /** Resolve `documentName` to the live loaded Y.Doc, or `undefined` when unloaded. */
  getLoadedDoc: (documentName: string) => Y.Doc | undefined;
}

export function runDocLineageGuard(
  documentName: string,
  claimedEpoch: string | undefined,
  deps: DocLineageGuardDeps,
): void {
  try {
    if (typeof claimedEpoch !== 'string' || claimedEpoch.length === 0) return;
    if (isSystemDoc(documentName) || isConfigDoc(documentName)) return;

    const doc = deps.getLoadedDoc(documentName);
    if (doc === undefined) {
      incrementAuthDocLineageMismatch();
      setActiveSpanAttributes({ 'auth.reason': 'doc-lineage-mismatch' });
      throw new HocuspocusAuthRejection(
        'doc-lineage-mismatch',
        `doc lineage mismatch: claim against unloaded ${documentName} is stale by construction`,
      );
    }

    const liveEpoch = doc.getMap('lifecycle').get(LINEAGE_EPOCH_KEY);
    if (typeof liveEpoch !== 'string' || liveEpoch.length === 0 || liveEpoch !== claimedEpoch) {
      incrementAuthDocLineageMismatch();
      setActiveSpanAttributes({ 'auth.reason': 'doc-lineage-mismatch' });
      throw new HocuspocusAuthRejection(
        'doc-lineage-mismatch',
        `doc lineage mismatch for ${documentName}: claimed epoch does not match the live lineage`,
      );
    }
  } catch (err) {
    if (err instanceof HocuspocusAuthRejection) throw err;
    incrementAuthDocLineageGuardError();
    console.warn(
      JSON.stringify({
        event: 'doc-lineage-guard-error',
        documentName,
        errorName: err instanceof Error ? err.name : typeof err,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
