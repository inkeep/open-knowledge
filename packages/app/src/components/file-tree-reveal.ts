import type { FileTree as PierreFileTreeModel } from '@pierre/trees';

type RevealModel = Pick<PierreFileTreeModel, 'getFocusedPath' | 'scrollToPath'>;

export function revealActiveRow(model: RevealModel, activeTreePath: string): void {
  if (model.getFocusedPath() !== activeTreePath) return;
  model.scrollToPath(activeTreePath, { offset: 'nearest', focus: false });
}
