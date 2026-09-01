import type { InlineAssetMediaKind } from '@inkeep/open-knowledge-core';
import {
  isDocumentOverOpenByteLimit,
  isEditableTextDocFile,
  TEXT_DOC_OPEN_BYTE_LIMIT,
} from '@inkeep/open-knowledge-core';
import { assetTabId, docTabId } from '@/editor/editor-tabs';
import { hashFromAssetPath } from '@/lib/doc-hash';
import {
  findEntryByTreePath,
  treeFilePathToDocumentDocName,
  treePathToAppPath,
} from './file-tree-adapter';
import type { DocumentEntry, FileEntry } from './file-tree-utils';
import { isAssetEntry, isDocumentEntry, isFolderEntry } from './file-tree-utils';
import {
  docNameForNavigationTarget,
  okContentNavigationTarget,
  type ResolvedNavigationTarget,
} from './navigation-targets';

interface FileTreeSelection {
  selectedFilePath: string | null;
  selectedFolderPath: string | null;
  navigationPath: string | null;
}

interface ResolveFileTreeSelectionOptions {
  isKnownDocument?: (docName: string) => boolean;
}

type FileTreeSelectionAction =
  | { kind: 'none' }
  | { kind: 'asset'; path: string; hash: string; mediaKind: InlineAssetMediaKind | null }
  | { kind: 'document'; path: string }
  | { kind: 'folder'; path: string };

function documentSelection(docName: string | null): FileTreeSelection {
  return {
    selectedFilePath: docName,
    selectedFolderPath: null,
    navigationPath: docName,
  };
}

export function resolveFileTreeSelection(
  activeTarget: ResolvedNavigationTarget | null,
  activeDocName: string | null,
  options: ResolveFileTreeSelectionOptions = {},
): FileTreeSelection {
  if (!activeTarget) {
    return documentSelection(activeDocName);
  }

  const targetDocName = docNameForNavigationTarget(activeTarget);
  if (activeDocName && targetDocName !== activeDocName) {
    return documentSelection(activeDocName);
  }

  switch (activeTarget.kind) {
    case 'doc': {
      const docName = activeDocName ?? activeTarget.docName;
      return documentSelection(docName);
    }
    case 'large-file':
      return documentSelection(activeTarget.docName);
    case 'folder':
    case 'folder-index':
      return {
        selectedFilePath: null,
        selectedFolderPath: activeTarget.folderPath,
        navigationPath: activeTarget.folderPath,
      };
    case 'missing':
      if (activeDocName && options.isKnownDocument?.(activeDocName)) {
        return documentSelection(activeDocName);
      }
      return {
        selectedFilePath: null,
        selectedFolderPath: null,
        navigationPath: null,
      };
    case 'asset':
    case 'skill-file':
    case 'skills':
    case 'skill-preview':
      return {
        selectedFilePath: null,
        selectedFolderPath: null,
        navigationPath: null,
      };
  }
}

export function resolveFileTreeSelectionAction(
  selectedPath: string | undefined,
  entries: readonly FileEntry[],
): FileTreeSelectionAction {
  if (!selectedPath) return { kind: 'none' };

  const entry = findEntryByTreePath(selectedPath, entries);
  const appPath = treePathToAppPath(selectedPath);
  const documentDocName = selectedPath.endsWith('/')
    ? appPath
    : treeFilePathToDocumentDocName(selectedPath, entries);
  if (documentDocName !== appPath) {
    return { kind: 'document', path: documentDocName };
  }
  if (entry && isAssetEntry(entry)) {
    if (
      entry.mediaKind === 'mermaid' ||
      entry.mediaKind === 'excalidraw' ||
      (isEditableTextDocFile(entry.path) &&
        !isDocumentOverOpenByteLimit(entry.size, TEXT_DOC_OPEN_BYTE_LIMIT))
    ) {
      return { kind: 'document', path: entry.path };
    }
    return {
      kind: 'asset',
      path: entry.path,
      hash: hashFromAssetPath(entry.path),
      mediaKind: entry.mediaKind,
    };
  }
  if (entry && isDocumentEntry(entry)) {
    return { kind: 'document', path: entry.docName };
  }

  if (selectedPath.endsWith('/')) {
    const hasFolderEntry = entries.some((item) => {
      if (isFolderEntry(item)) return item.path === appPath || item.path.startsWith(`${appPath}/`);
      const path = isAssetEntry(item) ? item.path : item.docName;
      return path.startsWith(`${appPath}/`);
    });
    if (!hasFolderEntry) return { kind: 'none' };
    return { kind: 'folder', path: appPath };
  }

  if (!entries.some((item) => isDocumentEntry(item) && item.docName === appPath)) {
    return { kind: 'none' };
  }

  return { kind: 'document', path: appPath };
}

export function previewTabIdForTreePath(
  treePath: string | undefined,
  entries: readonly FileEntry[],
  pages: ReadonlySet<string>,
): string | null {
  const action = resolveFileTreeSelectionAction(treePath, entries);
  if (action.kind === 'asset') return assetTabId(action.path);
  if (action.kind !== 'document') return null;
  const docEntry = entries.find(
    (item): item is DocumentEntry => isDocumentEntry(item) && item.docName === action.path,
  );
  const okTarget = okContentNavigationTarget(action.path, { pages, docExt: docEntry?.docExt });
  if (okTarget?.kind === 'asset') return assetTabId(okTarget.assetPath);
  if (okTarget?.kind === 'doc') return docTabId(okTarget.docName);
  return docTabId(action.path);
}
