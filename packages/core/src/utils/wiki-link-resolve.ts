/**
 * Bare-name wiki-link resolution — the chain that answers "which doc (or
 * asset) does `[[target]]` name?".
 *
 * Lives in core because both the editor and the server must answer that
 * question the same way. When the chain lived only in the client, the server
 * fell back to exact-string existence and reported links dead that the editor
 * navigated fine.
 *
 * Pure string/Set/Map work — no DOM, no `node:*`, no browser globals. Core is
 * reachable from both the Vite bundle and the Node server, so it must stay
 * that way.
 *
 * NOT the same thing as `createBasenameIndex` in `path-resolve.ts`: that one
 * buckets raw-lowercase keys to arrays and tie-breaks relative to the source
 * document, over assets. This one keys slugs to a single winner over
 * documents. The two are deliberately separate — don't assume a shared
 * contract from the similar names.
 */

import {
  type AssetLinkTarget,
  classifyWikiLinkTarget,
  type DocLinkTarget,
  type ExternalLinkTarget,
} from './link-targets.ts';
import { toWikiLinkSlug } from './slug.ts';

/**
 * The lookup surface wiki-link resolution actually reads. Deliberately
 * narrower than the client's page-list snapshot (which also carries
 * `folderPaths` and `pageIcons`): that type stays in the app and satisfies
 * this structurally, while the server can assemble the same shape from its
 * admitted document set without importing anything client-side.
 */
export interface WikiLinkLookupIndex {
  readonly pages: ReadonlySet<string>;
  /** `toWikiLinkSlug(docName) → docName`. Build with {@link buildPagesBySlugIndex}. */
  readonly pagesBySlug: ReadonlyMap<string, string>;
  /** `toWikiLinkSlug(basename(docName)) → docName`. Build with {@link buildPagesByBasenameIndex}. */
  readonly pagesByBasename?: ReadonlyMap<string, string>;
  /** Referenced, renderable assets, contentDir-relative. */
  readonly assetPaths?: ReadonlySet<string>;
  /** Tracked non-markdown, non-asset files, contentDir-relative, extension included. */
  readonly filePaths?: ReadonlySet<string>;
}

/**
 * A bare `Set<string>` works for tests and non-hot-path callers — the helpers
 * derive the slug index on the fly (O(n) per call with a slug computation
 * each). A {@link WikiLinkLookupIndex} carries precomputed maps for O(1)
 * lookup. Both branches must agree on every input; the shared tie-break
 * comparator is what keeps them in sync.
 */
export type WikiLinkPagesInput = ReadonlySet<string> | WikiLinkLookupIndex;

function isLookupIndex(input: WikiLinkPagesInput): input is WikiLinkLookupIndex {
  return 'pagesBySlug' in input;
}

function getPagesSet(input: WikiLinkPagesInput): ReadonlySet<string> {
  return isLookupIndex(input) ? input.pages : input;
}

function getAssetPathsSet(input: WikiLinkPagesInput, assetPaths?: ReadonlySet<string>) {
  return isLookupIndex(input) ? (input.assetPaths ?? new Set<string>()) : (assetPaths ?? new Set());
}

/**
 * The file-paths set (tracked non-markdown, non-asset files). When the input
 * is an index, pull the optional set off it; bare-Set callers can pass it as
 * an explicit override. Returns an empty Set on absence so the
 * membership-check sites never need to nil-guard.
 */
function getFilePathsSet(input: WikiLinkPagesInput, filePaths?: ReadonlySet<string>) {
  return isLookupIndex(input) ? (input.filePaths ?? new Set<string>()) : (filePaths ?? new Set());
}

/**
 * Tie-break comparator for ambiguous basenames. Every index builder and every
 * bare-Set scan fallback sorts through this one function, so the fast path and
 * the slow path always name the same winner.
 *
 * Code-unit order, NOT `localeCompare`. `localeCompare` with no locale
 * argument resolves against the runtime's default locale, so the client and
 * the server can disagree about which document a bare name names — and two
 * clients on different machines can disagree with each other. Code-unit order
 * is fixed by the language spec, so every runtime agrees.
 *
 * This changes the winner for mixed-case collisions. Locale collation sorts
 * case-insensitively (`archive/summary` before `Notes/Summary`); code-unit
 * order puts every uppercase letter before every lowercase one, so
 * `Notes/Summary` now wins. The previous winner was never guaranteed in the
 * first place, which is the reason for the pin.
 */
function compareDocNames(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Build the slug-keyed index from a pages set. First-wins on slug collision
 * (Map insertion order preserved; iteration order of a Set follows insertion
 * order per ES spec). Takes the slug function as a parameter so callers can
 * thread the same slugger the resolver uses.
 *
 * Tie-break is deliberately insertion-order, not alphabetical — the slug
 * key already encodes the full docName, so collisions are rare and
 * insertion-order matches the Set's iteration semantics. The sibling
 * {@link buildPagesByBasenameIndex} sorts before insertion because basename
 * collisions across folders are expected.
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
 * Build the basename-keyed index from a pages set. Keys by the slug of each
 * docName's leaf segment (the part after the last `/`). Sorts input before
 * insertion so first-wins on basename collision becomes
 * lowest-by-{@link compareDocNames} — matching the tie-break in
 * {@link resolveWikiLinkAssetTarget} for assets.
 *
 * The navigation resolver reads this index rather than tie-breaking itself,
 * so the winner picked here is the one the click destination opens.
 */
export function buildPagesByBasenameIndex(
  pages: ReadonlySet<string>,
  slugFn: (text: string) => string,
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  const sorted = [...pages].sort(compareDocNames);
  for (const page of sorted) {
    const slash = page.lastIndexOf('/');
    const basename = slash === -1 ? page : page.slice(slash + 1);
    const key = slugFn(basename);
    if (key && !index.has(key)) index.set(key, page);
  }
  return index;
}

/**
 * Look up a target by slug against the pages set / index. Returns the
 * original docName on match, or undefined when no entry's slug matches
 * the target's slug.
 *
 * Unresolved-link attrs store the lowercased slug as the wikiLink target,
 * while the page cache keeps case-preserved + non-slug-form docNames
 * (`README`, `BA_for_Depression_Research`). Without a slug-based fallback,
 * `pages.has('readme')` and `pages.has('ba-for-depression-research')` never
 * match, so every dropped `.md` file + hand-typed `[[README]]` shows
 * "Page not found".
 *
 * `targetSlug` is the slug of `target` — if target is already in slug form,
 * it equals the input. Both branches use the slug as the lookup key, so
 * `README` and `readme` and `Readme` all resolve to the same entry.
 */
function slugLookup(target: string, input: WikiLinkPagesInput): string | undefined {
  const targetSlug = toWikiLinkSlug(target);
  if (!targetSlug) return undefined;
  if (isLookupIndex(input)) {
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
 * Look up a bare-name target by basename across the pages set / index.
 * Returns the original docName on match, or undefined when no entry's
 * basename slug matches. `[[analysis]]` resolves when
 * `andrew-data/.../analysis.md` exists, so the chip's resolved state and the
 * navigation destination agree.
 *
 * Targets containing `/` skip this branch (explicit-path intent —
 * `[[bar/foo]]` should not silently rewrite to `baz/foo`).
 *
 * Both the index fast path and the bare-Set scan below tie-break through
 * {@link compareDocNames}, so the two branches resolve to the same docName
 * for the same input.
 */
function basenameLookup(target: string, input: WikiLinkPagesInput): string | undefined {
  if (target.includes('/')) return undefined;
  const targetSlug = toWikiLinkSlug(target);
  if (!targetSlug) return undefined;
  if (isLookupIndex(input)) {
    return input.pagesByBasename?.get(targetSlug);
  }
  let bestMatch: string | undefined;
  for (const page of input) {
    const slash = page.lastIndexOf('/');
    const basename = slash === -1 ? page : page.slice(slash + 1);
    if (toWikiLinkSlug(basename) !== targetSlug) continue;
    if (bestMatch === undefined || compareDocNames(page, bestMatch) < 0) bestMatch = page;
  }
  return bestMatch;
}

export function getWikiLinkResolutionCandidates(target: string): string[] {
  const trimmed = target.trim();
  if (!trimmed) return [];
  const slug = toWikiLinkSlug(trimmed);
  return slug.length > 0 && slug !== trimmed ? [slug] : [];
}

/**
 * Resolve a wiki-link `target` attribute to the canonical docName, or
 * `undefined` when no page matches.
 *
 * Resolution chain — first match wins, intentionally mirrors
 * `resolveNavigationTarget` so the icon surface and the click destination
 * stay in sync:
 *   1. Direct membership: `pages.has(target)`.
 *   2. Slug match — handles dropped-file lowercased slugs (`readme` →
 *      `README`) and slug-form unresolved-link targets.
 *   3. Candidate fallback: {@link getWikiLinkResolutionCandidates} against
 *      `pages`.
 *   4. Canonical folder-index: `${target}/index` in `pages`.
 *   5. Legacy folder note: `${target}/${target}` in `pages`.
 *   6. Basename fallback: bare-name target → same-leaf file in a subfolder.
 *
 * Steps 4-5 ensure the chip resolves a folder-target wiki-link to the
 * same docName the click destination opens. Without them, a `[[reports]]`
 * chip with both `reports/index` AND `other/reports` existing would resolve
 * to `other/reports` (basename) for the icon while navigation opens
 * `reports/index` — a visible mismatch.
 *
 * Dots in the target are not special here: `[[acp.daemon]]` reaches step 6
 * and finds `notes/acp.daemon` like any other bare name. What breaks dotted
 * targets is the classification gate UPSTREAM of this chain, not the chain.
 */
export function resolveWikiLinkTargetDocName(
  target: string,
  input: WikiLinkPagesInput,
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
 * Folder-target → docName. Mirrors the folder-index branches in
 * `resolveNavigationTarget`: prefer a canonical `${target}/index` doc, fall
 * back to a legacy `${target}/${leaf}` doc. Path-shaped targets (`foo/bar`)
 * keep this branch active so `[[foo/bar]]` resolves to `foo/bar/index` when
 * the subfolder index exists.
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
   * Optional tracked-files set. When provided, a wiki-link to any tracked
   * non-markdown file resolves — not just the renderable-asset subset. The
   * exact + case-insensitive + basename branches all extend uniformly so the
   * resolution shape stays identical regardless of which partition wins.
   */
  filePaths?: ReadonlySet<string>,
): string | null {
  const normalized = normalizeAssetTarget(target);
  if (!normalized) return null;

  const lowerTarget = normalized.toLowerCase();
  // The two partitions never overlap in practice (a renderable asset is by
  // construction not in the all-files-only set — the document-list handler
  // suppresses `kind:'file'` for any path already emitted as `kind:'asset'`),
  // so check them independently. Asset wins on overlap because the renderable
  // set carries richer metadata downstream.
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
  return matches.sort(compareDocNames)[0] ?? null;
}

/**
 * Whether a wiki-link target names anything that exists.
 *
 * Asset resolution runs FIRST and document membership only on its miss. That
 * order is the status quo and is load-bearing: flipping it would silently
 * change which thing `[[meeting.pdf]]` names for a project holding both an
 * asset `meeting.pdf` and a document `meeting.pdf.md`.
 */
export function isResolvedWikiLinkTarget(
  target: string,
  pages: WikiLinkPagesInput,
  assetPaths?: ReadonlySet<string>,
  /**
   * Tracked-files set forwarded into {@link resolveWikiLinkAssetTarget}. Lets
   * a wiki-link to an existing non-markdown file (e.g. `[[data/example.csv]]`)
   * resolve instead of rendering dead. When the input is an index, the set is
   * pulled off it; this explicit override is for bare-Set callers.
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

  // Slug-based fallback. Handles dropped `.md` (target='readme' from slug)
  // against case-preserved cache entry (`README`) AND
  // underscore/space/punctuation entries (`BA_for_Depression_Research` → slug
  // `ba-for-depression-research`). First-wins on slug collision — if both
  // `README` and `ReadMe` exist (different case, same slug), the
  // insertion-order-first entry wins.
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

/**
 * Decide what a wiki-link target actually names, given the corpus.
 *
 * THIS is the function every wiki-link surface should call — never
 * `classifyWikiLinkTarget` directly. The classifier answers a syntactic
 * question ("does this string end in something extension-shaped?"), so a
 * document named `acp.daemon.md` and referenced as `[[acp.daemon]]` reads
 * `daemon` as a file extension: the target goes to the asset viewer, 404s, and
 * the resolution chain above is never consulted. Only this function answers
 * the real question — does the thing the target names exist, and as what?
 * Authoring that rule per-surface is what let the client and the server drift
 * apart to begin with, so it lives here once and surfaces only apply it.
 *
 * Promotion is decided by index MEMBERSHIP, never by a string heuristic — no
 * extension allowlist, no "does this look like a real extension" test. A
 * heuristic cannot distinguish `[[x.pdf]]` from `![[x.pdf]]` (the extractor
 * drops the embed marker before classification), so it would capture every
 * embed in the corpus. Membership captures only names that collide with a real
 * document.
 *
 * Precedence is ASSET-FIRST, which preserves today's behaviour exactly: a
 * target that resolves to a real asset stays an asset even when a document of
 * the same name exists. Testing membership first would silently flip which
 * thing `[[meeting.pdf]]` names for any project holding both `meeting.pdf` and
 * `meeting.pdf.md` — and a `.md` suffix strip is exactly how that docName
 * arises.
 *
 * A target matching neither stays an asset, which is the deliberate
 * unknown-file-type routing; changing it here would re-render every broken
 * link.
 *
 * `docName` on a promoted target is the RAW target, matching what the
 * classifier's own document branch returns — call sites run their own
 * resolution over it, so `[[acp.daemon]]` and `[[acp daemon]]` travel the same
 * path from here on.
 */
export function resolveWikiLinkTarget(
  target: string,
  anchor: string | null,
  lookup: WikiLinkPagesInput,
): DocLinkTarget | ExternalLinkTarget | AssetLinkTarget | null {
  const classified = classifyWikiLinkTarget(target, anchor);
  if (classified === null || classified.kind !== 'asset') return classified;

  const asset = resolveWikiLinkAssetTarget(
    classified.url,
    getAssetPathsSet(lookup),
    getFilePathsSet(lookup),
  );
  if (asset !== null) return classified;

  if (resolveWikiLinkTargetDocName(target, lookup) === undefined) return classified;

  return {
    kind: 'doc',
    docName: target.trim(),
    anchor: anchor?.trim() || null,
  };
}
