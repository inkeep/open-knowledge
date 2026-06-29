import type { FileTree as PierreFileTreeModel } from '@pierre/trees';

type RevealModel = Pick<PierreFileTreeModel, 'getFocusedPath' | 'scrollToPath'>;

export function revealActiveRow(model: RevealModel): void {
  const focusedPath = model.getFocusedPath();
  if (!focusedPath) return;
  model.scrollToPath(focusedPath, { offset: 'nearest', focus: false });
}
