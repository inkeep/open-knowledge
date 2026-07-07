import type {
  DuplicatePathSuccess,
  RenamedAssetMapping,
  RenamedDocMapping,
} from '@inkeep/open-knowledge-core';
import { mediaKindForSidebarAssetExtension } from '@inkeep/open-knowledge-core';
import {
  docNameToTreePath,
  resolveExtensionlessAssetPath,
  treeFilePathToDocName,
} from '@/components/file-tree-adapter';
import {
  getFileExtension,
  hasSupportedDocumentExtension,
} from '@/components/file-tree-rename-validation';
import {
  type FileEntry,
  isAssetEntry,
  isDocumentEntry,
  isFolderEntry,
  synthesizeFileAssetExt,
} from '@/components/file-tree-utils';
import { joinWorkspacePath, type Workspace } from '@/lib/workspace-paths';

// `RenamedDocMapping` is canonical in `@inkeep/open-knowledge-core` (mirrors
// `RenamedDocMappingSchema` for the `/api/rename-path` success body).
// `RenamedFolderMapping` is the parallel folder-rename mapping; it stays
// local for now until a core schema is added (future cleanup — pair with a
// `RenamedFolderMappingSchema` next to `RenamedDocMappingSchema`).
export type { RenamedAssetMapping, RenamedDocMapping };

export interface RenamedFolderMapping {
  fromPath: string;
  toPath: string;
}

export interface RenamedDocExtensionMapping {
  toDocName: string;
  docExt: string;
}

interface FileTreeTargetBase {
  path: string;
  name: string;
}

export type FileTreeTarget =
  | (FileTreeTargetBase & { kind: 'folder'; docExt?: undefined })
  | (FileTreeTargetBase & {
      kind: 'file';
      /** On-disk extension for markdown files (`.md` / `.mdx`). */
      docExt?: string;
    })
  | (FileTreeTargetBase & { kind: 'asset'; docExt?: undefined });

export function normalizeRenameValue(_kind: FileTreeTarget['kind'], value: string): string {
  // PRESERVE user-typed extension when present — it's the signal the server
  // uses to detect an extension-change rename (e.g., `foo.md` → `foo.mdx`).
  // Basename-only edits still work because the validator reattaches the source
  // extension before this value reaches `/api/rename-path`.
  return value.trim();
}

export function isValidNodeName(value: string): boolean {
  return (
    !['', '.', '..'].includes(value) &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\x00')
  );
}

export function buildRenamedNodePath(target: FileTreeTarget, nextName: string): string {
  const normalizedName = normalizeRenameValue(target.kind, nextName);
  const segments = target.path.split('/');
  segments[segments.length - 1] = normalizedName;
  return segments.join('/');
}

export function applyRenameToDocuments(
  documents: FileEntry[],
  renamed: RenamedDocMapping[],
  renamedFolders: RenamedFolderMapping[] = [],
  renamedAssets: RenamedAssetMapping[] = [],
  renamedDocExtensions: RenamedDocExtensionMapping[] = [],
): FileEntry[] {
  if (
    renamed.length === 0 &&
    renamedFolders.length === 0 &&
    renamedAssets.length === 0 &&
    renamedDocExtensions.length === 0
  ) {
    return documents;
  }
  const renamedMap = new Map(renamed.map((entry) => [entry.fromDocName, entry.toDocName]));
  const renamedDocExtMap = new Map(
    renamedDocExtensions.map((entry) => [entry.toDocName, entry.docExt]),
  );
  const renamedAssetMap = new Map(renamedAssets.map((entry) => [entry.fromPath, entry.toPath]));
  return documents.map((entry) => {
    if (isDocumentEntry(entry)) {
      const assetPath = renamedAssetMap.get(docNameToTreePath(entry.docName, entry.docExt));
      if (assetPath) {
        const assetExt = synthesizeFileAssetExt(assetPath);
        return {
          kind: 'asset',
          path: assetPath,
          assetExt,
          mediaKind: mediaKindForSidebarAssetExtension(assetExt),
          size: entry.size,
          modified: entry.modified,
          referencedBy: [],
        };
      }
      const docName = renamedMap.get(entry.docName) ?? entry.docName;
      return {
        ...entry,
        docName,
        docExt: renamedDocExtMap.get(docName) ?? entry.docExt,
      };
    }
    if (isFolderEntry(entry)) {
      return {
        ...entry,
        path: remapPathForFolderRenames(entry.path, renamedFolders),
      };
    }
    if (isAssetEntry(entry)) {
      const renamedAssetPath = renamedAssetMap.get(entry.path);
      if (renamedAssetPath && hasSupportedDocumentExtension(renamedAssetPath)) {
        return {
          kind: 'document',
          docName: treeFilePathToDocName(renamedAssetPath),
          docExt: getFileExtension(renamedAssetPath),
          size: entry.size,
          modified: entry.modified,
        };
      }
      return {
        ...entry,
        path: renamedAssetPath ?? remapPathForFolderRenames(entry.path, renamedFolders),
      };
    }
    return entry;
  });
}

export function applyDeleteToDocuments(
  documents: FileEntry[],
  deletedDocNames: string[],
  deletedFolderPath?: string,
  deletedAssetPaths: string[] = [],
): FileEntry[] {
  if (deletedDocNames.length === 0 && !deletedFolderPath && deletedAssetPaths.length === 0) {
    return documents;
  }
  const deleted = new Set(deletedDocNames);
  const deletedAssets = new Set(deletedAssetPaths);
  return documents.filter((entry) => {
    if (isDocumentEntry(entry)) {
      return !deleted.has(entry.docName) && !isPathInsideFolder(entry.docName, deletedFolderPath);
    }
    if (isFolderEntry(entry)) {
      return !isPathInsideFolder(entry.path, deletedFolderPath);
    }
    if (isAssetEntry(entry)) {
      return !deletedAssets.has(entry.path) && !isPathInsideFolder(entry.path, deletedFolderPath);
    }
    return true;
  });
}

export function canonicalizeAssetTargetForDelete(
  target: FileTreeTarget,
  documents: readonly FileEntry[],
): FileTreeTarget {
  // Client-side best effort for an extensionless inline-rename commit window;
  // the server still resolves against the filesystem as the trust boundary.
  if (target.kind !== 'asset') return target;
  if (documents.some((entry) => isAssetEntry(entry) && entry.path === target.path)) return target;

  const path = resolveExtensionlessAssetPath(target.path, documents);
  if (!path) return target;

  return {
    ...target,
    path,
    name: path.split('/').pop() ?? path,
  };
}

export function applyDuplicateToDocuments(
  documents: FileEntry[],
  target: FileTreeTarget,
  duplicate: DuplicatePathSuccess,
  modified = new Date().toISOString(),
): FileEntry[] {
  let changed = false;
  const next = [...documents];
  const addEntry = (entry: FileEntry) => {
    if (next.some((current) => entriesMatch(current, entry))) return;
    next.push(entry);
    changed = true;
  };

  if (duplicate.kind === 'file') {
    const source = documents.find(
      (entry): entry is Extract<FileEntry, { kind: 'document' }> =>
        isDocumentEntry(entry) && entry.docName === target.path,
    );
    addEntry({
      kind: 'document',
      docName: duplicate.path,
      docExt: source?.docExt ?? target.docExt,
      size: source?.size ?? 0,
      modified,
    });
    return changed ? next : documents;
  }

  const sourceFolder = documents.find(
    (entry): entry is Extract<FileEntry, { kind: 'folder' }> =>
      isFolderEntry(entry) && entry.path === target.path,
  );
  addEntry({
    kind: 'folder',
    path: duplicate.path,
    size: sourceFolder?.size ?? 0,
    modified,
  });

  const duplicatedDocs = new Set(duplicate.duplicatedDocNames);
  for (const entry of documents) {
    if (isDocumentEntry(entry)) {
      const docName = remapFolderDescendantPath(entry.docName, target.path, duplicate.path);
      if (docName && duplicatedDocs.has(docName)) {
        addEntry({ ...entry, docName, modified });
      }
      continue;
    }
    if (isFolderEntry(entry)) {
      const path = remapPathAtOrInsideFolder(entry.path, target.path, duplicate.path);
      if (path) addEntry({ ...entry, path, modified });
    }
  }

  return changed ? next : documents;
}

export function remapActiveDocName(
  activeDocName: string | null,
  renamed: RenamedDocMapping[],
): string | null {
  if (!activeDocName) return null;
  return renamed.find((entry) => entry.fromDocName === activeDocName)?.toDocName ?? activeDocName;
}

/**
 * Decide which docNames need `closeAndClearForRename` after a successful
 * `/api/rename-path`. Rename cleanup can also arrive through the server-push
 * redirect path, so the client response must not clear a destination provider
 * that has already been reopened. It also skips never-opened destinations:
 * the IDB delete would be a no-op, but the temporary `pendingClears` entry can
 * race the subsequent `pool.open(toDocName)` for a brand-new inline rename.
 */
export function planRenameCleanupCalls(
  renamed: readonly RenamedDocMapping[],
  poolActiveDocName: string | null,
  poolHas: (docName: string) => boolean,
): string[] {
  return renamed.flatMap((entry) => {
    const serverPushHandledTo = poolActiveDocName === entry.toDocName;
    if (serverPushHandledTo) return [entry.fromDocName];
    if (!poolHas(entry.toDocName)) return [entry.fromDocName];
    return [entry.fromDocName, entry.toDocName];
  });
}

/**
 * Build the OS-trash-bound absolute path for a tree target. Files reconstruct
 * the on-disk extension via `target.docExt`; folders and assets pass
 * `target.path` through unchanged.
 */
export function buildTrashAbsPath(target: FileTreeTarget, workspace: Workspace): string {
  const relative =
    target.kind === 'file' ? docNameToTreePath(target.path, target.docExt) : target.path;
  return joinWorkspacePath(workspace.contentDir, relative, workspace.pathSeparator);
}

function remapPathForFolderRenames(path: string, renamedFolders: RenamedFolderMapping[]): string {
  for (const { fromPath, toPath } of renamedFolders) {
    if (path === fromPath) return toPath;
    if (path.startsWith(`${fromPath}/`)) return `${toPath}${path.slice(fromPath.length)}`;
  }
  return path;
}

function entriesMatch(left: FileEntry, right: FileEntry): boolean {
  if (isDocumentEntry(left) && isDocumentEntry(right)) return left.docName === right.docName;
  if (isFolderEntry(left) && isFolderEntry(right)) return left.path === right.path;
  if (isAssetEntry(left) && isAssetEntry(right)) return left.path === right.path;
  return false;
}

function remapPathAtOrInsideFolder(
  path: string,
  fromFolderPath: string,
  toFolderPath: string,
): string | null {
  if (path === fromFolderPath) return toFolderPath;
  return remapFolderDescendantPath(path, fromFolderPath, toFolderPath);
}

function remapFolderDescendantPath(
  path: string,
  fromFolderPath: string,
  toFolderPath: string,
): string | null {
  if (!path.startsWith(`${fromFolderPath}/`)) return null;
  return `${toFolderPath}${path.slice(fromFolderPath.length)}`;
}

function isPathInsideFolder(path: string, folderPath: string | undefined): boolean {
  return !!folderPath && (path === folderPath || path.startsWith(`${folderPath}/`));
}
