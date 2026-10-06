import type { FileTreeDirectoryHandle, FileTree as PierreFileTreeModel } from '@pierre/trees';
import { type RefObject, useEffect, useRef } from 'react';
import { revealActiveRow } from './file-tree-reveal';

export function asDirectoryHandle(
  item: ReturnType<PierreFileTreeModel['getItem']>,
): FileTreeDirectoryHandle | null {
  if (!item?.isDirectory()) return null;
  return item as FileTreeDirectoryHandle;
}

function selectOnlyTreeItem(
  model: PierreFileTreeModel,
  item: NonNullable<ReturnType<PierreFileTreeModel['getItem']>>,
): void {
  const targetPath = item.getPath();
  for (const selectedPath of model.getSelectedPaths()) {
    if (selectedPath === targetPath) continue;
    model.getItem(selectedPath)?.deselect();
  }
  if (!item.isSelected()) {
    item.select();
  }
}

function keyboardFocusIsHeldByAnotherRow(
  model: Pick<PierreFileTreeModel, 'getFocusedPath'>,
  activeTreePath: string,
): boolean {
  const focusedPath = model.getFocusedPath();
  return focusedPath !== null && focusedPath !== activeTreePath;
}

function fileTreeHasDOMFocus(model: PierreFileTreeModel): boolean {
  const container = model.getFileTreeContainer();
  if (!container) return false;
  let activeElement = container.ownerDocument.activeElement;
  while (activeElement) {
    if (container.contains(activeElement)) return true;
    activeElement = activeElement.shadowRoot?.activeElement ?? null;
  }
  return false;
}

function deselectAllTreeItems(model: PierreFileTreeModel): void {
  for (const selectedPath of model.getSelectedPaths()) {
    model.getItem(selectedPath)?.deselect();
  }
}

export function useSelectionMirror(
  model: PierreFileTreeModel,
  activeTreePath: string | null,
  activeAncestorTreePathsSignature: string,
  suppressSelectionRef: RefObject<boolean>,
  treePathsSignature: string,
  { activeSelectionId, ready }: { activeSelectionId: string | null; ready: boolean },
): void {
  const lastActiveSelectionIdRef = useRef<string | null>(null);
  const lastReadyTreePathRef = useRef<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: treePathsSignature reasserts selection after model.resetPaths rebuilds the tree.
  useEffect(() => {
    const releaseSelectionSuppression = () => {
      queueMicrotask(() => {
        suppressSelectionRef.current = false;
      });
    };
    suppressSelectionRef.current = true;
    if (!activeTreePath) {
      lastActiveSelectionIdRef.current = null;
      lastReadyTreePathRef.current = null;
      deselectAllTreeItems(model);
      releaseSelectionSuppression();
      return;
    }
    const activeSelectionChanged = lastActiveSelectionIdRef.current !== activeSelectionId;
    lastActiveSelectionIdRef.current = activeSelectionId;
    const ancestorPaths = activeAncestorTreePathsSignature
      ? activeAncestorTreePathsSignature.split('\0')
      : [];
    for (const ancestor of ancestorPaths) {
      const item = asDirectoryHandle(model.getItem(ancestor));
      if (item && !item.isExpanded()) {
        item.expand();
      }
    }
    const item = model.getItem(activeTreePath);
    if (!item) {
      lastReadyTreePathRef.current = null;
      deselectAllTreeItems(model);
      releaseSelectionSuppression();
      return;
    }
    if (!(model.getSelectedPaths().length > 1 && item.isSelected())) {
      selectOnlyTreeItem(model, item);
    }
    if (!ready) {
      lastReadyTreePathRef.current = null;
      releaseSelectionSuppression();
      return;
    }
    const rowBecameReady = lastReadyTreePathRef.current !== activeTreePath;
    lastReadyTreePathRef.current = activeTreePath;
    const treeHasDOMFocus = fileTreeHasDOMFocus(model);
    if (
      activeSelectionChanged ||
      (!treeHasDOMFocus &&
        (rowBecameReady || !keyboardFocusIsHeldByAnotherRow(model, activeTreePath)))
    ) {
      item.focus();
      if (!treeHasDOMFocus) revealActiveRow(model, activeTreePath);
    }
    releaseSelectionSuppression();
  }, [
    activeAncestorTreePathsSignature,
    activeTreePath,
    activeSelectionId,
    ready,
    model,
    suppressSelectionRef,
    treePathsSignature,
  ]);
}
