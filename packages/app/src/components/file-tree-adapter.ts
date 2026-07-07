import {
  mediaKindForSidebarAssetExtension,
  type UploadAssetSuccess,
} from '@inkeep/open-knowledge-core';
import type { ContextMenuItem, FileTreeDropTarget } from '@pierre/trees';
import { getFileExtension } from '@/components/file-tree-rename-validation';
import {
  type DocumentEntry,
  type FileEntry,
  isAssetEntry,
  isDocumentEntry,
  isFolderEntry,
} from '@/components/file-tree-utils';
import { OK_SIDEBAR_DRAG_MIME } from '@/lib/sidebar-drag';

const DEFAULT_TREE_EXTENSION = '.md';
const TREE_EXTENSION_PATTERN = /\.(md|mdx)$/i;

/**
 * Map a docName to the tree path the @pierre/trees model uses. `docExt`
 * carries the actual on-disk extension (`.md` / `.mdx`) — defaults to `.md`
 * for sites that don't have it yet. Two files with the same docName but
 * different extensions are distinct file system entries; passing the wrong
 * extension breaks tree-model mapping.
 */
export function docNameToTreePath(
  docName: string,
  docExt: string = DEFAULT_TREE_EXTENSION,
): string {
  return `${docName}${docExt}`;
}

export function treeFilePathToDocName(treePath: string): string {
  return stripTrailingSlash(treePath).replace(TREE_EXTENSION_PATTERN, '');
}

export function fileEntryToTreePath(entry: FileEntry): string {
  if (isFolderEntry(entry)) return folderPathToTreeDirectoryPath(entry.path);
  return isAssetEntry(entry) ? entry.path : docNameToTreePath(entry.docName, entry.docExt);
}

/**
 * Detect the markdown extension on a tree path. Returns `.md` or `.mdx`
 * (lowercased) when the path ends with one; undefined when neither matches
 * (e.g., a folder path).
 */
function detectTreePathExtension(treePath: string): string | undefined {
  const match = stripTrailingSlash(treePath).match(TREE_EXTENSION_PATTERN);
  return match ? `.${match[1].toLowerCase()}` : undefined;
}

export function treeDirectoryPathToFolderPath(treePath: string): string {
  return stripTrailingSlash(treePath);
}

export function folderPathToTreeDirectoryPath(folderPath: string): string {
  const trimmed = stripTrailingSlash(folderPath.trim());
  return trimmed ? `${trimmed}/` : '';
}

export function treePathToAppPath(treePath: string): string {
  return treePath.endsWith('/')
    ? treeDirectoryPathToFolderPath(treePath)
    : treeFilePathToDocName(treePath);
}

export function documentsToTreePaths(documents: readonly FileEntry[]): string[] {
  return documents.map(fileEntryToTreePath);
}

export function treePathSignature(paths: readonly string[]): string {
  return [...paths].sort().join('\0');
}

export function documentsTreePathSignature(documents: readonly FileEntry[]): string {
  return treePathSignature(documentsToTreePaths(documents));
}

export function collectTreeFolderPathsFromDocuments(documents: readonly FileEntry[]): string[] {
  const folderPaths = new Set<string>();
  for (const entry of documents) {
    const path = isFolderEntry(entry)
      ? entry.path
      : isAssetEntry(entry)
        ? entry.path
        : entry.docName;
    const segments = path.split('/').filter(Boolean);
    // `.ok/` is an internal directory. Skills-as-content makes
    // `.ok/skills/<name>/SKILL` real content docs and `.ok` itself
    // index-descendable, so they now reach the document list — but `.ok` is
    // never a user-visible tree folder (skills live in the Skills section).
    // Excluding it keeps the folder count (and the hasFolders-gated "Tree view
    // options" toolbar) about VISIBLE folders only.
    if (segments.includes('.ok')) continue;
    if (isFolderEntry(entry)) {
      const folderPath = folderPathToTreeDirectoryPath(entry.path);
      if (folderPath) folderPaths.add(folderPath);
    }
    const folderSegmentLimit = isFolderEntry(entry) ? segments.length : segments.length - 1;
    for (let i = 1; i <= folderSegmentLimit; i++) {
      folderPaths.add(`${segments.slice(0, i).join('/')}/`);
    }
  }
  return [...folderPaths].sort();
}

export function computeTreeAncestorPaths(path: string | null): string[] {
  if (!path) return [];
  const normalized = stripTrailingSlash(path.replace(TREE_EXTENSION_PATTERN, ''));
  const segments = normalized.split('/').filter(Boolean);
  const ancestors: string[] = [];
  const folderSegmentCount = path.endsWith('/') ? segments.length : segments.length - 1;
  for (let i = 1; i <= folderSegmentCount; i++) {
    ancestors.push(`${segments.slice(0, i).join('/')}/`);
  }
  return ancestors;
}

/**
 * Resolve the on-disk extension for a file target. The regex over the tree
 * path is the fast path for already-extended paths. When the regex misses —
 * Pierre's `#completeRenaming` can move a node to its extensionless basename
 * (`Untitled.md` → `Untitled`) without notifying us — fall back to the
 * authoritative `documents` list. A missing entry on an extensionless name
 * defaults to `.md`; asset classification happens before this helper.
 */
function resolveFileDocExt(
  treePath: string,
  docName: string,
  documents: readonly FileEntry[],
): string | undefined {
  const regexExt = detectTreePathExtension(treePath);
  if (regexExt) return regexExt;
  const entry = documents.find(
    (candidate): candidate is DocumentEntry =>
      isDocumentEntry(candidate) && candidate.docName === docName,
  );
  if (entry) return entry.docExt ?? DEFAULT_TREE_EXTENSION;
  return getTreeBasename(treePath).includes('.') ? undefined : DEFAULT_TREE_EXTENSION;
}

export function resolveExtensionlessAssetPath(
  path: string,
  documents: readonly FileEntry[],
): string | null {
  const slash = path.lastIndexOf('/');
  const parentPrefix = slash === -1 ? '' : path.slice(0, slash + 1);
  const stem = slash === -1 ? path : path.slice(slash + 1);
  const candidates = documents.filter(
    (candidate): candidate is Extract<FileEntry, { kind: 'asset' }> => {
      if (!isAssetEntry(candidate) || !candidate.path.startsWith(parentPrefix)) return false;
      const name = candidate.path.slice(parentPrefix.length);
      return !name.includes('/') && name.startsWith(`${stem}.`);
    },
  );
  // Ambiguous same-stem assets intentionally preserve the caller's conservative fallback.
  return candidates.length === 1 ? candidates[0].path : null;
}

function resolveAssetTargetPath(
  treePath: string,
  appPath: string,
  documents: readonly FileEntry[],
): string | null {
  if (detectTreePathExtension(treePath)) return null;
  const direct = documents.find(
    (candidate): candidate is Extract<FileEntry, { kind: 'asset' }> =>
      isAssetEntry(candidate) && candidate.path === appPath,
  );
  if (direct) return direct.path;

  const basename = getTreeBasename(treePath);
  if (basename.includes('.')) return appPath;
  return resolveExtensionlessAssetPath(appPath, documents);
}

type FileTreeTargetWithTreePath = {
  name: string;
  path: string;
  treePath: string;
} & (
  | { kind: 'folder'; docExt?: undefined }
  | { kind: 'file'; docExt?: string }
  | { kind: 'asset'; docExt?: undefined }
);

export function treeItemToTarget(
  item: ContextMenuItem,
  documents: readonly FileEntry[],
): FileTreeTargetWithTreePath {
  const isFolder = item.kind === 'directory';
  const appPath = isFolder
    ? treeDirectoryPathToFolderPath(item.path)
    : treeFilePathToDocName(item.path);
  if (isFolder) {
    return {
      kind: 'folder',
      name: stripTrailingSlash(getTreeBasename(item.path)).replace(TREE_EXTENSION_PATTERN, ''),
      path: appPath,
      treePath: normalizeTreePathForKind(item.path, true),
    };
  }
  const assetPath = resolveAssetTargetPath(item.path, appPath, documents);
  if (assetPath) {
    return {
      kind: 'asset',
      name: stripTrailingSlash(getTreeBasename(assetPath)),
      path: assetPath,
      treePath: assetPath,
    };
  }
  const docExt = resolveFileDocExt(item.path, appPath, documents);
  return {
    kind: 'file',
    name: stripTrailingSlash(getTreeBasename(item.path)).replace(TREE_EXTENSION_PATTERN, ''),
    path: appPath,
    treePath: normalizeTreePathForKind(item.path, false),
    docExt,
  };
}

export function relativePathForTreeItem(item: ContextMenuItem): string {
  return item.kind === 'directory' ? treeDirectoryPathToFolderPath(item.path) : item.path;
}

export function normalizeTreePathForKind(path: string, isFolder: boolean): string {
  if (isFolder) return folderPathToTreeDirectoryPath(path);
  // Already-extended paths pass through (preserves authored .md/.mdx); bare
  // names get the default extension appended for new-file placeholders.
  return TREE_EXTENSION_PATTERN.test(path) ? path : `${path}${DEFAULT_TREE_EXTENSION}`;
}

export function createTreePlaceholder(
  kind: 'file' | 'folder',
  parentFolderPath: string,
  existingTreePaths: readonly string[],
): { addPath: string; renamePath: string } {
  const parent = folderPathToTreeDirectoryPath(parentFolderPath);
  const existing = new Set(existingTreePaths);
  for (let i = 0; i < 100; i++) {
    const suffix = i === 0 ? '' : ` ${i + 1}`;
    if (kind === 'file') {
      const candidate = `${parent}Untitled${suffix}${DEFAULT_TREE_EXTENSION}`;
      if (!existing.has(candidate)) return { addPath: candidate, renamePath: candidate };
      continue;
    }

    const directory = `${parent}New Folder${suffix}/`;
    if (!existing.has(directory)) {
      return { addPath: directory, renamePath: directory };
    }
  }

  throw new Error('Could not allocate a unique tree placeholder');
}

export function createPagePathFromTreeDestination(
  kind: 'file' | 'folder',
  destinationTreePath: string,
): string {
  if (kind === 'file') return normalizeTreePathForKind(destinationTreePath, false);
  return `${treeDirectoryPathToFolderPath(destinationTreePath)}/index${DEFAULT_TREE_EXTENSION}`;
}

export function computeTreeDropDestinationPath(
  sourcePath: string,
  target: FileTreeDropTarget,
): string {
  if (target.kind === 'root' || target.directoryPath == null) return getTreeBasename(sourcePath);
  return `${target.directoryPath}${getTreeBasename(sourcePath)}`;
}

export function parentFolderPathForTreeItemDropTarget(treePath: string, isFolder: boolean): string {
  if (isFolder) {
    return treeDirectoryPathToFolderPath(folderPathToTreeDirectoryPath(treePath));
  }
  const appPath = treeFilePathToDocName(treePath);
  const slash = appPath.lastIndexOf('/');
  return slash === -1 ? '' : appPath.slice(0, slash);
}

export function uploadParentDocNameForFolderDrop(
  parentFolderPath: string,
  fileName: string,
): string {
  const parent = treeDirectoryPathToFolderPath(folderPathToTreeDirectoryPath(parentFolderPath));
  return parent ? `${parent}/${fileName}` : fileName;
}

export function appendSidebarUploadFields(
  formData: FormData,
  parentFolderPath: string,
  fileName: string,
): void {
  formData.append('parentDocName', uploadParentDocNameForFolderDrop(parentFolderPath, fileName));
  formData.append('placement', 'parent-dir');
}

export function uploadedPathForSidebarDrop(
  parentFolderPath: string,
  success: UploadAssetSuccess,
): string {
  return (success.path ?? uploadParentDocNameForFolderDrop(parentFolderPath, success.src)).replace(
    /^\/+/,
    '',
  );
}

interface ExternalFileDragLike {
  dataTransfer?: {
    types?: Iterable<string> | ArrayLike<string>;
  } | null;
}

interface ExternalFileDropLike {
  dataTransfer?: {
    files?: Iterable<File> | ArrayLike<File>;
  } | null;
}

export function isExternalFileDrag(event: ExternalFileDragLike): boolean {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  const list = Array.from(types);
  return list.includes('Files') && !list.includes(OK_SIDEBAR_DRAG_MIME);
}

export function filesFromExternalDrop(event: ExternalFileDropLike): File[] {
  return Array.from(event.dataTransfer?.files ?? []).filter(
    (file) => file.name.length > 0 || file.size > 0,
  );
}

export function fileEntryFromUploadedPath(
  path: string,
  file: Pick<File, 'size'>,
): FileEntry | null {
  const ext = getFileExtension(path).toLowerCase();
  if (ext === '') return null;
  const modified = new Date().toISOString();
  if (ext === '.md' || ext === '.mdx') {
    return {
      kind: 'document',
      docName: treeFilePathToDocName(path),
      docExt: ext,
      modified,
      size: file.size,
    };
  }
  const assetExt = ext.startsWith('.') ? ext.slice(1) : ext;
  return {
    kind: 'asset',
    path,
    assetExt,
    mediaKind: mediaKindForSidebarAssetExtension(assetExt),
    modified,
    size: file.size,
  };
}

function getTreeBasename(path: string): string {
  const stripped = stripTrailingSlash(path);
  const slash = stripped.lastIndexOf('/');
  const basename = slash === -1 ? stripped : stripped.slice(slash + 1);
  return path.endsWith('/') ? `${basename}/` : basename;
}

function stripTrailingSlash(path: string): string {
  return path.endsWith('/') ? path.slice(0, -1) : path;
}
