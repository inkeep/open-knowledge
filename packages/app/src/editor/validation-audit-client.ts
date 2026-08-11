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
import { invalidatesLocalTargetAudit, subscribeToDocumentsChanged } from '@/lib/documents-events';

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
  signal?: AbortSignal,
): Promise<ValidationAuditResponse | null | typeof AUDIT_SUPERSEDED> {
  return fetchAudit(scope, ValidationAuditResponseSchema, false, signal);
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
export type DocLinkFindingsState =
  | { status: 'idle'; findings: readonly WireDiagnostic[] }
  | { status: 'loading'; findings: readonly WireDiagnostic[] }
  | { status: 'loaded'; findings: readonly WireDiagnostic[] }
  | { status: 'failed'; findings: readonly WireDiagnostic[] };

/**
 * One serialized scoped-audit subscription. Invalidations received during a
 * walk mark it dirty instead of starting a competing request; once that walk
 * settles, exactly one fresh request runs against the new local-target world.
 * This is stronger than abort-only cancellation because the server may
 * coalesce an invalidating request onto the same already-running audit.
 */
export function subscribeToDocLinkFindings(
  docName: string,
  onState: (state: DocLinkFindingsState) => void,
): () => void {
  let disposed = false;
  let inFlight = false;
  let dirty = false;
  let findings: readonly WireDiagnostic[] = [];
  let controller: AbortController | null = null;

  const load = (): void => {
    if (inFlight) {
      dirty = true;
      return;
    }
    inFlight = true;
    controller = new AbortController();
    onState({ status: 'loading', findings });
    void runValidationAudit({ kind: 'doc', docName }, controller.signal)
      .then((result) => {
        if (disposed || controller?.signal.aborted === true) return;
        if (result === null) {
          onState({ status: 'failed', findings });
          return;
        }
        if (result === AUDIT_SUPERSEDED) {
          dirty = true;
          return;
        }
        // An invalidation proves this completion describes an older world.
        // Keep the current visible state until the queued replacement settles.
        if (dirty) return;
        findings = result.files
          .flatMap((file) => file.diagnostics)
          .filter((diagnostic) => diagnostic.source === 'links');
        onState({ status: 'loaded', findings });
      })
      .finally(() => {
        if (disposed) return;
        inFlight = false;
        controller = null;
        if (dirty) {
          dirty = false;
          load();
        }
      });
  };

  load();
  const unsubscribe = subscribeToDocumentsChanged((channels) => {
    if (channels.includes('backlinks') || invalidatesLocalTargetAudit(channels)) load();
  });
  return () => {
    disposed = true;
    controller?.abort();
    unsubscribe();
  };
}

export function useDocLinkFindings(docName: string | null): DocLinkFindingsState {
  const [owned, setOwned] = useState<{
    docName: string | null;
    state: DocLinkFindingsState;
  }>({ docName: null, state: { status: 'idle', findings: [] } });
  useEffect(() => {
    if (docName === null) {
      setOwned({ docName: null, state: { status: 'idle', findings: [] } });
      return;
    }
    // A new document starts unsettled with no carryover from the prior doc.
    setOwned({ docName, state: { status: 'loading', findings: [] } });
    return subscribeToDocLinkFindings(docName, (state) => setOwned({ docName, state }));
  }, [docName]);
  // Effects run after render. Owner-gating prevents the previous document's
  // findings and counts from painting during the first render of a new one.
  if (owned.docName !== docName) {
    return docName === null
      ? { status: 'idle', findings: [] }
      : { status: 'loading', findings: [] };
  }
  return owned.state;
}
