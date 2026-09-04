import type { FileTreeDirectoryHandle, FileTree as PierreFileTreeModel } from '@pierre/trees';
import { type RefObject, useEffect } from 'react';

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
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: `treePathsSignature` is a re-run trigger, not a value read in the closure — it forces the mirror to re-assert selection after `model.resetPaths` rebuilds the tree. Sibling pattern: the reset + reveal-active-row effects in FileTree.tsx.
  useEffect(() => {
    const releaseSelectionSuppression = () => {
      queueMicrotask(() => {
        suppressSelectionRef.current = false;
      });
    };
    suppressSelectionRef.current = true;
    if (!activeTreePath) {
      deselectAllTreeItems(model);
      releaseSelectionSuppression();
      return;
    }
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
      deselectAllTreeItems(model);
      releaseSelectionSuppression();
      return;
    }
    if (model.getSelectedPaths().length > 1 && item.isSelected()) {
      item.focus();
      releaseSelectionSuppression();
      return;
    }
    selectOnlyTreeItem(model, item);
    item.focus();
    releaseSelectionSuppression();
  }, [
    activeAncestorTreePathsSignature,
    activeTreePath,
    model,
    suppressSelectionRef,
    treePathsSignature,
  ]);
}
