import { LIVE_DOC_POOL_MAX } from './live-doc-pool.ts';

export const MAX_LIVE_SNAPSHOT_URLS = LIVE_DOC_POOL_MAX;

const liveSnapshotUrls: string[] = [];

function isDomBound(url: string): boolean {
  if (typeof document === 'undefined') return false;
  for (const img of document.images) {
    if (img.getAttribute('src') === url) return true;
  }
  return false;
}

export function retainSnapshotUrl(url: string): void {
  liveSnapshotUrls.push(url);
  let scans = 0;
  while (liveSnapshotUrls.length > MAX_LIVE_SNAPSHOT_URLS && scans < liveSnapshotUrls.length) {
    const oldest = liveSnapshotUrls.shift();
    if (!oldest) break;
    scans += 1;
    if (isDomBound(oldest)) {
      liveSnapshotUrls.push(oldest);
      continue;
    }
    URL.revokeObjectURL(oldest);
  }
}

export function releaseSnapshotUrl(url: string): void {
  const idx = liveSnapshotUrls.indexOf(url);
  if (idx >= 0) liveSnapshotUrls.splice(idx, 1);
  URL.revokeObjectURL(url);
}

export function __liveSnapshotUrlCount(): number {
  return liveSnapshotUrls.length;
}

export function __resetSnapshotUrlPoolForTests(): void {
  for (const url of liveSnapshotUrls) URL.revokeObjectURL(url);
  liveSnapshotUrls.length = 0;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    __resetSnapshotUrlPoolForTests();
  });
}
