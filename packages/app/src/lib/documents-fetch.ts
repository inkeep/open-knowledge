export interface DocumentListFetchResult {
  ok: boolean;
  status: number;
  body: unknown;
}

let inflight: Promise<DocumentListFetchResult> | null = null;

export function fetchDocumentListShared(): Promise<DocumentListFetchResult> {
  if (inflight) return inflight;
  const pending = (async (): Promise<DocumentListFetchResult> => {
    const res = await fetch('/api/documents');
    const body = (await res.json().catch((err: unknown) => {
      console.warn('[documents-fetch] /api/documents response was not valid JSON:', err);
      return null;
    })) as unknown;
    return { ok: res.ok, status: res.status, body };
  })();
  inflight = pending;
  void pending.then(
    () => {
      if (inflight === pending) inflight = null;
    },
    () => {
      if (inflight === pending) inflight = null;
    },
  );
  return pending;
}

export function __resetDocumentListInflightForTests(): void {
  inflight = null;
}
