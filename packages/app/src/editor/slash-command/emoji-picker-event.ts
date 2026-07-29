/**
 * `ok:emoji-picker-open` — fired by the slash menu's Emoji item after its
 * trigger-range delete commits. The singleton `EmojiInsertPopover` (mounted
 * at app shell scope, same posture as TagDialog) listens on `document`, so
 * the mount point stays decoupled from editor lifecycle — every Activity-pool
 * slot dispatches onto the one listener.
 */

import type { Editor } from '@tiptap/react';

export const EMOJI_PICKER_OPEN_EVENT = 'ok:emoji-picker-open';

export interface EmojiPickerOpenDetail {
  /** The editor whose caret the picker anchors to and inserts into. */
  editor: Editor;
}

export function openEmojiPickerForEditor(detail: EmojiPickerOpenDetail): void {
  if (typeof document === 'undefined') return;
  document.dispatchEvent(
    new CustomEvent<EmojiPickerOpenDetail>(EMOJI_PICKER_OPEN_EVENT, { detail }),
  );
}
