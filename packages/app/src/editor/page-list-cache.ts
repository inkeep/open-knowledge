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

export interface PageListCacheSnapshot {
  readonly pages: ReadonlySet<string>;
  readonly folderPaths: ReadonlySet<string>;
  /** Referenced, renderable assets from `/api/documents`, contentDir-relative. */
  readonly assetPaths?: ReadonlySet<string>;
  /**
   * Tracked non-markdown, non-asset files surfaced by `/api/documents` as
   * `kind:'file'`. Paths are contentDir-relative and
   * include the on-disk extension (e.g. `data/example.csv`). Consumed by
   * the wiki-link / markdown-link existence checks so a link to a
   * tracked non-markdown file renders as resolved instead of dead/red. Kept
   * separate from `assetPaths` because the asset set is renderable + carries
   * inbound-reference semantics; this set is plain "the server tracks this
   * file" — no media kind, no inbound graph.
   */
  readonly filePaths?: ReadonlySet<string>;
  /**
   * Raw frontmatter `icon:` values keyed by docName. Empty when no
   * docs carry an icon. Values are unclassified strings — consumers
   * call `resolvePageIcon` (in `components/page-header-utils.ts`) at
   * render time to determine kind (`emoji` / `url` / `path` /
   * `unsupported`). Surfaced for the wiki-link chip prefix; future
   * sidebar surfaces can read the same index.
   *
   * Optional for backward compat — the wiki-link chip tolerates an
   * absent map (treats every doc as iconless), so older snapshots
   * (and tests) keep working without populating it.
   */
  readonly pageIcons?: ReadonlyMap<string, string>;

  /**
   * Slug-keyed index: `toWikiLinkSlug(docName) → original docName`.
   * Populated alongside `pages` by `setPageListCache`. Enables O(1)
   * resolution for wiki-link targets that
   * arrive in slug form (e.g. dropped `.md` → target='readme' via
   * `buildUnresolvedWikiLinkAttrs` / `toWikiLinkSlug`) against
   * case-preserved + non-slug-form cache entries (`README`,
   * `BA_for_Depression_Research`). Handles both case-folding
   * (`README` → `readme`) and separator normalization (`_` / space
   * / punctuation → `-`) in one index. First-wins on slug collision —
   * if both `README.md` and `ReadMe.md` exist, resolver picks the
   * insertion-order-first entry (Map preserves insertion order).
   */
  readonly pagesBySlug: ReadonlyMap<string, string>;

  /**
   * Basename-keyed index: `toWikiLinkSlug(basename(docName)) → original docName`.
   * Sibling of `pagesBySlug`. Where `pagesBySlug` indexes the full
   * docName (path + leaf), this index keys on the leaf alone so a
   * bare-name wiki-link (`[[analysis]]`) resolves to a file living in
   * a subfolder (`andrew-data/project-x/analysis`). Optional for
   * backward compatibility — callers fall back to slug + exact match
   * when the index is absent.
   *
   * Tie-break is alphabetical-first by full docName: if two files
   * share a basename (`a/foo.md`, `b/foo.md`), the lexicographically
   * smaller path wins (`a/foo`). Matches `resolveWikiLinkAssetTarget`'s
   * basename-with-alphabetical-first behavior for assets.
   *
   * Consulted only after `pages.has` and `pagesBySlug.get` miss, and
   * only when the target contains no slash — `[[foo/bar]]` keeps
   * routing through exact/full-path resolution.
   */
  readonly pagesByBasename?: ReadonlyMap<string, string>;
}

type CacheListener = (snapshot: PageListCacheSnapshot) => void;

let currentSnapshot: PageListCacheSnapshot | null = null;
const listeners = new Set<CacheListener>();

/**
 * Returns true when two sets contain exactly the same members (order-independent).
 * O(n) — single pass after the cheap size comparison fails fast.
 */
export function setsEqual<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

/**
 * Pure helper — returns true when prev and next represent the same cache state
 * (same pages set content AND same folderPaths set content). Used by
 * setPageListCache to gate notify() and by tests.
 *
 * `pagesBySlug` and `pagesByBasename` are DERIVED from `pages` — when
 * `pages` is unchanged, both indices are also unchanged. The equality
 * check skips them on purpose; adding a Map equality would double-scan
 * without catching any state change `setsEqual(pages, ...)` misses.
 */
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

/**
 * Map-content equality for the icon index. O(n) — same shape as
 * `setsEqual` but compares values. Cheap because the map is small
 * (only docs with an `icon:` frontmatter entry) and most renders
 * yield content-equal maps.
 */
function pageIconsEqual(
  a: ReadonlyMap<string, string> | undefined,
  b: ReadonlyMap<string, string> | undefined,
): boolean {
  if (a === b) return true;
  const aSize = a?.size ?? 0;
  const bSize = b?.size ?? 0;
  if (aSize !== bSize) return false;
  if (aSize === 0) return true;
  // Both non-empty + same size — walk one and compare.
  for (const [key, value] of a as ReadonlyMap<string, string>) {
    if ((b as ReadonlyMap<string, string>).get(key) !== value) return false;
  }
  return true;
}

/**
 * Build the slug-keyed index from a pages set. First-wins on slug collision
 * (Map insertion order preserved; iteration order of a Set follows insertion
 * order per ES spec). Accepts the slug function as a parameter so this
 * module stays free of a `@inkeep/open-knowledge-core` import (the actual
 * slugger lives there); callers pass `toWikiLinkSlug`.
 *
 * Tie-break is deliberately insertion-order, not alphabetical — the slug
 * key already encodes the full docName, so collisions are rare and
 * insertion-order matches the Set's iteration semantics. The sibling
 * `buildPagesByBasenameIndex` sorts alphabetically before insertion
 * because basename collisions across folders are expected and the
 * alphabetical-first tie-break mirrors `resolveWikiLinkAssetTarget`'s
 * prior art for assets.
 */
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

/**
 * Build the basename-keyed index from a pages set. Keys by the slug of
 * each docName's leaf segment (the part after the last `/`). Sorts
 * input alphabetically before insertion so first-wins on basename
 * collision becomes alphabetical-first by full docName — matches the
 * tie-break in `resolveWikiLinkAssetTarget` for assets.
 */
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

/**
 * Project the `icon` field out of a PageMeta-shaped map into a flat
 * `docName → rawIconValue` map. Skips entries with an absent or blank
 * icon so consumers can tell "no icon set" apart from "icon set to
 * empty string". Sibling of `buildPagesBySlugIndex` — same idea:
 * derive a side-channel-friendly map from the React-context-owned
 * source-of-truth.
 */
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

/**
 * Synchronous accessor. Returns null until the first setPageListCache call
 * (which lands when PageListProvider first mounts and resolves /api/pages).
 * Consumers MUST handle the null case (treat as "all targets unresolved").
 */
export function getPageListCache(): PageListCacheSnapshot | null {
  return currentSnapshot;
}

/**
 * Writer. Replaces the current snapshot and notifies subscribers ONLY when the
 * content actually changed (Set-wise deep-equal). Idempotent when called with a
 * content-equal snapshot — safe to invoke on every React render.
 */
export function setPageListCache(snapshot: PageListCacheSnapshot): void {
  if (snapshotsEqual(currentSnapshot, snapshot)) return;
  currentSnapshot = snapshot;
  // Debug hook — tree-shaken out of production bundles per precedent #20(b).
  if (typeof window !== 'undefined' && import.meta.env?.DEV) {
    (window as unknown as { __okPageListCache?: PageListCacheSnapshot }).__okPageListCache =
      snapshot;
  }
  // Snapshot the listener set before iterating — a listener may synchronously
  // unsubscribe itself or register a new one from inside the callback, and
  // we must not mutate the Set we're iterating. Matches the docstring on
  // `subscribePageListCache`.
  for (const listener of Array.from(listeners)) {
    try {
      listener(snapshot);
    } catch (err) {
      // Subscriber throw MUST NOT abort sibling notifications. Single writer + many
      // readers means a bad plugin can't take down the provider.
      console.error('[page-list-cache] subscriber threw:', err);
    }
  }
}

/**
 * Register a listener that fires once immediately with the current snapshot
 * (if one exists) AND on every subsequent content change. Returns an unsubscribe
 * function. Safe to call `unsubscribe()` inside a listener (iteration is over
 * a copy of the Set).
 *
 * Firing-immediately-on-subscribe means PM plugins don't need a companion
 * getPageListCache() call — they receive the current state as part of the
 * subscribe result. If the cache is null at subscribe time, the listener is
 * NOT called until the first setPageListCache.
 */
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

/**
 * Test helper — resets the module to its initial state. Safe to call from
 * beforeEach/afterEach in unit tests so no state leaks across cases. Not
 * exported from the public barrel; imported directly by the colocated test.
 */
export function __resetPageListCacheForTests(): void {
  currentSnapshot = null;
  listeners.clear();
  if (typeof window !== 'undefined' && import.meta.env?.DEV) {
    delete (window as unknown as { __okPageListCache?: PageListCacheSnapshot }).__okPageListCache;
  }
}
