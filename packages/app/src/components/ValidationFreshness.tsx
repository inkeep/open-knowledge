/**
 * Freshness trigger 3 of the shared validation store: when a doc's bytes reach
 * disk (CC1 `disk-ack`, relayed as the doc-persisted event), re-validate JUST
 * that doc via the scoped audit and patch its store entry. This heals the
 * silent false-negative where an agent writes a broken link (or a lint
 * problem) into a document nobody has open — its tree tint updates without a
 * whole-project walk.
 *
 * Debounced per doc: persistence flushes ack in bursts during active writing;
 * one trailing re-validate per doc per burst is enough for a tree tint.
 */

import { useEffect } from 'react';
import { runValidationAudit } from '@/editor/validation-audit-client';
import { useConfigContext } from '@/lib/config-provider';
import { filePathToDocName } from '@/lib/doc-hash';
import { subscribeToDocPersisted } from '@/lib/documents-events';
import { patchDocValidationFromAudit } from '@/lib/validation-store';

const REVALIDATE_DEBOUNCE_MS = 500;

/**
 * DocNames the per-doc re-validate skips: reserved trees (`__system__`,
 * `__config__/…`, `__skill__/…`, `__template__/…`, `__local__/…`, `__user__/…`)
 * are not content docs, and extension-retaining Mermaid docs (`.mmd` /
 * `.mermaid`) have no markdown plane to audit.
 */
function isAuditableDocName(docName: string): boolean {
  return !docName.startsWith('__') && !/\.(mmd|mermaid)$/i.test(docName);
}

export function ValidationFreshness() {
  // The per-doc re-validate exists to keep the file tree's indicators fresh;
  // when the project turns those off (`validation.fileTreeIndicators`), skip
  // the background work entirely instead of writing to a store nothing reads.
  const { merged } = useConfigContext();
  const indicatorsEnabled = merged?.validation?.fileTreeIndicators !== false;

  useEffect(() => {
    if (!indicatorsEnabled) return;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    let disposed = false;

    const revalidate = (docName: string) => {
      void runValidationAudit({ kind: 'doc', docName }).then((result) => {
        // A failed scoped audit (server hiccup) keeps the previous entry —
        // stale beats wrongly-clean.
        if (disposed || result === null) return;
        const diagnostics = result.files
          .filter((file) => filePathToDocName(file.file) === docName)
          .flatMap((file) => file.diagnostics);
        patchDocValidationFromAudit(docName, diagnostics);
      });
    };

    const unsubscribe = subscribeToDocPersisted((docName) => {
      if (!isAuditableDocName(docName)) return;
      const existing = timers.get(docName);
      if (existing !== undefined) clearTimeout(existing);
      timers.set(
        docName,
        setTimeout(() => {
          timers.delete(docName);
          revalidate(docName);
        }, REVALIDATE_DEBOUNCE_MS),
      );
    });

    return () => {
      disposed = true;
      unsubscribe();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, [indicatorsEnabled]);

  return null;
}
