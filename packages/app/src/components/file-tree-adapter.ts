import {
  isEditableTextDocFile,
  isExcalidrawDocFile,
  isMermaidDocFile,
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

export function docNameToTreePath(
  docName: string,
  docExt: string = DEFAULT_TREE_EXTENSION,
): string {
  if (
    TREE_EXTENSION_PATTERN.test(docName) ||
    isMermaidDocFile(docName) ||
    isExcalidrawDocFile(docName) ||
    isEditableTextDocFile(docName)
  ) {
    return docName;
  }
  return `${docName}${docExt}`;
}

export function treeFilePathToDocName(treePath: string): string {
  return stripTrailingSlash(treePath).replace(TREE_EXTENSION_PATTERN, '');
}

export function treeFilePathToDocumentDocName(
  treePath: string,
  documents: readonly FileEntry[],
): string {
  const normalized = stripTrailingSlash(treePath);
  const stemExtensions = markdownStemExtensions(documents);
  const exact =
    documents.find(
      (entry): entry is DocumentEntry =>
        isDocumentEntry(entry) && collectionTreePath(entry, stemExtensions) === normalized,
    ) ??
    documents.find(
      (entry): entry is DocumentEntry =>
        isDocumentEntry(entry) && fileEntryToTreePath(entry) === normalized,
    );
  if (exact) return exact.docName;
  const extensionless = treeFilePathToDocName(normalized);
  const collidingEntry = documents.find((entry) => {
    const entryTreePath = fileEntryToTreePath(entry);
    return (
      entryTreePath !== normalized &&
      TREE_EXTENSION_PATTERN.test(entryTreePath) &&
      treeFilePathToDocName(entryTreePath) === extensionless
    );
  });
  return collidingEntry && TREE_EXTENSION_PATTERN.test(normalized) ? normalized : extensionless;
}

export function findEntryByTreePath(
  treePath: string,
  documents: readonly FileEntry[],
): FileEntry | undefined {
  const stemExtensions = markdownStemExtensions(documents);
  return (
    documents.find((entry) => collectionTreePath(entry, stemExtensions) === treePath) ??
    documents.find((entry) => fileEntryToTreePath(entry) === treePath)
  );
}

export function fileEntryToTreePath(entry: FileEntry): string {
  if (isFolderEntry(entry)) return folderPathToTreeDirectoryPath(entry.path);
  return isAssetEntry(entry) ? entry.path : docNameToTreePath(entry.docName, entry.docExt);
}

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

function markdownStemExtensions(documents: readonly FileEntry[]): Map<string, ReadonlySet<string>> {
  const byStem = new Map<string, Set<string>>();
  for (const entry of documents) {
    if (!isDocumentEntry(entry)) continue;
    const match = entry.docName.match(TREE_EXTENSION_PATTERN);
    if (!match) continue;
    const stem = entry.docName.slice(0, -match[0].length);
    const extensions = byStem.get(stem);
    if (extensions) extensions.add(match[0]);
    else byStem.set(stem, new Set([match[0]]));
  }
  return byStem;
}

function collectionTreePath(
  entry: FileEntry,
  stemExtensions: ReadonlyMap<string, ReadonlySet<string>>,
): string {
  const treePath = fileEntryToTreePath(entry);
  if (!isDocumentEntry(entry)) return treePath;
  const match = entry.docName.match(TREE_EXTENSION_PATTERN);
  if (!match) return treePath;
  const stem = entry.docName.slice(0, -match[0].length);
  if ((stemExtensions.get(stem)?.size ?? 0) > 1) return treePath;
  return `${entry.docName}${entry.docExt ?? DEFAULT_TREE_EXTENSION}`;
}

export function documentsToTreePaths(documents: readonly FileEntry[]): string[] {
  const stemExtensions = markdownStemExtensions(documents);
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const entry of documents) {
    const path = collectionTreePath(entry, stemExtensions);
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

export function treePathSignature(paths: readonly string[]): string {
  return [...paths].sort().join('\0');
}

export function documentsTreePathSignature(documents: readonly FileEntry[]): string {
  return treePathSignature(documentsToTreePaths(documents));
}

export function collectTreeFolderPathsFromDocuments(
  documents: readonly FileEntry[],
  options: { includeOkFolders?: boolean } = {},
): string[] {
  const folderPaths = new Set<string>();
  for (const entry of documents) {
    const path = isFolderEntry(entry)
      ? entry.path
      : isAssetEntry(entry)
        ? entry.path
        : entry.docName;
    const segments = path.split('/').filter(Boolean);
    if (!options.includeOkFolders && segments.includes('.ok')) continue;
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
    : treeFilePathToDocumentDocName(item.path, documents);
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
