/**
 * Single-flight coordinator for the full `GET /api/documents` listing.
 *
 * Several consumers independently fetch the same plain `/api/documents`
 * (the full, non-`depth=1` walk): `PageListContext` (asset/folder/file path
 * sets), `EmptyEditorState` (entry count for the onboarding branch), and the
 * wiki-link suggestion source (referenced assets). On boot and on every CC1
 * `files` push they fire within the same tick, so the server runs the same
 * `ready`-gated disk walk two or three times concurrently.
 *
 * This coalesces those overlapping calls into one in-flight request + one JSON
 * parse, shared by every caller awaiting it. It is single-flight, NOT a result
 * cache: the slot is released as soon as the request settles (success or
 * failure), so the next call after settlement always fetches fresh — consumers
 * that refetch on a `files` push still get current data, never a stale snapshot.
 *
 * The parsed body is returned untyped so each caller keeps its own
 * schema-validation + error handling exactly as before (one caller throws on
 * `!ok`, another falls back to a default count); the helper only owns the
 * network round-trip and the `.json()` parse.
 *
 * FileTree's sidebar fetch is intentionally NOT routed here — it uses a
 * different URL (`?showAll=true&dir=&depth=1`, lazy per-level) and must stay on
 * its own request so the depth-1 lazy-loading contract is unchanged.
 */

export interface DocumentListFetchResult {
  ok: boolean;
  status: number;
  /** Parsed JSON body, or `null` if the response was not valid JSON. */
  body: unknown;
}

let inflight: Promise<DocumentListFetchResult> | null = null;

/**
 * Fetch the full `/api/documents` listing, coalescing concurrent callers onto a
 * single in-flight request. Resolves with `{ ok, status, body }`; rejects only
 * if the underlying `fetch` itself rejects (network error), which every caller
 * already guards with try/catch.
 */
export function fetchDocumentListShared(): Promise<DocumentListFetchResult> {
  if (inflight) return inflight;
  const pending = (async (): Promise<DocumentListFetchResult> => {
    const res = await fetch('/api/documents');
    // A 200 with a non-JSON body (proxy error page, truncated response) is a
    // real trust-boundary failure — log it here so the seam is diagnosable
    // rather than each consumer silently degrading on an opaque `null` body.
    const body = (await res.json().catch((err: unknown) => {
      console.warn('[documents-fetch] /api/documents response was not valid JSON:', err);
      return null;
    })) as unknown;
    return { ok: res.ok, status: res.status, body };
  })();
  inflight = pending;
  // Release the slot once settled so the next call issues a fresh request.
  // Guard on identity so a slower previous request can't clear a newer one.
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

/** Test-only: reset the in-flight slot between cases. */
export function __resetDocumentListInflightForTests(): void {
  inflight = null;
}
