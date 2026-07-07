import { getHeadingSlug, toWikiLinkSlug } from '@inkeep/open-knowledge-core';
import type { PageListCacheSnapshot } from '../page-list-cache';

export { getHeadingSlug, toWikiLinkSlug };

/**
 * Input shape accepted by resolution helpers. A bare `Set<string>` works
 * for tests and legacy callers — the helper derives the slug index on the
 * fly (O(n) per call with a slug computation each). A `PageListCacheSnapshot`
 * carries a precomputed `pagesBySlug` map — O(1) lookup. React components
 * that consume `usePageList()` typically pass the bare `pages` Set; chip
 * PM plugins that read `getPageListCache()` pass the snapshot.
 */
type PagesLookupInput = ReadonlySet<string> | PageListCacheSnapshot;

function isSnapshot(input: PagesLookupInput): input is PageListCacheSnapshot {
  return 'pagesBySlug' in input;
}

function getPagesSet(input: PagesLookupInput): ReadonlySet<string> {
  return isSnapshot(input) ? input.pages : input;
}

function getAssetPathsSet(input: PagesLookupInput, assetPaths?: ReadonlySet<string>) {
  return isSnapshot(input) ? (input.assetPaths ?? new Set<string>()) : (assetPaths ?? new Set());
}

/**
 * The file-paths set (`kind:'file'` rows from
 * `/api/documents` — tracked non-markdown, non-asset files). When the input is
 * a snapshot, pull the optional set off it; bare-Set callers can pass it as an
 * explicit override. Returns an empty Set on absence so the membership-check
 * sites never need to nil-guard.
 */
function getFilePathsSet(input: PagesLookupInput, filePaths?: ReadonlySet<string>) {
  return isSnapshot(input) ? (input.filePaths ?? new Set<string>()) : (filePaths ?? new Set());
}

/**
 * Look up a target by slug against the pages set / snapshot. Returns the
 * original docName on match, or undefined when no entry's slug matches
 * the target's slug.
 *
 * `buildUnresolvedWikiLinkAttrs` stores the lowercased slug as the PM
 * wikiLink target. The page cache keeps
 * case-preserved + non-slug-form docNames (`README`,
 * `BA_for_Depression_Research`). Without a slug-based fallback,
 * `pages.has('readme')` and `pages.has('ba-for-depression-research')`
 * never match, so every dropped `.md` file + hand-typed `[[README]]`
 * (via the suggestion-menu fallback path that also slugs) shows
 * "Page not found".
 *
 * `targetSlug` is the slug of `target` — if target is already in slug
 * form, it equals the input. Both branches use the slug as the lookup
 * key, so `README` and `readme` and `Readme` all resolve to the same
 * cache entry.
 */
function slugLookup(target: string, input: PagesLookupInput): string | undefined {
  const targetSlug = toWikiLinkSlug(target);
  if (!targetSlug) return undefined;
  if (isSnapshot(input)) {
    return input.pagesBySlug.get(targetSlug);
  }
  // Bare Set — O(n) scan with slug computation per entry. Acceptable for
  // PropPanel / non-hot-path callers (tests, one-off resolutions).
  for (const page of input) {
    if (toWikiLinkSlug(page) === targetSlug) return page;
  }
  return undefined;
}

/**
 * Look up a bare-name target by basename across the pages set / snapshot.
 * Returns the original docName on match, or undefined when no entry's
 * basename slug matches. Mirrors the basename fallback in
 * `resolveNavigationTarget` so the chip's icon + resolved-state classifier
 * stays in sync with navigation: `[[analysis]]` chip renders as resolved
 * when `andrew-data/.../analysis.md` exists, not as "Page not found".
 *
 * Targets containing `/` skip this branch (explicit-path intent —
 * `[[bar/foo]]` should not silently rewrite to `baz/foo`).
 *
 * Alphabetical-first tie-break: both the snapshot fast path
 * (`pagesByBasename`, built by `buildPagesByBasenameIndex` which sorts
 * pages with `localeCompare` before insertion) and the bare-`Set`
 * fallback below (linear scan with `localeCompare`-based min-tracking)
 * use the same default-locale comparator, so the two branches resolve
 * to the same docName for the same input.
 */
function basenameLookup(target: string, input: PagesLookupInput): string | undefined {
  if (target.includes('/')) return undefined;
  const targetSlug = toWikiLinkSlug(target);
  if (!targetSlug) return undefined;
  if (isSnapshot(input)) {
    return input.pagesByBasename?.get(targetSlug);
  }
  let bestMatch: string | undefined;
  for (const page of input) {
    const slash = page.lastIndexOf('/');
    const basename = slash === -1 ? page : page.slice(slash + 1);
    if (toWikiLinkSlug(basename) !== targetSlug) continue;
    if (bestMatch === undefined || page.localeCompare(bestMatch) < 0) bestMatch = page;
  }
  return bestMatch;
}

/**
 * True when the wiki-link target text can safely be used as a path segment
 * verbatim (no path separators, no reserved chars, not "." or ".."). When
 * false, callers should fall back to `toWikiLinkSlug`.
 */
export function canUseTargetAsPathSegment(target: string): boolean {
  const trimmed = target.trim();
  return (
    trimmed.length > 0 &&
    !/[\\/\0<>:"|?*]/.test(trimmed) &&
    !/[. ]$/.test(trimmed) &&
    trimmed !== '.' &&
    trimmed !== '..'
  );
}

/**
 * Suggested filename (with `.md`) when creating a page from a wiki-link
 * target. Preserves the literal target name when it's a safe
 * path segment; otherwise falls back to the kebab-case slug.
 */
export function wikiLinkSuggestedFilename(target: string): string {
  const baseName = canUseTargetAsPathSegment(target) ? target.trim() : toWikiLinkSlug(target);
  return `${baseName}.md`;
}

export function buildUnresolvedWikiLinkAttrs(query: string): {
  target: string;
  alias: string | null;
  anchor: null;
} | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const slug = toWikiLinkSlug(trimmed);
  if (!slug) return null;

  return {
    target: slug,
    alias: slug === trimmed ? null : trimmed,
    anchor: null,
  };
}

export function getWikiLinkResolutionCandidates(target: string): string[] {
  const trimmed = target.trim();
  if (!trimmed) return [];
  const slug = toWikiLinkSlug(trimmed);
  return slug.length > 0 && slug !== trimmed ? [slug] : [];
}

/**
 * Resolve a wiki-link `target` attribute to the canonical docName as
 * stored in the page-list cache, or `undefined` when no page matches.
 *
 * Resolution chain — first match wins, intentionally mirrors
 * `resolveNavigationTarget` so the icon surface and the click destination
 * stay in sync:
 *   1. Direct membership: `cache.pages.has(target)`.
 *   2. Slug match: `cache.pagesBySlug.get(toWikiLinkSlug(target))` —
 *      handles dropped-file lowercased slugs (`readme` → `README`)
 *      and `buildUnresolvedWikiLinkAttrs` slug-form targets.
 *   3. Candidate fallback: `getWikiLinkResolutionCandidates(target)`
 *      against `cache.pages`.
 *   4. Canonical folder-index: `${target}/index` in `cache.pages`.
 *   5. Legacy folder note: `${target}/${target}` in `cache.pages`.
 *   6. Basename fallback: bare-name target → same-leaf file in a
 *      subfolder via `cache.pagesByBasename`.
 *
 * Steps 4–5 ensure the chip resolves a folder-target wiki-link to the
 * same docName the click destination opens. Without them, a
 * `[[reports]]` chip with both `reports/index` AND `other/reports`
 * existing would resolve to `other/reports` (basename) for the icon
 * while navigation opens `reports/index` — a visible mismatch.
 */
export function resolveWikiLinkTargetDocName(
  target: string,
  input: PagesLookupInput,
): string | undefined {
  const trimmed = target.trim();
  if (!trimmed) return undefined;
  const pages = getPagesSet(input);
  if (pages.has(trimmed)) return trimmed;
  const viaSlug = slugLookup(trimmed, input);
  if (viaSlug) return viaSlug;
  for (const candidate of getWikiLinkResolutionCandidates(trimmed)) {
    if (pages.has(candidate)) return candidate;
  }
  const folderIndexDocName = resolveFolderIndexDocName(trimmed, pages);
  if (folderIndexDocName) return folderIndexDocName;
  return basenameLookup(trimmed, input);
}

/**
 * Folder-target → docName for the chip resolver. Mirrors the
 * folder-index branches in `resolveNavigationTarget`: prefer a
 * canonical `${target}/index` doc, fall back to a legacy
 * `${target}/${leaf}` doc. Path-shaped targets (`foo/bar`) keep this
 * branch active so `[[foo/bar]]` resolves to `foo/bar/index` when the
 * subfolder index exists.
 */
function resolveFolderIndexDocName(target: string, pages: ReadonlySet<string>): string | undefined {
  const canonical = `${target}/index`;
  if (pages.has(canonical)) return canonical;
  const slashIndex = target.lastIndexOf('/');
  const leaf = slashIndex === -1 ? target : target.slice(slashIndex + 1);
  const legacy = leaf ? `${target}/${leaf}` : null;
  if (legacy && pages.has(legacy)) return legacy;
  return undefined;
}

function normalizeAssetTarget(target: string): string {
  const trimmed = target.trim();
  const withoutHash = (trimmed.split('#')[0] ?? '').trim();
  const withoutQuery = (withoutHash.split('?')[0] ?? '').trim();
  return withoutQuery.startsWith('/') ? withoutQuery.slice(1) : withoutQuery;
}

export function resolveWikiLinkAssetTarget(
  target: string,
  assetPaths: ReadonlySet<string>,
  /**
   * Optional tracked-files set (`kind:'file'` rows from
   * `/api/documents`). When provided, a wiki-link to any tracked non-markdown
   * file resolves — not just the renderable-asset subset. The exact + case-
   * insensitive + basename branches all extend uniformly so the resolution
   * shape stays identical regardless of which partition wins.
   */
  filePaths?: ReadonlySet<string>,
): string | null {
  const normalized = normalizeAssetTarget(target);
  if (!normalized) return null;

  const lowerTarget = normalized.toLowerCase();
  // The two partitions never overlap in practice (a renderable asset is by
  // construction not in the all-files-only set — handleDocumentList suppresses
  // `kind:'file'` for any path already emitted as `kind:'asset'`), so check
  // them independently. Asset wins on overlap because the renderable set
  // carries richer metadata downstream.
  const partitions: ReadonlyArray<ReadonlySet<string>> = filePaths
    ? [assetPaths, filePaths]
    : [assetPaths];

  for (const partition of partitions) {
    if (partition.has(normalized)) return normalized;
    for (const path of partition) {
      if (path.toLowerCase() === lowerTarget) return path;
    }
  }

  if (normalized.includes('/')) return null;
  const matches: string[] = [];
  for (const partition of partitions) {
    for (const path of partition) {
      const slash = path.lastIndexOf('/');
      const basename = slash === -1 ? path : path.slice(slash + 1);
      if (basename.toLowerCase() === lowerTarget) matches.push(path);
    }
  }
  if (matches.length === 0) return null;
  return matches.sort((a, b) => a.localeCompare(b))[0] ?? null;
}

export function isResolvedWikiLinkTarget(
  target: string,
  pages: PagesLookupInput,
  assetPaths?: ReadonlySet<string>,
  /**
   * Tracked-files set forwarded into
   * `resolveWikiLinkAssetTarget`. Lets a wiki-link to an existing non-markdown
   * file (e.g. `[[data/example.csv]]`) resolve instead of rendering dead. When
   * the input is a snapshot, the set is pulled off it; this explicit override
   * is for bare-Set test callers.
   */
  filePaths?: ReadonlySet<string>,
): boolean {
  const trimmed = target.trim();
  if (!trimmed) return false;
  if (
    resolveWikiLinkAssetTarget(
      trimmed,
      getAssetPathsSet(pages, assetPaths),
      getFilePathsSet(pages, filePaths),
    )
  ) {
    return true;
  }

  const pagesSet = getPagesSet(pages);
  if (pagesSet.has(trimmed)) return true;

  if (getWikiLinkResolutionCandidates(trimmed).some((candidate) => pagesSet.has(candidate))) {
    return true;
  }

  // Slug-based fallback. Handles dropped `.md`
  // (target='readme' from slug) against case-preserved cache entry
  // (`README`) AND underscore/space/punctuation cache entries
  // (`BA_for_Depression_Research` → slug `ba-for-depression-research`).
  // Plus hand-typed `[[README]]` via the suggestion-menu fallback path
  // that also runs the slug transform. First-wins on slug collision —
  // if both `README` and `ReadMe` exist (different case, same slug), the
  // insertion-order-first entry wins (documented in the
  // PageListCacheSnapshot JSDoc at `page-list-cache.ts`).
  if (slugLookup(trimmed, pages) !== undefined) return true;

  // Folder-index parity with `resolveNavigationTarget` — a `[[reports]]`
  // chip is resolved when a `reports/index` (or legacy `reports/reports`)
  // doc exists, matching the navigation outcome.
  if (resolveFolderIndexDocName(trimmed, pagesSet)) return true;

  // Basename fallback — bare-name target matches a same-basename file in
  // a subfolder. Mirrors `resolveNavigationTarget` so the chip's resolved
  // class matches the navigation outcome.
  return basenameLookup(trimmed, pages) !== undefined;
}
