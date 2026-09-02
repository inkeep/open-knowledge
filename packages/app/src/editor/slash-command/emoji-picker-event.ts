import type { Editor } from '@tiptap/react';

export const EMOJI_PICKER_OPEN_EVENT = 'ok:emoji-picker-open';

export interface EmojiPickerOpenDetail {
  editor: Editor;
}

export function openEmojiPickerForEditor(detail: EmojiPickerOpenDetail): void {
  if (typeof document === 'undefined') return;
  document.dispatchEvent(
    new CustomEvent<EmojiPickerOpenDetail>(EMOJI_PICKER_OPEN_EVENT, { detail }),
  );
}
