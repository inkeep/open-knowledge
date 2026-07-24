/**
 * Client for the unified validation audit surface (`GET /api/audit`) — the
 * one engine spanning every registered content validator (markdownlint AND
 * internal-link resolution), returning a single source-tagged per-file
 * diagnostic plane. Sibling of `lint-config-client.ts`, which stays on the
 * lint-only `/api/lint*` routes.
 */

import {
  type ValidationAuditResponse,
  ValidationAuditResponseSchema,
  type ValidationDocResult,
} from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';
import { subscribeToDocumentsChanged } from '@/lib/documents-events';

/** Wire-loose diagnostic (schema `source` is any string, by design). */
type WireDiagnostic = ValidationDocResult['diagnostics'][number];

export type AuditScope =
  | { kind: 'project' }
  | { kind: 'path'; path: string }
  /** Extension-less docName — the server resolves the on-disk extension. */
  | { kind: 'doc'; docName: string };

/**
 * GET the unified audit plane for a scope. Returns every in-scope doc that has
 * at least one diagnostic from any validator, plus rollup counts and engine
 * degradation warnings. null on any failure.
 */
export async function runValidationAudit(
  scope: AuditScope = { kind: 'project' },
): Promise<ValidationAuditResponse | null> {
  try {
    const query =
      scope.kind === 'path'
        ? `?path=${encodeURIComponent(scope.path)}`
        : scope.kind === 'doc'
          ? `?doc=${encodeURIComponent(scope.docName)}`
          : '';
    const res = await fetch(`/api/audit${query}`);
    if (!res.ok) {
      // Log like the schema-drift path below: a non-OK response (server down,
      // port conflict) otherwise silently leaves the panel + tree on stale data.
      console.warn('[audit] request failed', res.status, res.statusText);
      return null;
    }
    const body = await res.json().catch(() => null);
    const parsed = ValidationAuditResponseSchema.safeParse(body);
    if (!parsed.success) {
      // Mirror the sibling lint-config-client logging so a client/server
      // schema drift window leaves a diagnostic trail instead of a silent null.
      console.warn('[audit] response failed schema validation', parsed.error.issues);
      return null;
    }
    return parsed.data;
  } catch (err) {
    console.warn('[audit] fetch threw', err);
    return null;
  }
}

/**
 * Live broken-link findings for one doc, via the SAME scoped audit predicate
 * the project audit runs — doc scope is a provable restriction of the
 * project-wide plane, never a second determination. Lint findings are
 * excluded here (the doc scope's lint plane is the live `useDocDiagnostics`
 * CRDT read, which is fresher than the audit walk).
 *
 * Refreshes when the doc changes and on every CC1 `backlinks` push — the
 * signal the server debounces whenever the link index changes, which covers
 * both this doc's own edits and cross-doc ripples (a deleted target turning
 * this doc's link dead).
 */
export function useDocLinkFindings(docName: string | null): WireDiagnostic[] {
  const [findings, setFindings] = useState<WireDiagnostic[]>([]);
  useEffect(() => {
    // Reset on every doc change, not just null: the previous doc's findings
    // must never survive into the new doc's render window — a stale carryover
    // would show doc A's dead links under doc B (panel rows AND store counts)
    // until the scoped fetch resolves.
    setFindings((prev) => (prev.length === 0 ? prev : []));
    if (docName === null) {
      return;
    }
    let cancelled = false;
    const load = () => {
      void runValidationAudit({ kind: 'doc', docName }).then((result) => {
        if (cancelled || result === null) return;
        const linkFindings = result.files
          .flatMap((f) => f.diagnostics)
          .filter((d) => d.source === 'links');
        setFindings((prev) =>
          prev.length === 0 && linkFindings.length === 0 ? prev : linkFindings,
        );
      });
    };
    load();
    const unsub = subscribeToDocumentsChanged((channels) => {
      if (channels.includes('backlinks')) load();
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [docName]);
  return findings;
}
