/**
 * Pure tree-path helpers for the file sidebar: keyboard/selection target
 * resolution, delete-target planning, markdown-sibling checks, and the
 * row-decoration lookup index. Everything here is a pure function of its
 * inputs — no React, no DOM mutation, no network — except
 * `isEditableKeyboardTarget`, which performs a DOM read.
 */

import type { FileTree as PierreFileTreeModel } from '@pierre/trees';
import {
  docNameToTreePath,
  folderPathToTreeDirectoryPath,
  treeDirectoryPathToFolderPath,
  treeItemToTarget,
} from '@/components/file-tree-adapter';
import type { FileTreeTarget } from '@/components/file-tree-operations';
import {
  type DocumentEntry,
  type FileEntry,
  type FolderEntry,
  hasOkPathSegment,
  isAssetEntry,
  isDocumentEntry,
  isFolderEntry,
} from '@/components/file-tree-utils';

const MARKDOWN_TREE_EXTENSION_PATTERN = /\.(md|mdx)$/i;

export function parseAlreadyExistsRenamePath(message: string): string | null {
  const match = message.match(/^"(.+)" already exists\.$/);
  return match ? match[1] : null;
}

export function markdownTreeExtension(path: string): string | null {
  const match = path.match(MARKDOWN_TREE_EXTENSION_PATTERN);
  return match ? match[0] : null;
}

const AGENT_FILE_NAMES = new Set(['agents', 'agent', 'claude', 'skill']);

export function isAgentTreePath(treePath: string): boolean {
  const name = treePath.split('/').pop()?.replace(/\.md$/i, '').toLowerCase();
  return !!name && AGENT_FILE_NAMES.has(name);
}

function treePathToTarget(treePath: string, documents: readonly FileEntry[]): FileTreeTarget {
  return treeItemToTarget(
    {
      kind: treePath.endsWith('/') ? 'directory' : 'file',
      name: treePath,
      path: treePath,
    },
    documents,
  );
}

export function alternateMarkdownTreePath(treePath: string): string | null {
  const match = treePath.match(/\.(md|mdx)$/i);
  if (!match) return null;
  const ext = match[0].toLowerCase();
  const alternateExt = ext === '.md' ? '.mdx' : '.md';
  return `${treePath.slice(0, -match[0].length)}${alternateExt}`;
}

export function hasSameStemMarkdownSiblingTreePath(
  treePath: string,
  treePaths: readonly string[],
): boolean {
  const alternate = alternateMarkdownTreePath(treePath);
  if (!alternate) return false;
  return treePaths.includes(alternate);
}

function isTreePathInsideFolder(treePath: string, folderTreePath: string): boolean {
  return treePath !== folderTreePath && treePath.startsWith(folderTreePath);
}

export function selectedTreePathsToDeleteTargets(
  selectedTreePaths: readonly string[],
  documents: readonly FileEntry[],
): FileTreeTarget[] {
  // Revealed `.ok` rows are read-only OK-managed state — they never become
  // delete targets, even when swept into a multi-selection beside deletable
  // rows (this also keeps the confirm dialog's item count honest).
  const uniqueDeletablePaths = [...new Set(selectedTreePaths)].filter(
    (treePath) => !hasOkPathSegment(treePath),
  );
  const selectedFolderPaths = uniqueDeletablePaths.filter((treePath) => treePath.endsWith('/'));
  return uniqueDeletablePaths
    .filter(
      (treePath) =>
        !selectedFolderPaths.some((folderPath) => isTreePathInsideFolder(treePath, folderPath)),
    )
    .map((treePath) => treePathToTarget(treePath, documents));
}

function normalizeTreePathFromModel(model: PierreFileTreeModel, treePath: string): string {
  const selectedItem =
    model.getItem(treePath) ?? model.getItem(folderPathToTreeDirectoryPath(treePath));
  return selectedItem?.isDirectory()
    ? folderPathToTreeDirectoryPath(treeDirectoryPathToFolderPath(selectedItem.getPath()))
    : treePath;
}

function focusedOrFirstSelectedTreePath(model: PierreFileTreeModel): string | null {
  const selectedPath = model.getFocusedPath() ?? model.getSelectedPaths()[0] ?? null;
  return selectedPath ? normalizeTreePathFromModel(model, selectedPath) : null;
}

export function resolveDuplicableKeyboardTarget(
  model: PierreFileTreeModel,
  documents: readonly FileEntry[],
  assetTreePaths: ReadonlySet<string>,
): FileTreeTarget | null {
  const selectedPath = focusedOrFirstSelectedTreePath(model);
  // Revealed `.ok` rows are read-only OK-managed state — no keyboard
  // copy/paste/duplicate, matching their menu's suppressed affordances.
  if (!selectedPath || assetTreePaths.has(selectedPath) || hasOkPathSegment(selectedPath)) {
    return null;
  }
  return treePathToTarget(selectedPath, documents);
}

export function resolveKeyboardDeleteTargets(
  model: PierreFileTreeModel,
  documents: readonly FileEntry[],
): FileTreeTarget[] {
  const selectedPaths = model.getSelectedPaths();
  const focusedPath = focusedOrFirstSelectedTreePath(model);
  const paths =
    selectedPaths.length > 0
      ? selectedPaths.map((treePath) => normalizeTreePathFromModel(model, treePath))
      : focusedPath
        ? [focusedPath]
        : [];
  return selectedTreePathsToDeleteTargets(paths, documents);
}

function isPathAtOrInsideFolder(path: string, folderPath: string): boolean {
  return path === folderPath || path.startsWith(`${folderPath}/`);
}

export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName;
  return (
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    tagName === 'SELECT' ||
    target.isContentEditable ||
    target.closest('[contenteditable="true"]') !== null
  );
}

export function collectTabsToCloseForDelete(
  targets: readonly FileTreeTarget[],
  documents: readonly FileEntry[],
  folderTreePaths: readonly string[],
): { docNames: Set<string>; folderPaths: Set<string>; assetPaths: Set<string> } {
  const docNames = new Set<string>();
  const folderPaths = new Set<string>();
  const assetPaths = new Set<string>();

  for (const target of targets) {
    if (target.kind === 'file') {
      docNames.add(target.path);
      continue;
    }
    if (target.kind === 'asset') {
      assetPaths.add(target.path);
      continue;
    }

    folderPaths.add(target.path);
    for (const entry of documents) {
      if (isDocumentEntry(entry) && entry.docName.startsWith(`${target.path}/`)) {
        docNames.add(entry.docName);
      } else if (isAssetEntry(entry) && entry.path.startsWith(`${target.path}/`)) {
        assetPaths.add(entry.path);
      }
    }
    for (const treePath of folderTreePaths) {
      const folderPath = treeDirectoryPathToFolderPath(treePath);
      if (isPathAtOrInsideFolder(folderPath, target.path)) {
        folderPaths.add(folderPath);
      }
    }
  }

  return { docNames, folderPaths, assetPaths };
}

/**
 * The slice of FileTree's pending-create state this module needs — kept
 * structural so the component's richer lifecycle record stays local to it.
 */
export interface PendingCreateTarget {
  kind: 'file' | 'folder';
  createdPath: string;
}

export function deleteTargetCoversPendingCreate(
  target: FileTreeTarget,
  pending: PendingCreateTarget,
): boolean {
  if (target.kind === 'file') {
    return pending.kind === 'file' && target.path === pending.createdPath;
  }
  if (target.kind === 'asset') return false;
  return isPathAtOrInsideFolder(pending.createdPath, target.path);
}

export interface RowDecorationIndex {
  docsByTreePath: ReadonlyMap<string, DocumentEntry>;
  foldersByTreeDirectoryPath: ReadonlyMap<string, FolderEntry>;
}

/**
 * O(1) lookup index for `renderRowDecoration`, which the tree invokes per
 * visible row on every redraw — a linear scan of the document list there is
 * O(rows × entries). First entry wins on key collision, matching the
 * front-to-back `Array.find` this replaces.
 */
export function buildRowDecorationIndex(entries: readonly FileEntry[]): RowDecorationIndex {
  const docsByTreePath = new Map<string, DocumentEntry>();
  const foldersByTreeDirectoryPath = new Map<string, FolderEntry>();
  for (const entry of entries) {
    if (isDocumentEntry(entry)) {
      const treePath = docNameToTreePath(entry.docName, entry.docExt);
      if (!docsByTreePath.has(treePath)) docsByTreePath.set(treePath, entry);
    } else if (isFolderEntry(entry)) {
      const directoryPath = folderPathToTreeDirectoryPath(entry.path);
      if (!foldersByTreeDirectoryPath.has(directoryPath)) {
        foldersByTreeDirectoryPath.set(directoryPath, entry);
      }
    }
  }
  return { docsByTreePath, foldersByTreeDirectoryPath };
}
