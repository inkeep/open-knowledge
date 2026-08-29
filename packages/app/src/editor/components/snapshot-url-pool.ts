/**
 * Bounded registry of live snapshot blob URLs, shared by by-reference
 * renderers that paint exported images (today: the Excalidraw embed).
 *
 * Why not revoke in effect cleanup: under `<Activity mode="hidden">`
 * effects unmount while the `<img>` (DOM + refs kept) still shows the
 * URL, and React gives an effect no way to distinguish hide from true
 * unmount — so per-embed cleanup cannot revoke safely, and true-unmount
 * orphans need reclaiming somewhere else. This pool is that somewhere.
 *
 * Eviction is liveness-aware, not purely positional: past the cap, the
 * oldest entry is revoked ONLY if no `<img>` in the document (visible or
 * `display:none` under a hidden Activity) is still bound to it — a
 * still-bound entry is requeued behind the newcomers instead. The
 * invariant the pool actually provides: a DOM-bound URL is never revoked;
 * the outstanding set is bounded by max(cap, currently-DOM-bound URLs).
 * The cap follows `LIVE_DOC_POOL_MAX` — the same constant that bounds how
 * many live references can be painting concurrently.
 */

import { LIVE_DOC_POOL_MAX } from './live-doc-pool.ts';

export const MAX_LIVE_SNAPSHOT_URLS = LIVE_DOC_POOL_MAX;

const liveSnapshotUrls: string[] = [];

function isDomBound(url: string): boolean {
  if (typeof document === 'undefined') return false;
  // Blob URLs are globally unique strings, so attribute equality is an
  // exact liveness probe — and it sees `display:none` subtrees, which is
  // precisely the hidden-Activity case cleanup can't. A plain scan over
  // `document.images` avoids selector-escaping concerns entirely.
  for (const img of document.images) {
    if (img.getAttribute('src') === url) return true;
  }
  return false;
}

/** Register a freshly minted snapshot URL, reclaiming old orphans. */
export function retainSnapshotUrl(url: string): void {
  liveSnapshotUrls.push(url);
  let scans = 0;
  while (liveSnapshotUrls.length > MAX_LIVE_SNAPSHOT_URLS && scans < liveSnapshotUrls.length) {
    const oldest = liveSnapshotUrls.shift();
    if (!oldest) break;
    scans += 1;
    if (isDomBound(oldest)) {
      // Still on screen (or kept alive under a hidden Activity) — requeue
      // behind the newcomers rather than break a displayed image. A fully
      // claimed pool grows instead of spinning; the scan bound guarantees
      // termination.
      liveSnapshotUrls.push(oldest);
      continue;
    }
    URL.revokeObjectURL(oldest);
  }
}

/** Release a URL its owner replaced — it is no longer shown anywhere. */
export function releaseSnapshotUrl(url: string): void {
  const idx = liveSnapshotUrls.indexOf(url);
  if (idx >= 0) liveSnapshotUrls.splice(idx, 1);
  URL.revokeObjectURL(url);
}

/** Test-only visibility into pool occupancy (never mutate through this). */
export function __liveSnapshotUrlCount(): number {
  return liveSnapshotUrls.length;
}

/** Test-only: revoke and forget everything (module state has no other
 *  reset, and rendering suites would otherwise accumulate orphans across
 *  files until eviction fires mid-test). */
export function __resetSnapshotUrlPoolForTests(): void {
  for (const url of liveSnapshotUrls) URL.revokeObjectURL(url);
  liveSnapshotUrls.length = 0;
}

if (import.meta.hot) {
  // Same contract as the sibling pools: editing a consumer in dev must not
  // strand the old module instance's blob URLs.
  import.meta.hot.dispose(() => {
    __resetSnapshotUrlPoolForTests();
  });
}
