/**
 * Client for the unified validation audit surface (`GET /api/audit`) — the
 * one engine spanning every registered content validator (markdownlint AND
 * internal-link resolution), returning a single source-tagged per-file
 * diagnostic plane. Sibling of `lint-config-client.ts`, which stays on the
 * lint-only `/api/lint*` routes.
 */

import {
  type ValidationAuditCountsResponse,
  ValidationAuditCountsResponseSchema,
  type ValidationAuditResponse,
  ValidationAuditResponseSchema,
  type ValidationDocResult,
} from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { subscribeToDocumentsChanged } from '@/lib/documents-events';

/** Wire-loose diagnostic (schema `source` is any string, by design). */
type WireDiagnostic = ValidationDocResult['diagnostics'][number];

export type AuditScope =
  | { kind: 'project' }
  | { kind: 'path'; path: string }
  /** Extension-less docName — the server resolves the on-disk extension. */
  | { kind: 'doc'; docName: string };

/**
 * A walk the server abandoned because the lint config moved under it. Not a
 * failure: whatever changed the config also schedules the replacement walk, so
 * a caller should leave its current state alone rather than surface an error.
 */
export const AUDIT_SUPERSEDED = 'audit-superseded' as const;

/**
 * GET the unified audit plane for a scope. Returns every in-scope doc that has
 * at least one diagnostic from any validator, plus rollup counts and engine
 * degradation warnings. null on failure, `AUDIT_SUPERSEDED` when the config
 * moved under the walk.
 */
export async function runValidationAudit(
  scope: AuditScope = { kind: 'project' },
): Promise<ValidationAuditResponse | null | typeof AUDIT_SUPERSEDED> {
  return fetchAudit(scope, ValidationAuditResponseSchema, false);
}

/**
 * The same audit, tallied instead of enumerated — per-file error/warning counts
 * split by validator source, with no messages, ranges, or fix edits. The
 * freshness path behind file-tree tints wants exactly these counts; on a large
 * KB the enumerated plane is tens of MB it would discard on arrival.
 *
 * `signal` aborts a run whose result is already superseded (a second config
 * change landing while the first walk is still going).
 */
export async function runValidationAuditCounts(
  scope: AuditScope = { kind: 'project' },
  signal?: AbortSignal,
): Promise<ValidationAuditCountsResponse | null | typeof AUDIT_SUPERSEDED> {
  return fetchAudit(scope, ValidationAuditCountsResponseSchema, true, signal);
}

/** Shared fetch + parse for both audit planes; they differ only in shape. */
async function fetchAudit<T>(
  scope: AuditScope,
  schema: z.ZodType<T>,
  counts: boolean,
  signal?: AbortSignal,
): Promise<T | null | typeof AUDIT_SUPERSEDED> {
  try {
    const params = new URLSearchParams();
    if (scope.kind === 'path') params.set('path', scope.path);
    else if (scope.kind === 'doc') params.set('doc', scope.docName);
    if (counts) params.set('counts', '1');
    const query = params.size === 0 ? '' : `?${params}`;
    const res = await fetch(`/api/audit${query}`, signal === undefined ? undefined : { signal });
    if (!res.ok) {
      // The audit routes reserve 409 for a walk the config moved under, which is
      // the expected outcome of toggling a rule mid-walk. Reporting it as a
      // failure would strand the Problems panel, so it gets its own signal.
      if (res.status === 409) return AUDIT_SUPERSEDED;
      // Log like the schema-drift path below: a non-OK response (server down,
      // port conflict) otherwise silently leaves the panel + tree on stale data.
      console.warn('[audit] request failed', res.status, res.statusText);
      return null;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      // The body read is a second cancellation point: a signal that fires after
      // the response resolves rejects here rather than at the fetch, so an
      // abort would otherwise be reported as a malformed body.
      if (signal?.aborted === true) return null;
      // A body that isn't JSON at all (proxy HTML error page, truncated
      // response, charset mismatch) is a transport failure, not a contract
      // drift — log it distinctly so triage doesn't chase a phantom schema miss.
      console.warn('[audit] response body is not valid JSON');
      return null;
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      // Mirror the sibling lint-config-client logging so a client/server
      // schema drift window leaves a diagnostic trail instead of a silent null.
      console.warn('[audit] response failed schema validation', parsed.error.issues);
      return null;
    }
    return parsed.data;
  } catch (err) {
    // An abort is the caller superseding its own request, not a failure —
    // logging it would cry wolf on every rapid second toggle. Keyed on the
    // signal rather than the error shape because abort(reason) rejects with
    // that reason verbatim, so a custom reason never arrives as an AbortError.
    if (signal?.aborted === true) return null;
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
        if (cancelled || result === null || result === AUDIT_SUPERSEDED) return;
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
