/**
 * File-icon parity — one place that maps a workspace entry (folder / markdown
 * page / asset) to a lucide icon, so search results, the wiki-link picker, and
 * the composer @-mention menu all show the SAME glyph the sidebar shows for a
 * given item.
 *
 * The sidebar renders via `@pierre/trees`, which paints its own icons (plus the
 * custom markdown M↓ glyph in `FileTree.tsx`) — there is no exported sidebar
 * icon map, so this is an approximate lucide mirror of Pierre's choices, not a
 * shared source. The mapping:
 *   - folder            → `FolderOpen`   (matches the sidebar's open-folder glyph)
 *   - markdown page     → `FileText`     (lucide stand-in for the M↓ markdown glyph)
 *   - asset, by mediaKind:
 *       image           → `Image`
 *       video           → `Film`
 *       audio           → `Volume2`
 *       pdf / text / —  → `FileText`     (no dedicated sidebar glyph; document icon)
 *
 * Named imports (not a namespace import) so Vite tree-shakes to only these
 * icons — a `import * as` would bundle all ~1800 lucide icons and blow the
 * bundle-size gate (same discipline as `registry/icons.ts`).
 */
import type { InlineAssetMediaKind } from '@inkeep/open-knowledge-core';
import { FileText, Film, FolderOpen, Image, type LucideIcon, Volume2 } from 'lucide-react';

/**
 * The minimal shape `getFileIcon` reads. Deliberately structural (not tied to
 * one entry type) so the command palette's `WorkspaceEntry`, the wiki-link
 * `WikiLinkSuggestionItem`, and the composer `MentionItem` can each pass what
 * they carry:
 *   - `kind` discriminates folder / page / asset. `'file'` (a tracked
 *     non-markdown, name-only file) and `'page'`/`'document'` all resolve to the
 *     document icon unless an asset `mediaKind` is present.
 *   - `mediaKind` (assets) selects the image/video/audio glyph; absent → document.
 *   - `assetExt` is a fallback when `mediaKind` is absent but an extension is
 *     known, resolved through the same core map the sidebar uses.
 */
export interface FileIconDescriptor {
  kind?: 'folder' | 'file' | 'page' | 'document' | 'asset' | 'anchor' | 'create';
  mediaKind?: InlineAssetMediaKind | null;
  assetExt?: string | null;
}

function iconForMediaKind(mediaKind: InlineAssetMediaKind | null | undefined): LucideIcon {
  switch (mediaKind) {
    case 'image':
      return Image;
    case 'video':
      return Film;
    case 'audio':
      return Volume2;
    // pdf / text / null have no dedicated sidebar glyph — the document icon.
    default:
      return FileText;
  }
}

/**
 * Derive a {@link FileIconDescriptor} from a composer mention's serialized
 * `path`. A mention carries no `kind` (the `composerMention` node stores only
 * `path`/`label` — see `pageItemToPath`), so the kind is inferred from the
 * basename's extension, mirroring how each kind serializes:
 *   - no basename extension → `folder` (folders serialize to their bare path)
 *   - `.md` / `.mdx`        → `page`   (pages gain the `.md` suffix)
 *   - any other extension   → `asset`  (assets keep their real extension; the
 *                                       extension rides `assetExt` so the
 *                                       image/video/audio glyph resolves)
 * Shared by the `@`-picker row, the top-row context chip, and the inline mention
 * chip so all three show the SAME glyph for a given path. Pairs with
 * {@link getFileIcon}: this maps path → descriptor, that maps descriptor → icon.
 *
 * Note: symlinks are NOT distinguishable here — a mention path carries neither a
 * `kind` nor the `isSymlink` flag `/api/documents` exposes, and the upstream
 * `pageItemToPath` mapping drops both.
 */
export function mentionPathToDescriptor(path: string): FileIconDescriptor {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  const ext = dot > slash + 1 ? path.slice(dot + 1).toLowerCase() : '';
  if (ext === '') return { kind: 'folder' };
  if (ext === 'md' || ext === 'mdx') return { kind: 'page' };
  return { kind: 'asset', assetExt: ext };
}

/**
 * Resolve the lucide icon for a workspace entry, mirroring the sidebar's choice.
 * Folders → `FolderOpen`; assets → image/video/audio/document by `mediaKind`
 * (falling back to `assetExt` when `mediaKind` is absent); everything else
 * (markdown pages, name-only files) → `FileText`.
 */
export function getFileIcon(entry: FileIconDescriptor): LucideIcon {
  if (entry.kind === 'folder') return FolderOpen;
  if (entry.kind === 'asset') {
    // An explicit `mediaKind` field (including `null` = "no sidebar viewer")
    // is authoritative — only fall back to deriving from `assetExt` when the
    // field is entirely absent, so a declared-null asset stays the document
    // icon instead of being silently re-classified from its extension.
    if (entry.mediaKind !== undefined) return iconForMediaKind(entry.mediaKind);
    if (entry.assetExt) return iconForMediaKind(assetExtToMediaKind(entry.assetExt));
    return FileText;
  }
  return FileText;
}

/**
 * Local extension→mediaKind resolver. Kept here (rather than importing the core
 * helper) so this module stays dependency-light and the icon contract is legible
 * at one site; the extension groups mirror `mediaKindForSidebarAssetExtension`.
 * Only the groups that change the glyph (image/video/audio) are enumerated —
 * everything else falls through to the document icon, so a drift in the text/pdf
 * sets has no visible effect here.
 */
function assetExtToMediaKind(ext: string): InlineAssetMediaKind | null {
  const normalized = ext.toLowerCase().replace(/^\./, '');
  if (IMAGE_EXTENSIONS.has(normalized)) return 'image';
  if (VIDEO_EXTENSIONS.has(normalized)) return 'video';
  if (AUDIO_EXTENSIONS.has(normalized)) return 'audio';
  return null;
}

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'svg',
  'bmp',
  'ico',
]);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus']);
