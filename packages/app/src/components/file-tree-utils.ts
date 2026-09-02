import {
  type DocumentListEntry,
  type InlineAssetMediaKind,
  isHiddenDocName,
  isManagedArtifactDocName,
  isProjectSkillBundlePath,
} from '@inkeep/open-knowledge-core';

export interface DocumentEntry {
  kind: 'document';
  docName: string;
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
  hasChildren?: boolean;
  isSymlink?: boolean;
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
    console.warn(
      `[file-tree-utils] dropped ${dropped} listing entries missing variant identity fields`,
    );
  }
  return mapped;
}

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

interface TreeVisibility {
  showHiddenFiles?: boolean;
  showOnlyMarkdownFiles?: boolean;
  showOkFolders?: boolean;
}

export function hasOkPathSegment(ref: string): boolean {
  return ref.split('/').some((segment) => segment.toLowerCase() === '.ok');
}

function failsOnlyMarkdownAxis(kind: unknown, showOnlyMarkdownFiles: boolean): boolean {
  return showOnlyMarkdownFiles && kind !== 'document' && kind !== 'folder';
}

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
    if (isProjectSkillBundlePath(ref)) return false;
    return !failsHiddenFilesAxis(ref, showHiddenFiles);
  });
}

export function attributeTreeHiddenAxes(
  entry: { kind?: unknown; docName?: string; path?: string },
  visibility: TreeVisibility = {},
): { hiddenFiles: boolean; onlyMarkdownFiles: boolean } {
  const { showHiddenFiles = false, showOnlyMarkdownFiles = false } = visibility;
  const ref = entry.docName ?? entry.path ?? '';
  if (
    ref === '' ||
    isManagedArtifactDocName(ref) ||
    isProjectSkillBundlePath(ref) ||
    hasOkPathSegment(ref)
  ) {
    return { hiddenFiles: false, onlyMarkdownFiles: false };
  }
  return {
    hiddenFiles: failsHiddenFilesAxis(ref, showHiddenFiles),
    onlyMarkdownFiles: failsOnlyMarkdownAxis(entry.kind, showOnlyMarkdownFiles),
  };
}

export function classifyEmptyTree(input: {
  visibility?: TreeVisibility;
  unfilteredRootEntryCount: number;
  knownPageCount: number;
}): 'true-empty' | 'filtered-to-zero' {
  const { visibility = {}, unfilteredRootEntryCount, knownPageCount } = input;
  const projectHasEntries = unfilteredRootEntryCount > 0 || knownPageCount > 0;
  return projectHasEntries && (visibility.showOnlyMarkdownFiles ?? false)
    ? 'filtered-to-zero'
    : 'true-empty';
}
