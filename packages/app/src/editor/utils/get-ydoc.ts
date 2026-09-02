import type { Editor } from '@tiptap/core';
import type { Doc } from 'yjs';

export function getYDoc(editor: Editor): Doc | undefined {
  if (editor.isDestroyed) return undefined;
  const collabExt = editor.extensionManager.extensions.find((e) => e.name === 'collaboration');
  return collabExt?.options?.document as Doc | undefined;
}
