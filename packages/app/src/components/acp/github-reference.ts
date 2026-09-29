import {
  type GitHubReferencePreview,
  GitHubReferenceResponseSchema,
} from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';

const REFERENCE_PATH =
  /^\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}\/(?:pull|issues)\/\d{1,10}(?:\/[^?#]*)?$/;

const CACHE_TTL_MS = 60_000;

const CACHE_MAX_ENTRIES = 128;

const cache = new Map<string, { preview: GitHubReferencePreview | null; expiresAt: number }>();

const inflight = new Map<string, Promise<GitHubReferencePreview | null>>();

export function isGitHubReferenceHref(href: string | undefined): href is string {
  if (href === undefined) return false;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && REFERENCE_PATH.test(url.pathname);
}

function remember(url: string, preview: GitHubReferencePreview | null): void {
  cache.delete(url);
  cache.set(url, { preview, expiresAt: Date.now() + CACHE_TTL_MS });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function requestGitHubReference(url: string): Promise<GitHubReferencePreview | null> {
  const res = await fetch('/api/github-reference', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) return null;
  const parsed = GitHubReferenceResponseSchema.safeParse(await res.json());
  return parsed.success && parsed.data.ok ? parsed.data.preview : null;
}

export function loadGitHubReference(url: string): Promise<GitHubReferencePreview | null> {
  const hit = cache.get(url);
  if (hit !== undefined && hit.expiresAt > Date.now()) return Promise.resolve(hit.preview);
  const pending = inflight.get(url);
  if (pending !== undefined) return pending;
  const promise = (async () => {
    try {
      const preview = await requestGitHubReference(url);
      remember(url, preview);
      return preview;
    } catch (err) {
      console.warn(
        '[github-reference] preview fetch failed:',
        err instanceof Error ? err.message : String(err),
      );
      return null;
    } finally {
      inflight.delete(url);
    }
  })();
  inflight.set(url, promise);
  return promise;
}

export function useGitHubReference(url: string | null): GitHubReferencePreview | null {
  const [entry, setEntry] = useState<{ url: string; preview: GitHubReferencePreview } | null>(null);
  useEffect(() => {
    if (url === null) return;
    let ignore = false;
    void loadGitHubReference(url).then((preview) => {
      if (!ignore && preview !== null) setEntry({ url, preview });
    });
    return () => {
      ignore = true;
    };
  }, [url]);
  return url !== null && entry?.url === url ? entry.preview : null;
}
