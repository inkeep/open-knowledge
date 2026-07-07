/**
 * Extract Y.Doc from a TipTap Editor's Collaboration extension.
 * Returns undefined if no Collaboration extension is found.
 */
import type { Editor } from '@tiptap/core';
import type { Doc } from 'yjs';

export function getYDoc(editor: Editor): Doc | undefined {
  // `extensionManager` and its `extensions` array are present on every live
  // Editor instance — accessing them during a disposed-editor's teardown is
  // the only realistic throw surface. Guard that one case and propagate any
  // other unexpected error so it reaches the nearest ErrorBoundary rather
  // than being silently absorbed.
  if (editor.isDestroyed) return undefined;
  const collabExt = editor.extensionManager.extensions.find((e) => e.name === 'collaboration');
  return collabExt?.options?.document as Doc | undefined;
}
