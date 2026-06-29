import type { Editor } from '@tiptap/react';
import { sliceToDocJson } from './clipboard/serialize.ts';
import { getSharedMarkdownManager } from './utils/md-singleton.ts';

export function serializeWysiwygSelection(editor: Editor): string {
  const slice = editor.state.selection.content();
  const json = sliceToDocJson(slice, editor.state.schema);
  return getSharedMarkdownManager().serialize(json).trim();
}
