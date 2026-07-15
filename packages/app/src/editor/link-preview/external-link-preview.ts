/**
 * Data layer for the external link-preview card. Sends the hovered URL to the
 * local server's `POST /api/link-preview`, which performs the SSRF-guarded
 * outbound fetch and returns sanitized metadata (or a bounded failure reason).
 * The renderer never fetches the remote site directly — this call reaches only
 * the user's own local process.
 *
 * A previewed URL is held in a per-session success cache so a re-hover renders
 * with no visible loading. The cache is a small bounded LRU (Map insertion
 * order = recency, the same trick as the server's preview-cache): entries can
 * carry a base64 favicon data URI, so an unbounded map would grow renderer
 * memory for the life of a long desktop session. Failures are deliberately NOT
 * cached: the server
 * already negative-caches dead links, and not caching here lets a transient
 * failure recover on the next hover without sticking for the session. Concurrent
 * identical hovers coalesce to a single request via the in-flight map.
 *
 * Every non-success path resolves to `null` (the card renders only on success,
 * so `null` leaves today's URL pill untouched — the zero-regression contract).
 */

import { type LinkPreviewMetadata, LinkPreviewResponseSchema } from '@inkeep/open-knowledge-core';

/** Success-cache bound; exported so the eviction test stays in sync. */
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
  // A non-2xx is a gate/body-shape rejection (e.g. the null-origin 403 on the
  // packaged desktop build) — treat as "no preview", fall back to the pill.
  if (!res.ok) return null;
  const parsed = LinkPreviewResponseSchema.safeParse(await res.json());
  if (!parsed.success || !parsed.data.ok) return null;
  return parsed.data.metadata;
}

/**
 * Load the preview metadata for an external URL, or `null` on any failure,
 * guard rejection, or abort. Cached (success only) + single-flight. The caller's
 * `signal` cancels the underlying request on hover-out / navigation.
 */
export function loadLinkPreview(
  url: string,
  signal?: AbortSignal,
): Promise<LinkPreviewMetadata | null> {
  const cached = successCache.get(url);
  if (cached) {
    // LRU touch: delete-and-reinsert so the oldest key stays at the Map front.
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
      // Abort (hover-out / navigation) and network errors both land here — the
      // request never yielded an outcome, so nothing is cached and the next
      // hover retries. A genuine fault is surfaced; an expected hover-out abort
      // stays silent.
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
