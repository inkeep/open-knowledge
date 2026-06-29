
import type * as Y from 'yjs';
import { HocuspocusAuthRejection, LINEAGE_EPOCH_KEY } from './auth-token-schema.ts';
import { isConfigDoc, isSystemDoc } from './cc1-broadcast.ts';
import { incrementAuthDocLineageGuardError, incrementAuthDocLineageMismatch } from './metrics.ts';
import { setActiveSpanAttributes } from './telemetry.ts';

export interface DocLineageGuardDeps {
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
