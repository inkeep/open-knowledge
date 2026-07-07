/**
 * Filter the workspace's known asset paths down to the ones a PropPanel
 * `src` input would accept. Used by `SrcAutocomplete` to narrow the
 * autocomplete dropdown to MIME-compatible assets per descriptor.
 *
 * Matching strategy:
 *   - `accept: ['*\/*']` (File descriptor) → keep all assets.
 *   - Otherwise → map each accept MIME pattern to the kind tag the server
 *     already attaches (`image` / `video` / `audio` / `pdf` / `text`) via
 *     the shared `mediaKindForSidebarAssetExtension` extension lookup;
 *     keep assets whose ext maps to a kind in the union.
 *
 * Unknown MIME types (or accepts that don't map to any kind) are filtered
 * out — they'd produce zero matches anyway, and silently dropping them is
 * more useful than throwing on a descriptor schema drift.
 *
 * Pure — no DOM, no React. Exported for unit testing.
 */

import {
  type InlineAssetMediaKind,
  mediaKindForSidebarAssetExtension,
} from '@inkeep/open-knowledge-core';

/** Map a MIME pattern to the asset kind the server tags matching files with. */
function mediaKindForMime(mime: string): InlineAssetMediaKind | null {
  const [type] = mime.split('/');
  switch (type) {
    case 'image':
      return 'image';
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'application': {
      // `application/pdf` is the only application/* type any descriptor
      // currently uses. Add new application/* kinds (e.g. JSON / ZIP) here
      // alongside their extension-lookup entries in `upload.ts` —
      // unknown application/* falls through to `null` and the caller's
      // accept set silently shrinks rather than erroring.
      if (mime === 'application/pdf') return 'pdf';
      return null;
    }
    case 'text':
      return 'text';
    default:
      return null;
  }
}

/** Project a normalized MIME accept list to the set of kinds that match. */
function kindsForAccept(accept: readonly string[]): Set<InlineAssetMediaKind> | 'all' {
  if (accept.length === 1 && accept[0] === '*/*') return 'all';
  const kinds = new Set<InlineAssetMediaKind>();
  for (const mime of accept) {
    if (mime === '*/*') return 'all';
    const kind = mediaKindForMime(mime);
    if (kind) kinds.add(kind);
  }
  return kinds;
}

/** Extract the lowercase extension of a path, without leading dot. Empty when none. */
function extOf(path: string): string {
  const lastDot = path.lastIndexOf('.');
  if (lastDot < 0) return '';
  const lastSlash = path.lastIndexOf('/');
  if (lastDot < lastSlash) return ''; // dot is in a folder name, not the basename
  return path.slice(lastDot + 1).toLowerCase();
}

/**
 * Return the subset of `assetPaths` whose extension maps to a kind the
 * `accept` array admits. Order of input is preserved; deduplication is
 * the caller's responsibility (the input is already a `Set` in the
 * usePageList() context, so duplicates aren't expected).
 */
export function filterAssetsByAccept(
  assetPaths: Iterable<string>,
  accept: readonly string[],
): string[] {
  const wanted = kindsForAccept(accept);
  const out: string[] = [];
  for (const path of assetPaths) {
    if (wanted === 'all') {
      out.push(path);
      continue;
    }
    const kind = mediaKindForSidebarAssetExtension(extOf(path));
    if (kind && wanted.has(kind)) out.push(path);
  }
  return out;
}
