/**
 * Page-list side-channel for plain-DOM chip consumers.
 *
 * InternalLink + WikiLink chips render via renderHTML (PM layer, no React
 * context access). They still need live resolution-state classification —
 * `pages: Set<string>` + `folderPaths: Set<string>` — normally provided by
 * <PageListProvider /> via React context + usePageList().
 *
 * This module is the bridge:
 * - PageListProvider calls setPageListCache({pages, folderPaths, assetPaths}) on value change.
 * - Chip PM plugins call subscribePageListCache(fn) to dispatch decoration refresh
 *   when page list mutates; they read via getPageListCache() inside decorations(state).
 *
 * Design notes
 * ------------
 * - Change detection via Set-content equality so render-frequent setPageListCache
 *   calls with stable content don't storm subscribers. Single writer (provider);
 *   many readers (PM plugins). No locking required — React renders and PM plugin
 *   dispatches both run on the main thread synchronously.
 * - Reads are synchronous + cheap. Subscribers receive the snapshot on invocation
 *   so they don't need a separate getPageListCache() call.
 * - DEV-only `window.__okPageListCache` write (gated on import.meta.env?.DEV per
 *   the repo's DEV-gated test-hook convention — precedent #20(b)). Debug-visible
 *   in devtools; stripped in production bundles.
 *
 * Scope carve-outs
 * ----------------
 * - This module is purely a store. The PageListProvider → setPageListCache
 *   wiring lives in `PageListContext.tsx` (a useEffect that publishes
 *   {pages, folderPaths} on every render — no-ops absorbed by the equality gate).
 * - Consumer renderDecorationRefresh is a separate concern (the PM plugin in
 *   internal-link.ts will subscribe here and dispatch a transaction carrying
 *   a custom meta to force mark-identity-decoration re-run).
 *
 * @see packages/app/src/editor/extensions/mark-identity-decoration.ts
 * @see packages/app/src/editor/extensions/mark-interaction-bridge.ts
 */

import { buildPagesByBasenameIndex, buildPagesBySlugIndex } from '@inkeep/open-knowledge-core';

export { buildPagesByBasenameIndex, buildPagesBySlugIndex };

export interface PageListCacheSnapshot {
  readonly pages: ReadonlySet<string>;
  readonly folderPaths: ReadonlySet<string>;
  readonly assetPaths?: ReadonlySet<string>;
  readonly filePaths?: ReadonlySet<string>;
  readonly pageIcons?: ReadonlyMap<string, string>;

  readonly pagesBySlug: ReadonlyMap<string, string>;

  readonly pagesByBasename?: ReadonlyMap<string, string>;
}

type CacheListener = (snapshot: PageListCacheSnapshot) => void;

let currentSnapshot: PageListCacheSnapshot | null = null;
const listeners = new Set<CacheListener>();

export function setsEqual<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

export function snapshotsEqual(
  prev: PageListCacheSnapshot | null,
  next: PageListCacheSnapshot,
): boolean {
  if (prev === null) return false;
  if (prev === next) return true;
  return (
    setsEqual(prev.pages, next.pages) &&
    setsEqual(prev.folderPaths, next.folderPaths) &&
    setsEqual(prev.assetPaths ?? new Set(), next.assetPaths ?? new Set()) &&
    setsEqual(prev.filePaths ?? new Set(), next.filePaths ?? new Set()) &&
    pageIconsEqual(prev.pageIcons, next.pageIcons)
  );
}

function pageIconsEqual(
  a: ReadonlyMap<string, string> | undefined,
  b: ReadonlyMap<string, string> | undefined,
): boolean {
  if (a === b) return true;
  const aSize = a?.size ?? 0;
  const bSize = b?.size ?? 0;
  if (aSize !== bSize) return false;
  if (aSize === 0) return true;
  for (const [key, value] of a as ReadonlyMap<string, string>) {
    if ((b as ReadonlyMap<string, string>).get(key) !== value) return false;
  }
  return true;
}

export function buildPageIconsIndex(
  pageMeta: ReadonlyMap<string, { icon?: string }>,
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const [docName, meta] of pageMeta) {
    const raw = meta.icon;
    if (typeof raw === 'string' && raw.trim() !== '') {
      index.set(docName, raw);
    }
  }
  return index;
}

export function getPageListCache(): PageListCacheSnapshot | null {
  return currentSnapshot;
}

export function setPageListCache(snapshot: PageListCacheSnapshot): void {
  if (snapshotsEqual(currentSnapshot, snapshot)) return;
  currentSnapshot = snapshot;
  // Debug hook — tree-shaken out of production bundles per precedent #20(b).
  if (typeof window !== 'undefined' && import.meta.env?.DEV) {
    (window as unknown as { __okPageListCache?: PageListCacheSnapshot }).__okPageListCache =
      snapshot;
  }
  for (const listener of Array.from(listeners)) {
    try {
      listener(snapshot);
    } catch (err) {
      console.error('[page-list-cache] subscriber threw:', err);
    }
  }
}

export function subscribePageListCache(listener: CacheListener): () => void {
  listeners.add(listener);
  if (currentSnapshot !== null) {
    try {
      listener(currentSnapshot);
    } catch (err) {
      console.error('[page-list-cache] subscriber threw on replay:', err);
    }
  }
  return () => {
    listeners.delete(listener);
  };
}

export function __resetPageListCacheForTests(): void {
  currentSnapshot = null;
  listeners.clear();
  if (typeof window !== 'undefined' && import.meta.env?.DEV) {
    delete (window as unknown as { __okPageListCache?: PageListCacheSnapshot }).__okPageListCache;
  }
}
