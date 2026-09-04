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

type WireDiagnostic = ValidationDocResult['diagnostics'][number];

export type AuditScope =
  | { kind: 'project' }
  | { kind: 'path'; path: string }
  | { kind: 'doc'; docName: string };

export const AUDIT_SUPERSEDED = 'audit-superseded' as const;

export async function runValidationAudit(
  scope: AuditScope = { kind: 'project' },
  signal?: AbortSignal,
): Promise<ValidationAuditResponse | null | typeof AUDIT_SUPERSEDED> {
  return fetchAudit(scope, ValidationAuditResponseSchema, false, signal);
}

export async function runValidationAuditCounts(
  scope: AuditScope = { kind: 'project' },
  signal?: AbortSignal,
): Promise<ValidationAuditCountsResponse | null | typeof AUDIT_SUPERSEDED> {
  return fetchAudit(scope, ValidationAuditCountsResponseSchema, true, signal);
}

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
      if (res.status === 409) return AUDIT_SUPERSEDED;
      console.warn('[audit] request failed', res.status, res.statusText);
      return null;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      if (signal?.aborted === true) return null;
      console.warn('[audit] response body is not valid JSON');
      return null;
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      console.warn('[audit] response failed schema validation', parsed.error.issues);
      return null;
    }
    return parsed.data;
  } catch (err) {
    if (signal?.aborted === true) return null;
    console.warn('[audit] fetch threw', err);
    return null;
  }
}

export type DocLinkFindingsState =
  | { status: 'idle'; findings: readonly WireDiagnostic[] }
  | { status: 'loading'; findings: readonly WireDiagnostic[] }
  | { status: 'loaded'; findings: readonly WireDiagnostic[] }
  | { status: 'failed'; findings: readonly WireDiagnostic[] };

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
    setOwned({ docName, state: { status: 'loading', findings: [] } });
    return subscribeToDocLinkFindings(docName, (state) => setOwned({ docName, state }));
  }, [docName]);
  if (owned.docName !== docName) {
    return docName === null
      ? { status: 'idle', findings: [] }
      : { status: 'loading', findings: [] };
  }
  return owned.state;
}
