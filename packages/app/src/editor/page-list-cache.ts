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

export function buildPagesBySlugIndex(
  pages: ReadonlySet<string>,
  slugFn: (text: string) => string,
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const page of pages) {
    const key = slugFn(page);
    if (key && !index.has(key)) index.set(key, page);
  }
  return index;
}

export function buildPagesByBasenameIndex(
  pages: ReadonlySet<string>,
  slugFn: (text: string) => string,
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  const sorted = [...pages].sort((a, b) => a.localeCompare(b));
  for (const page of sorted) {
    const slash = page.lastIndexOf('/');
    const basename = slash === -1 ? page : page.slice(slash + 1);
    const key = slugFn(basename);
    if (key && !index.has(key)) index.set(key, page);
  }
  return index;
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
