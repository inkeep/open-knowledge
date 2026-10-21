import { DOCUMENT_REFRESH_MAX_DOCS } from '@inkeep/open-knowledge-core/schemas/api';

function warnRefreshFailed(details: Record<string, unknown>): void {
  console.warn(JSON.stringify({ event: 'ok-document-refresh-request-failed', ...details }));
}

export async function refreshDocumentsFromDisk(
  docNames: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  for (let start = 0; start < docNames.length; start += DOCUMENT_REFRESH_MAX_DOCS) {
    const batch = docNames.slice(start, start + DOCUMENT_REFRESH_MAX_DOCS);
    try {
      const response = await fetchImpl('/api/documents/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docNames: batch }),
      });
      if (!response.ok) warnRefreshFailed({ docCount: batch.length, status: response.status });
    } catch (err) {
      warnRefreshFailed({
        docCount: batch.length,
        message: String(err instanceof Error ? err.message : err),
      });
    }
  }
}
