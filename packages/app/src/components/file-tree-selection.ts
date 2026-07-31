import type { InlineAssetMediaKind } from '@inkeep/open-knowledge-core';
import { isDocumentOverOpenByteLimit, isEditableTextDocFile } from '@inkeep/open-knowledge-core';
import { hashFromAssetPath } from '@/lib/doc-hash';
import {
  fileEntryToTreePath,
  treeFilePathToDocumentDocName,
  treePathToAppPath,
} from './file-tree-adapter';
import type { FileEntry } from './file-tree-utils';
import { isAssetEntry, isDocumentEntry, isFolderEntry } from './file-tree-utils';
import { docNameForNavigationTarget, type ResolvedNavigationTarget } from './navigation-targets';

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
    // The Skills hub + pre-install skill preview have no file-tree selection.
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

  const entry = entries.find((item) => fileEntryToTreePath(item) === selectedPath);
  const appPath = treePathToAppPath(selectedPath);
  const documentDocName = selectedPath.endsWith('/')
    ? appPath
    : treeFilePathToDocumentDocName(selectedPath, entries);
  if (documentDocName !== appPath) {
    return { kind: 'document', path: documentDocName };
  }
  if (entry && isAssetEntry(entry)) {
    // Mermaid files (`.mmd`/`.mermaid`) and editable text files (`.ts` /
    // `.json` / `.html` / …) are served as assets but open as editable CRDT
    // docs, not the read-only asset viewer. Their docName IS the asset path
    // (extension retained), so route the selection as a document.
    if (
      entry.mediaKind === 'mermaid' ||
      (isEditableTextDocFile(entry.path) && !isDocumentOverOpenByteLimit(entry.size))
    ) {
      // Oversized text files stay on the read-only asset viewer — the
      // verbatim load path has no large-doc defer, so seeding a multi-MB
      // file into Y.Text from a tree click would stall the doc open.
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

  // Inline rename can briefly select the not-yet-created destination path.
  // Dropping that transient file selection avoids opening an empty CRDT doc.
  if (!entries.some((item) => isDocumentEntry(item) && item.docName === appPath)) {
    return { kind: 'none' };
  }

  return { kind: 'document', path: appPath };
}
