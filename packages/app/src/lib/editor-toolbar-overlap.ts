import { isNoteWindow } from '@/lib/note-window-mode';

export const EDITOR_TOOLBAR_HEIGHT = 56;

export function editorToolbarOverlapPx(): number {
  return isNoteWindow() ? 0 : EDITOR_TOOLBAR_HEIGHT;
}
