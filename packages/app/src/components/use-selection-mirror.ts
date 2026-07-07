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

export function useSelectionMirror(
  model: PierreFileTreeModel,
  activeTreePath: string | null,
  activeAncestorTreePathsSignature: string,
  suppressSelectionRef: RefObject<boolean>,
  // Signature of the tree's path set. Threaded in as a re-run trigger so the
  // mirror re-asserts the selection AFTER `model.resetPaths()` repopulates the
  // tree. On a direct-URL / hash-nav first paint the active row's docName is
  // known from the hash before `/api/documents` lands; the first mirror run
  // then finds an empty tree (`model.getItem` returns null) and selects
  // nothing. When the docs arrive, `resetPaths` rebuilds the tree but neither
  // `activeTreePath` nor `activeAncestorTreePathsSignature` changes, so without
  // this trigger the mirror never re-runs and the row stays unselected (the
  // reveal-active-row effect already lists `treePathsSignature` for the same
  // reason). The reset effect is declared before this hook's call site, so on a
  // commit where the signature changes `resetPaths` runs first and the row is
  // present when the mirror re-selects it.
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
      for (const selectedPath of model.getSelectedPaths()) {
        model.getItem(selectedPath)?.deselect();
      }
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
      releaseSelectionSuppression();
      return;
    }
    // The mirror enforces "the active row must be selected," NOT "the active
    // row must be the SOLE selected row." Cmd+A and other multi-select gestures
    // populate Pierre's selection directly; a delayed React commit of
    // `activeTreePath` (from the click that preceded the multi-select) can
    // re-fire this effect after the multi-select burst, and collapsing back
    // to singleton would stomp the user's deliberate multi-selection. Only
    // re-assert singleton when the active row is absent from the current
    // selection (true navigation transition).
    if (model.getSelectedPaths().length > 1 && item.isSelected()) {
      item.focus();
      releaseSelectionSuppression();
      return;
    }
    selectOnlyTreeItem(model, item);
    item.focus();
    releaseSelectionSuppression();
    // `treePathsSignature` is a re-run trigger only — the effect body reads the
    // live `model`, not the signature value — so re-selecting after a tree
    // reset does not require reading it inside the closure.
  }, [
    activeAncestorTreePathsSignature,
    activeTreePath,
    model,
    suppressSelectionRef,
    treePathsSignature,
  ]);
}
