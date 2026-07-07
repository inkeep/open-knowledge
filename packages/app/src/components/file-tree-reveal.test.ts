import { describe, expect, mock, test } from 'bun:test';
import type { FileTree } from '@pierre/trees';
import { revealActiveRow } from './file-tree-reveal';

type RevealModel = Pick<FileTree, 'getFocusedPath' | 'scrollToPath'>;

// `revealActiveRow` delegates to Pierre's imperative `scrollToPath` (beta.4+),
// so the contract is "scroll the focused path into view without stealing focus."
// A spy on the model is the behavior surface — no DOM/shadow-root walking left.
function makeModel(focusedPath: string | null) {
  const scrollToPath = mock(() => {});
  const model = {
    getFocusedPath: () => focusedPath,
    scrollToPath,
  } as unknown as RevealModel;
  return { model, scrollToPath };
}

describe('revealActiveRow', () => {
  test('scrolls the focused path into view without stealing DOM focus', () => {
    const { model, scrollToPath } = makeModel('docs/quickstart');
    revealActiveRow(model);
    expect(scrollToPath).toHaveBeenCalledTimes(1);
    expect(scrollToPath).toHaveBeenCalledWith('docs/quickstart', {
      offset: 'nearest',
      focus: false,
    });
  });

  test('no-ops when there is no focused row', () => {
    const { model, scrollToPath } = makeModel(null);
    revealActiveRow(model);
    expect(scrollToPath).not.toHaveBeenCalled();
  });
});
