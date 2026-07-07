/**
 * Pure link-resolution helpers for V2 plain-DOM link chips.
 *
 * Computes the `data-resolution-state` attribute that plain-DOM link chips need
 * (today computed inside `InternalLinkView` via React hooks). Consumed by the
 * mdast→PM decoration pipeline from the eventual `internal-link.ts` rewrite:
 * `linkResolutionDecorationPlugin({markTypes: ['link'], computeAttrs: makeLinkResolutionAttrsComputer(sourceDocName)})`.
 *
 * Pure: no React, no DOM, no window globals. The `sourceDocName` is explicit
 * (InternalLinkView's `classifyCurrentMarkdownHref` implicitly reads
 * `window.location.hash` — decoupled here so caller threads the editor's
 * document name via closure capture at plugin-factory time).
 *
 * **Resolution states:**
 * - `'external'` — absolute URL (https://, mailto:, etc.)
 * - `'anchor'` — starts with `#` (in-document link)
 * - `'loading'` — doc or asset link but page-list-cache hasn't been written yet
 *   (cache === null); renders as "still computing" chrome so we don't
 *   flash the unresolved styling during first cold load
 * - `'resolved'` — doc link, target exists in `cache.pages`
 * - `'folder'` — doc link, target resolves to a folder-index
 * - `'asset'` — non-markdown file link; resolves against `cache.assetPaths`
 *   when present, optimistic when the index is absent
 * - `'unresolved'` — doc or asset link, target missing (prompts create-on-click)
 *
 * Matches the exact branches `InternalLinkView.resolutionState` produces today:
 * `loading ? 'loading' : folder ? 'folder' : resolved ? 'resolved' : 'unresolved'`.
 * The 'external' + 'anchor' states are additive for V2 — InternalLinkView handles
 * those via separate render branches (ExternalLinkChip + plain-anchor).
 */

import { classifyMarkdownHref, resolveAssetProjectPath } from '@inkeep/open-knowledge-core';
import { resolveLinkTargetIntent } from '../../components/link-target-intent';
import type { PageListCacheSnapshot } from '../page-list-cache';
import type { MarkInfo } from './mark-identity';

type LinkResolutionState =
  | 'loading'
  | 'external'
  | 'anchor'
  | 'resolved'
  | 'folder'
  | 'unresolved'
  | 'asset';

function setHasPathCaseInsensitive(paths: ReadonlySet<string>, target: string): boolean {
  if (paths.has(target)) return true;
  const lowerTarget = target.toLowerCase();
  for (const path of paths) {
    if (path.toLowerCase() === lowerTarget) return true;
  }
  return false;
}

export function isResolvedAssetHref(
  href: string,
  sourceDocName: string,
  assetPaths: ReadonlySet<string> | undefined,
  /**
   * The tracked-non-asset set (`kind:'file'` rows from
   * `/api/documents`). When provided, a markdown-link to an existing
   * non-markdown file that's NOT a renderable asset
   * (e.g. `[csv](./data/example.csv)`) resolves rather than rendering dead.
   * Absent for legacy callers; the asset-path-only check still applies.
   */
  filePaths?: ReadonlySet<string> | undefined,
): boolean {
  const projectRelPath = resolveAssetProjectPath(href, sourceDocName);
  if (projectRelPath === null) return false;
  if (assetPaths && setHasPathCaseInsensitive(assetPaths, projectRelPath)) return true;
  if (filePaths && setHasPathCaseInsensitive(filePaths, projectRelPath)) return true;
  return false;
}

/**
 * Compute the resolution state for a single link href + source-doc + cache snapshot.
 *
 * Pure — takes all inputs as parameters, reads no globals. Invariants:
 * - Empty / unclassifiable href → 'unresolved'
 * - External URLs → 'external' (regardless of cache state)
 * - Anchor-only hrefs → 'anchor'
 * - Asset hrefs (non-markdown extension) resolve against `cache.assetPaths`
 *   when present; older/partial cache snapshots keep assets optimistic
 * - Doc-link href with `cache === null` → 'loading'
 * - Doc-link href with cache populated → 'resolved' | 'folder' | 'unresolved'
 */
export function computeLinkResolutionState(
  href: string,
  sourceDocName: string,
  cache: PageListCacheSnapshot | null,
): LinkResolutionState {
  const target = classifyMarkdownHref(href, sourceDocName);
  if (!target) return 'unresolved';
  if (target.kind === 'external') return 'external';
  if (target.kind === 'anchor') return 'anchor';

  if (cache === null) return 'loading';

  if (target.kind === 'asset') {
    // BOTH `cache.assetPaths` (renderable referenced assets)
    // AND `cache.filePaths` (tracked non-markdown files surfaced by /api/
    // documents as `kind:'file'`) participate in the existence check. Without
    // the file-paths arm, a markdown link to an existing `data/example.csv`
    // would render dead even though the file is tracked. When BOTH partitions
    // are missing from the cache (very old snapshot) we stay optimistic — the
    // original invariant.
    if (cache.assetPaths === undefined && cache.filePaths === undefined) return 'asset';
    return isResolvedAssetHref(target.url, sourceDocName, cache.assetPaths, cache.filePaths)
      ? 'asset'
      : 'unresolved';
  }

  const intent = resolveLinkTargetIntent(target.docName, {
    pages: cache.pages,
    folderPaths: cache.folderPaths,
  });
  if (intent.kind === 'create') return 'unresolved';
  return intent.displayState;
}

/**
 * Compute the decoration attrs record for `linkResolutionDecorationPlugin`.
 *
 * Pure adapter: {markInfo + cache + sourceDocName} → `{'data-resolution-state': state}`.
 * Returns `null` when the mark has no usable href (e.g. attrs missing / malformed)
 * so the decoration plugin skips it (cleaner than emitting a decoration with a
 * bogus value).
 */
export function computeLinkResolutionAttrs(
  markInfo: MarkInfo,
  cache: PageListCacheSnapshot | null,
  sourceDocName: string,
): Record<string, string> | null {
  const href = markInfo.attrs?.href;
  if (typeof href !== 'string' || href.length === 0) return null;
  // Wiki-embed asset links are not doc-links — the pages cache is markdown-
  // only, so running the doc-link intent classifier against a PDF/video/
  // audio href always returns 'unresolved' and paints the link as broken.
  // Skip the decoration; asset links get default <a> styling.
  if (markInfo.attrs?.sourceForm === 'wikiembed') return null;
  const state = computeLinkResolutionState(href, sourceDocName, cache);
  return { 'data-resolution-state': state };
}

/**
 * Curry helper — binds `sourceDocName` so consumers can hand the resulting
 * computer directly to `linkResolutionDecorationPlugin({computeAttrs})`.
 *
 * Pattern at the wiring site:
 *
 * ```ts
 * linkResolutionDecorationPlugin({
 *   markTypes: ['link'],
 *   computeAttrs: makeLinkResolutionAttrsComputer(editor.options.docName),
 * })
 * ```
 */
export function makeLinkResolutionAttrsComputer(
  sourceDocName: string,
): (markInfo: MarkInfo, cache: PageListCacheSnapshot | null) => Record<string, string> | null {
  return (markInfo, cache) => computeLinkResolutionAttrs(markInfo, cache, sourceDocName);
}
