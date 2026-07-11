/** Shared data model and navigation helpers for the file sidebar. */

import {
  type DocumentListEntry,
  type InlineAssetMediaKind,
  isHiddenDocName,
  isManagedArtifactDocName,
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
 * Sidebar visibility toggles — one orthogonal axis per field, composed by
 * AND. Every axis defaults to off, and the all-off output is exactly the
 * long-standing hidden-only filter, so zero-config callers keep today's
 * behavior.
 */
interface TreeVisibility {
  /**
   * Reveal entries the shared `isHiddenDocName` predicate classifies as
   * hidden (dot-segment paths, well-known agent configs). Never reveals
   * `.ok` — that is `showOkFolders`' axis alone.
   */
  showHiddenFiles?: boolean;
  /**
   * Keep only markdown docs and folders; every other leaf drops. In this
   * data model client `kind:'document'` holds exactly the on-disk
   * `.md`/`.mdx` files, so the kind check is the extension filter.
   */
  showOnlyMarkdownFiles?: boolean;
  /**
   * Reveal entries under a `.ok` path segment (OK-managed state: skills,
   * templates, folder metadata). The only axis that governs them.
   */
  showOkFolders?: boolean;
}

/**
 * Sidebar render-set filter. With every axis off (the default) it drops
 * exactly the entries the shared `isHiddenDocName` predicate classifies as
 * hidden — a dot-segment at any depth (parallel to
 * EmptyEditorState.countEntries()'s onboarding gate), or a well-known
 * non-dotted agent config (`HIDDEN_CONFIG_BASENAMES`, e.g. `opencode.json`).
 * Delegating to the core predicate keeps the sidebar in lockstep with search
 * ranking + agent egress, which classify hidden the same way.
 *
 * `showHiddenFiles` bypasses that hidden branch — server filters
 * (`.gitignore` / `.okignore` / `BUILTIN_SKIP_DIRS`) still apply, so `.git/`
 * and `node_modules/` stay out regardless. It recovers user-authored hidden
 * entries the server ships (e.g. `brain/.archived/note.md`) but the client
 * hides by default.
 *
 * `.ok`-segment entries are carved out of that bypass: they are OK-managed
 * state, not user-authored dotfiles, and listings can carry them (the index
 * admits `.ok/skills/**` docs). Only `showOkFolders` admits them — with the
 * one composition seam that a dot-segment ancestor ABOVE the `.ok` segment
 * still follows `showHiddenFiles`, so revealing `.ok` never drags a hidden
 * parent folder into view.
 *
 * Empty-string `ref` is always rejected — surfaces a stray entry shipped
 * without a docName/path.
 */
/**
 * Whether a docName / path sits under the OK-managed `.ok` directory (a
 * `.ok` segment at any depth). One predicate for every consumer — the
 * render-set filter, the indicator attribution, click routing, and the
 * doc-open guard must all agree on what counts as OK-managed.
 *
 * Case-insensitive to mirror the server's reserved-path guard: on the
 * case-insensitive filesystems OK primarily runs on, `.OK/x` addresses the
 * same directory as `.ok/x`, so the client gates must treat the variants
 * identically or the two layers disagree about what is read-only.
 */
export function hasOkPathSegment(ref: string): boolean {
  return ref.split('/').some((segment) => segment.toLowerCase() === '.ok');
}

/**
 * Only-markdown axis clause: drops every leaf that is not a markdown doc or a
 * folder. Shared verbatim by the render-set filter and the indicator's
 * attribution so the two can never judge the axis differently.
 */
function failsOnlyMarkdownAxis(kind: unknown, showOnlyMarkdownFiles: boolean): boolean {
  return showOnlyMarkdownFiles && kind !== 'document' && kind !== 'folder';
}

/** Hidden-files axis clause for refs outside a `.ok` subtree. */
function failsHiddenFilesAxis(ref: string, showHiddenFiles: boolean): boolean {
  return !showHiddenFiles && isHiddenDocName(ref);
}

export function filterVisibleEntries<T extends { kind?: unknown; docName?: string; path?: string }>(
  entries: ReadonlyArray<T>,
  visibility: TreeVisibility = {},
): T[] {
  const {
    showHiddenFiles = false,
    showOnlyMarkdownFiles = false,
    showOkFolders = false,
  } = visibility;
  return entries.filter((entry) => {
    const ref = entry.docName ?? entry.path ?? '';
    if (ref === '') return false;
    if (failsOnlyMarkdownAxis(entry.kind, showOnlyMarkdownFiles)) {
      return false;
    }
    const segments = ref.split('/');
    const okIndex = segments.indexOf('.ok');
    if (okIndex !== -1) {
      if (!showOkFolders) return false;
      const ancestorPath = segments.slice(0, okIndex).join('/');
      return showHiddenFiles || ancestorPath === '' || !isHiddenDocName(ancestorPath);
    }
    return !failsHiddenFilesAxis(ref, showHiddenFiles);
  });
}

/**
 * Which visibility axes currently keep `entry` out of the sidebar tree —
 * the attribution behind the editor's not-in-sidebar indicator, one field
 * per user-flippable toggle. Judged clause-for-clause against
 * `filterVisibleEntries`: an axis is attributed exactly when its clause is
 * what drops the entry, so "some axis attributed" ⇔ "the filter drops it"
 * for every ref the axes govern (test-pinned).
 *
 * Refs outside those axes' domain attribute nothing: managed-artifact names
 * (skills/templates, which never have a tree row) and `.ok` paths (governed
 * by `showOkFolders` alone) — an indicator naming Hidden files / Only
 * markdown files for them would point at toggles that cannot reveal them.
 */
export function attributeTreeHiddenAxes(
  entry: { kind?: unknown; docName?: string; path?: string },
  visibility: TreeVisibility = {},
): { hiddenFiles: boolean; onlyMarkdownFiles: boolean } {
  const { showHiddenFiles = false, showOnlyMarkdownFiles = false } = visibility;
  const ref = entry.docName ?? entry.path ?? '';
  if (ref === '' || isManagedArtifactDocName(ref) || hasOkPathSegment(ref)) {
    return { hiddenFiles: false, onlyMarkdownFiles: false };
  }
  return {
    hiddenFiles: failsHiddenFilesAxis(ref, showHiddenFiles),
    onlyMarkdownFiles: failsOnlyMarkdownAxis(entry.kind, showOnlyMarkdownFiles),
  };
}

/**
 * Which empty state a rendered-empty tree is in. Call only once the filtered
 * render set is empty — the classifier then splits "the project has nothing
 * to show" (the long-standing `No files yet` state) from "the active view
 * filters hide everything" (an explainer with a reset-to-defaults action).
 *
 * The filtered `documents` state cannot make this call by itself (raw
 * listings are not retained), so the split reads the two unfiltered-nonempty
 * signals that do flow client-side: the pre-filter count of the depth-1 root
 * listing, and the indexed markdown page set.
 *
 * `showHiddenFiles` and `showOkFolders` are reveal-only — each merely
 * bypasses a default-hidden branch of `filterVisibleEntries` — so
 * `showOnlyMarkdownFiles` is the single axis that can hide entries the
 * defaults would show. Without it, an empty render is what the defaults
 * produce (dot-only projects render empty by long-standing design), and a
 * reset to defaults could not change it: that state stays true-empty.
 */
export function classifyEmptyTree(input: {
  visibility?: TreeVisibility;
  /** Pre-filter entry count of the most recent depth-1 root listing. */
  unfilteredRootEntryCount: number;
  /** Size of the indexed markdown page set (PageListContext `pages`). */
  knownPageCount: number;
}): 'true-empty' | 'filtered-to-zero' {
  const { visibility = {}, unfilteredRootEntryCount, knownPageCount } = input;
  const projectHasEntries = unfilteredRootEntryCount > 0 || knownPageCount > 0;
  return projectHasEntries && (visibility.showOnlyMarkdownFiles ?? false)
    ? 'filtered-to-zero'
    : 'true-empty';
}
