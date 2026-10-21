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

type NoticesByDocName = ReadonlyMap<string, readonly DocNoticeWire[]>;

interface DocNoticesContextValue {
  byDocName: NoticesByDocName;
  dismiss: (notice: DocNoticeWire) => void;
}

const DocNoticesContext = createContext<DocNoticesContextValue | null>(null);

const NO_NOTICES: readonly DocNoticeWire[] = [];

function indexByDocName(notices: readonly DocNoticeWire[]): NoticesByDocName {
  const byDocName = new Map<string, DocNoticeWire[]>();
  for (const notice of notices) {
    const forDoc = byDocName.get(notice.docName) ?? [];
    forDoc.push(notice);
    byDocName.set(notice.docName, forDoc);
  }
  for (const forDoc of byDocName.values()) {
    forDoc.sort((a, b) => Number(b.kind === 'save-held') - Number(a.kind === 'save-held'));
  }
  return byDocName;
}

export function DocNoticesProvider({ children }: { children: ReactNode }) {
  const [byDocName, setByDocName] = useState<NoticesByDocName>(() => new Map());
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
      const remaining = (next.get(notice.docName) ?? NO_NOTICES).filter(
        (shown) => shown.id !== notice.id,
      );
      if (remaining.length === 0) next.delete(notice.docName);
      else next.set(notice.docName, remaining);
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

export function useDocNotices(docName: string | null): {
  notices: readonly DocNoticeWire[];
  dismiss: (notice: DocNoticeWire) => void;
} {
  const value = use(DocNoticesContext);
  if (value === null || docName === null) return { notices: NO_NOTICES, dismiss: () => {} };
  return { notices: value.byDocName.get(docName) ?? NO_NOTICES, dismiss: value.dismiss };
}
