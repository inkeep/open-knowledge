import { type LinkPreviewMetadata, LinkPreviewResponseSchema } from '@inkeep/open-knowledge-core';

export const SUCCESS_CACHE_MAX_ENTRIES = 128;

const successCache = new Map<string, LinkPreviewMetadata>();
const inflight = new Map<string, Promise<LinkPreviewMetadata | null>>();

async function requestLinkPreview(
  url: string,
  signal: AbortSignal | undefined,
): Promise<LinkPreviewMetadata | null> {
  const res = await fetch('/api/link-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal,
  });
  if (!res.ok) return null;
  const parsed = LinkPreviewResponseSchema.safeParse(await res.json());
  if (!parsed.success || !parsed.data.ok) return null;
  return parsed.data.metadata;
}

export function loadLinkPreview(
  url: string,
  signal?: AbortSignal,
): Promise<LinkPreviewMetadata | null> {
  const cached = successCache.get(url);
  if (cached) {
    successCache.delete(url);
    successCache.set(url, cached);
    return Promise.resolve(cached);
  }

  const existing = inflight.get(url);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const metadata = await requestLinkPreview(url, signal);
      if (metadata) {
        successCache.set(url, metadata);
        while (successCache.size > SUCCESS_CACHE_MAX_ENTRIES) {
          const oldest = successCache.keys().next().value;
          if (oldest === undefined) break;
          successCache.delete(oldest);
        }
      }
      return metadata;
    } catch (err) {
      if (!(err instanceof Error) || err.name !== 'AbortError') {
        console.warn(
          '[link-preview] external preview fetch failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
      return null;
    } finally {
      inflight.delete(url);
    }
  })();
  inflight.set(url, promise);
  return promise;
}
