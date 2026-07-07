/** Shared data model and navigation helpers for the file sidebar. */

import {
  type DocumentListEntry,
  type InlineAssetMediaKind,
  isHiddenDocName,
} from '@inkeep/open-knowledge-core';

export interface DocumentEntry {
  kind: 'document';
  docName: string;
  /**
   * On-disk extension — `.md` (default) or `.mdx`. Surfaced by `/api/documents`
   * via `getDocExtension(docName)`. Carrying it on the entry lets the sidebar
   * adapter map `docName` ↔ `treePath` faithfully and lets display sites
   * (delete-confirmation dialog, drag previews, rename hints) render the
   * actual extension instead of hardcoding `.md`. Defaults to `.md` at every
   * consumer when older API responses omit it.
   */
  docExt?: string;
  size: number;
  modified: string;
  isSymlink?: boolean;
  canonicalDocName?: string | null;
  targetPath?: string | null;
}

interface AssetEntry {
  kind: 'asset';
  path: string;
  assetExt: string;
  mediaKind: InlineAssetMediaKind | null;
  size: number;
  modified: string;
  referencedBy?: string[];
}

export interface FolderEntry {
  kind: 'folder';
  path: string;
  size: number;
  modified: string;
  /**
   * True when the folder has at least one admitted (non-skipped) child.
   * Stamped only by the depth-1 listing (`?showAll=true&dir=<rel>&depth=1`)
   * so the sidebar can decide whether expansion has anything to fetch without
   * the server walking the subtree; absent on recursive-walk and index-backed
   * entries.
   */
  hasChildren?: boolean;
  /** True when this folder is itself a symlink to a directory inside the content dir. */
  isSymlink?: boolean;
  /** Canonical-relative on-disk path of the symlink target (when isSymlink). */
  targetPath?: string | null;
}

export type FileEntry = DocumentEntry | AssetEntry | FolderEntry;
export type DocEntry = DocumentEntry;

export function isAssetEntry(entry: FileEntry): entry is AssetEntry {
  return entry.kind === 'asset';
}

export function isDocumentEntry(entry: FileEntry): entry is DocumentEntry {
  return entry.kind === 'document';
}

export function isFolderEntry(entry: FileEntry): entry is FolderEntry {
  return entry.kind === 'folder';
}

/**
 * Convert wire-validated `/api/documents` entries into the sidebar's
 * `FileEntry` union. The Zod schema enforces per-kind required fields only at
 * runtime (`.refine()` cannot narrow the inferred type), so `DocumentListEntry`
 * is one broad object with optional variant fields — the per-kind construction
 * here is what carries those guarantees into the type system. Entries missing
 * their variant identity field cannot survive the schema's refine; they are
 * skipped rather than fabricated (same posture as `filterVisibleEntries`'s
 * empty-ref rejection). A new `kind` added to the schema fails compilation at
 * the `never` check instead of flowing through unhandled.
 *
 * The wire `kind:'file'` variant (name-only non-markdown row
 * the server emits via `getAllFilesIndex()`) is folded into the existing
 * `kind:'asset'` client model with `mediaKind: null` + `referencedBy: []`.
 * The tree's render path keys on `kind:'asset'` for every non-markdown,
 * non-folder leaf (the same shape `?showAll=true` has emitted for ages), so
 * the omnibar / picker get the all-files set without a tree-side schema
 * widening or a parallel render branch. `assetExt` defaults to a synthetic
 * fallback when the server omitted it — the schema makes it optional for
 * `kind:'file'` (LICENSE-style extensionless files).
 */
export function toFileEntries(entries: readonly DocumentListEntry[]): FileEntry[] {
  const mapped: FileEntry[] = [];
  let dropped = 0;
  for (const entry of entries) {
    switch (entry.kind) {
      case 'document':
        if (entry.docName === undefined) {
          dropped += 1;
          break;
        }
        mapped.push({
          kind: 'document',
          docName: entry.docName,
          docExt: entry.docExt,
          size: entry.size,
          modified: entry.modified,
          isSymlink: entry.isSymlink,
          canonicalDocName: entry.canonicalDocName,
          targetPath: entry.targetPath,
        });
        break;
      case 'asset':
        if (entry.path === undefined || entry.assetExt === undefined) {
          dropped += 1;
          break;
        }
        mapped.push({
          kind: 'asset',
          path: entry.path,
          assetExt: entry.assetExt,
          mediaKind: entry.mediaKind ?? null,
          size: entry.size,
          modified: entry.modified,
          referencedBy: entry.referencedBy,
        });
        break;
      case 'file': {
        // Name-only non-markdown row. Fold into the client
        // asset model with `mediaKind: null` + `referencedBy: []` so existing
        // `isAssetEntry`-keyed render paths admit them without a parallel
        // branch. The wire schema makes `assetExt` optional for `kind:'file'`
        // (LICENSE-style extensionless rows); synthesize a fallback so the
        // client model stays uniform.
        if (entry.path === undefined) {
          dropped += 1;
          break;
        }
        mapped.push({
          kind: 'asset',
          path: entry.path,
          assetExt: entry.assetExt ?? synthesizeFileAssetExt(entry.path),
          mediaKind: null,
          size: entry.size,
          modified: entry.modified,
          referencedBy: [],
        });
        break;
      }
      case 'folder':
        if (entry.path === undefined) {
          dropped += 1;
          break;
        }
        mapped.push({
          kind: 'folder',
          path: entry.path,
          size: entry.size,
          modified: entry.modified,
          hasChildren: entry.hasChildren,
          isSymlink: entry.isSymlink,
          targetPath: entry.targetPath,
        });
        break;
      default: {
        const _exhaustive: never = entry.kind;
        break;
      }
    }
  }
  if (dropped > 0) {
    // One bounded summary line per listing apply (never per entry — a mass
    // server regression must not emit tens of thousands of warns). The drop
    // itself is the documented skip-not-fabricate posture; this makes a
    // schema-drifting server visible instead of presenting an empty tree.
    console.warn(
      `[file-tree-utils] dropped ${dropped} listing entries missing variant identity fields`,
    );
  }
  return mapped;
}

/**
 * Client-side mirror of the server's `synthesizeShowAllAssetExt` fallback.
 * Returns the lowercased extension (no leading `.`), or a `'file'` sentinel
 * for extensionless basenames. Kept here so the tree-adapter classification
 * never produces an empty `assetExt` even when the server omits it.
 */
export function synthesizeFileAssetExt(path: string): string {
  const basename = path.includes('/') ? (path.split('/').pop() ?? path) : path;
  const dotIndex = basename.lastIndexOf('.');
  if (dotIndex > 0 && dotIndex < basename.length - 1) {
    return basename.slice(dotIndex + 1).toLowerCase();
  }
  if (basename.startsWith('.') && basename.length > 1) return basename.slice(1).toLowerCase();
  return 'file';
}

export function computeAncestors(docName: string | null): string[] {
  if (!docName) return [];
  const segments = docName.split('/').filter(Boolean);
  const ancestors: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    ancestors.push(segments.slice(0, i).join('/'));
  }
  return ancestors;
}

export function defaultInitialDir(activeDocName: string | null): string {
  if (!activeDocName) return '';
  const slash = activeDocName.lastIndexOf('/');
  return slash > 0 ? activeDocName.slice(0, slash) : '';
}

/**
 * Sidebar render-set filter. By default drops any entry the shared
 * `isHiddenDocName` predicate classifies as hidden — a dot-segment at any depth
 * (parallel to EmptyEditorState.countEntries()'s onboarding gate), or a
 * well-known non-dotted agent config (`HIDDEN_CONFIG_BASENAMES`, e.g.
 * `opencode.json`). Delegating to the core predicate keeps the sidebar in
 * lockstep with search ranking + agent egress, which classify hidden the same
 * way. When `showHiddenFiles` is true the hidden branch is bypassed — server
 * filters (`.gitignore` / `.okignore` / `BUILTIN_SKIP_DIRS`) still apply, so
 * `.git/`, `.ok/`, `node_modules/` stay hidden. The toggle recovers
 * user-authored hidden entries that the server ships (e.g.
 * `brain/.archived/note.md`) but the client today hides.
 *
 * Empty-string `ref` is always rejected — surfaces a stray entry shipped
 * without a docName/path.
 */
export function filterVisibleEntries<T extends { kind?: unknown; docName?: string; path?: string }>(
  entries: ReadonlyArray<T>,
  showHiddenFiles = false,
): T[] {
  return entries.filter((entry) => {
    const ref = entry.docName ?? entry.path ?? '';
    if (ref === '') return false;
    if (showHiddenFiles) return true;
    return !isHiddenDocName(ref);
  });
}
