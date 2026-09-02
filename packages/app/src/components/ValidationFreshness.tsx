import { useEffect, useLayoutEffect, useRef } from 'react';
import { useOptionalPageList } from '@/components/PageListContext';
import { setLinkValidationVisible } from '@/editor/link-validation-policy';
import { subscribeToLintConfigChanged } from '@/editor/lint-config-client';
import {
  AUDIT_SUPERSEDED,
  runValidationAudit,
  runValidationAuditCounts,
} from '@/editor/validation-audit-client';
import { useConfigContext } from '@/lib/config-provider';
import { filePathToDocName } from '@/lib/doc-hash';
import {
  invalidatesLocalTargetAudit,
  subscribeToBranchChanged,
  subscribeToDocPersisted,
  subscribeToDocumentsChanged,
} from '@/lib/documents-events';
import { patchDocValidationFromAudit, replaceValidationFromCounts } from '@/lib/validation-store';

const REVALIDATE_DEBOUNCE_MS = 500;

const PLANE_AUDIT_DEBOUNCE_MS = 750;

const AUDIT_ON_OPEN_DELAY_MS = 1_200;

const AUDIT_ON_OPEN_MAX_ATTEMPTS = 3;
const AUDIT_ON_OPEN_RETRY_MS = 1_500;

function isAuditableDocName(docName: string): boolean {
  return !docName.startsWith('__') && !/\.(mmd|mermaid)$/i.test(docName);
}

async function auditProjectIntoStore(signal: AbortSignal): Promise<boolean> {
  const result = await runValidationAuditCounts({ kind: 'project' }, signal);
  if (signal.aborted || result === null || result === AUDIT_SUPERSEDED) return false;
  replaceValidationFromCounts(result.files);
  return true;
}

export function ValidationFreshness() {
  const { merged } = useConfigContext();
  const indicatorsEnabled = merged?.validation?.fileTreeIndicators !== false;
  const linksVisible = merged?.validation?.links !== 'off';
  useLayoutEffect(() => setLinkValidationVisible(linksVisible), [linksVisible]);
  const pageCount = useOptionalPageList()?.pages.size ?? 0;
  const ranOnOpenRef = useRef(false);

  useEffect(() => {
    if (!indicatorsEnabled) return;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    let disposed = false;

    const revalidate = (docName: string) => {
      void runValidationAudit({ kind: 'doc', docName }).then((result) => {
        if (disposed || result === null || result === AUDIT_SUPERSEDED) return;
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

  useEffect(() => {
    if (!indicatorsEnabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: AbortController | null = null;

    const runAudit = () => {
      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;
      void auditProjectIntoStore(controller.signal).finally(() => {
        if (inFlight === controller) inFlight = null;
      });
    };

    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        runAudit();
      }, PLANE_AUDIT_DEBOUNCE_MS);
    };

    const unsubscribers = [
      subscribeToLintConfigChanged(schedule),
      subscribeToBranchChanged(schedule),
      subscribeToDocumentsChanged((channels) => {
        if (invalidatesLocalTargetAudit(channels)) schedule();
      }),
    ];

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      if (timer !== null) clearTimeout(timer);
      inFlight?.abort();
    };
  }, [indicatorsEnabled]);

  useEffect(() => {
    if (!indicatorsEnabled) return;
    if (pageCount === 0 || ranOnOpenRef.current) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;

    const attempt = () => {
      timer = null;
      void auditProjectIntoStore(controller.signal).then((wrote) => {
        if (wrote) {
          ranOnOpenRef.current = true;
          return;
        }
        if (controller.signal.aborted) return;
        failures += 1;
        if (failures >= AUDIT_ON_OPEN_MAX_ATTEMPTS) {
          console.warn('[audit] on-open audit exhausted retries; file-tree counts unavailable');
          return;
        }
        timer = setTimeout(attempt, AUDIT_ON_OPEN_RETRY_MS * 2 ** (failures - 1));
      });
    };

    timer = setTimeout(attempt, AUDIT_ON_OPEN_DELAY_MS);
    return () => {
      if (timer !== null) clearTimeout(timer);
      controller.abort();
    };
  }, [indicatorsEnabled, pageCount]);

  return null;
}
