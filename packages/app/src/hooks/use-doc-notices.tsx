import {
  DismissDocNoticeSuccessSchema,
  DocNoticesSuccessSchema,
  type DocNoticeWire,
} from '@inkeep/open-knowledge-core/schemas/api';
import { createContext, type ReactNode, use, useEffect, useRef, useState } from 'react';
import { subscribeToBranchChanged, subscribeToDocumentsChanged } from '@/lib/documents-events';

const DOC_NOTICES_REQUEST_TIMEOUT_MS = 5_000;

export async function fetchDocNotices(): Promise<DocNoticeWire[] | null> {
  try {
    const res = await fetch('/api/doc-notices', {
      signal: AbortSignal.timeout(DOC_NOTICES_REQUEST_TIMEOUT_MS),
    });
    const parsed = DocNoticesSuccessSchema.safeParse(await res.json().catch(() => null));
    if (!res.ok || !parsed.success) {
      console.warn(
        JSON.stringify({
          event: 'doc-notices-fetch-failed',
          status: res.status,
          detail: res.ok ? 'schema-drift' : undefined,
        }),
      );
      return null;
    }
    return parsed.data.notices;
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: 'doc-notices-fetch-failed',
        status: null,
        detail: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

export async function dismissDocNotice(docName: string, id: string): Promise<boolean> {
  try {
    const res = await fetch('/api/doc-notices/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docName, id }),
      signal: AbortSignal.timeout(DOC_NOTICES_REQUEST_TIMEOUT_MS),
    });
    const parsed = DismissDocNoticeSuccessSchema.safeParse(await res.json().catch(() => null));
    return res.ok && parsed.success;
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: 'doc-notice-dismiss-failed',
        detail: err instanceof Error ? err.message : String(err),
      }),
    );
    return false;
  }
}

interface DocNoticesContextValue {
  byDocName: ReadonlyMap<string, DocNoticeWire>;
  dismiss: (notice: DocNoticeWire) => void;
}

const DocNoticesContext = createContext<DocNoticesContextValue | null>(null);

function indexByDocName(notices: readonly DocNoticeWire[]): ReadonlyMap<string, DocNoticeWire> {
  return new Map(notices.map((notice) => [notice.docName, notice]));
}

export function DocNoticesProvider({ children }: { children: ReactNode }) {
  const [byDocName, setByDocName] = useState<ReadonlyMap<string, DocNoticeWire>>(() => new Map());
  const latestRequestId = useRef(0);

  function refresh() {
    const requestId = ++latestRequestId.current;
    void fetchDocNotices().then((notices) => {
      if (notices === null || requestId !== latestRequestId.current) return;
      setByDocName(indexByDocName(notices));
    });
  }

  function dismiss(notice: DocNoticeWire) {
    latestRequestId.current++;
    setByDocName((previous) => {
      const next = new Map(previous);
      if (next.get(notice.docName)?.id === notice.id) next.delete(notice.docName);
      return next;
    });
    void dismissDocNotice(notice.docName, notice.id).then((dismissed) => {
      if (!dismissed) refresh();
    });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is intentionally stable (defined in hook scope)
  useEffect(() => {
    refresh();
    const unsubscribeChannels = subscribeToDocumentsChanged((channels) => {
      if (channels.includes('sync-status')) refresh();
    });
    const unsubscribeBranch = subscribeToBranchChanged(() => refresh());
    return () => {
      unsubscribeChannels();
      unsubscribeBranch();
    };
  }, []);

  return <DocNoticesContext value={{ byDocName, dismiss }}>{children}</DocNoticesContext>;
}

export function useDocNotice(docName: string | null): {
  notice: DocNoticeWire | null;
  dismiss: (notice: DocNoticeWire) => void;
} {
  const value = use(DocNoticesContext);
  if (value === null || docName === null) return { notice: null, dismiss: () => {} };
  return { notice: value.byDocName.get(docName) ?? null, dismiss: value.dismiss };
}
