/**
 * Existence signal for a rendered image, resolved against the same
 * project-local asset/file inventory the link chips use
 * (`isResolvedAssetHref` + the page-list cache). Separates *target-existence
 * truth* (does the file the src points at exist in the project?) from
 * *image-render truth* (did the `<img>` decode?) so the renderer can say
 * "Image not found" for a proven-absent target and "Image couldn't be
 * displayed" for a present-but-undecodable one, rather than conflating both
 * into a single broken state.
 *
 * `'unknown'` is the deliberate non-claiming answer: an off-project src
 * (external URL, traversal escape), an anchor, or a not-yet-loaded inventory
 * cannot prove absence, so the renderer must not assert "not found".
 */

import { resolveAssetProjectPath } from '@inkeep/open-knowledge-core';
import { useOptionalPageList } from '../../components/PageListContext';
import { isResolvedAssetHref } from '../extensions/link-resolution';

export type ImageTargetExistence = 'exists' | 'missing' | 'unknown';

/**
 * Pure existence classification for an image src against a project inventory.
 *
 * - src that resolves to no project-relative path (external scheme, `//host`,
 *   `#anchor`, or a `..` escape past the content root) → `'unknown'`: it is
 *   not a project-local target, so its absence from the inventory is not
 *   evidence of a missing file.
 * - project-relative src present in `assetPaths` or `filePaths` (the referenced-
 *   asset and tracked-file partitions of `/api/documents`) → `'exists'`.
 * - project-relative src in neither partition → `'missing'` (proven absent
 *   under the same ContentFilter admission the server assessment uses).
 */
export function classifyImageTargetExistence(
  src: string,
  sourceDocName: string,
  assetPaths: ReadonlySet<string> | undefined,
  filePaths: ReadonlySet<string> | undefined,
): ImageTargetExistence {
  // URI plane, for every producer of an `<img src>` — markdown images, the
  // `WikiEmbed*` compats, and bare HTML alike. The src is what the browser
  // fetches, and the asset serve path percent-decodes that request URL before
  // touching disk, so an existence check that skipped decoding would answer a
  // different question than the fetch it is explaining.
  const projectRelPath = resolveAssetProjectPath(src, sourceDocName, { literal: false });
  if (projectRelPath === null) return 'unknown';
  return isResolvedAssetHref(src, sourceDocName, assetPaths, filePaths, { literal: false })
    ? 'exists'
    : 'missing';
}

/**
 * React hook: current existence signal for an image src, reactive to the
 * page-list cache (which refreshes on the CC1 `files` push, so a target
 * created/deleted on disk flips this without a reload).
 *
 * Server-absolute srcs (the normalized `/contentDir-relative` form the
 * markdown image path emits) resolve without a source doc, so `''` is passed.
 * An absent or empty src is invalid and returns `'missing'` immediately.
 *
 * For a non-empty src, returns `'unknown'` while no provider is mounted
 * (portal/test renders) or during the cold page-list load, so an image never
 * flashes "not found" before the inventory is known.
 */
export function useImageTargetExistence(src: string | undefined): ImageTargetExistence {
  const pageList = useOptionalPageList();
  if (src === undefined || src === '') return 'missing';
  if (pageList === null) return 'unknown';
  if (pageList.loading) return 'unknown';
  return classifyImageTargetExistence(src, '', pageList.assetPaths, pageList.filePaths);
}
