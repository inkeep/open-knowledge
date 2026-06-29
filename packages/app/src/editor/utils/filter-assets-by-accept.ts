
import {
  type InlineAssetMediaKind,
  mediaKindForSidebarAssetExtension,
} from '@inkeep/open-knowledge-core';

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
      if (mime === 'application/pdf') return 'pdf';
      return null;
    }
    case 'text':
      return 'text';
    default:
      return null;
  }
}

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

function extOf(path: string): string {
  const lastDot = path.lastIndexOf('.');
  if (lastDot < 0) return '';
  const lastSlash = path.lastIndexOf('/');
  if (lastDot < lastSlash) return ''; // dot is in a folder name, not the basename
  return path.slice(lastDot + 1).toLowerCase();
}

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
