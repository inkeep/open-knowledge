import { isNoteWindow } from '@/lib/note-window-mode';

/** Height of the document overlay toolbar on ordinary editor surfaces. */
export const EDITOR_TOOLBAR_HEIGHT = 56;

/**
 * The note window promotes the breadcrumb and mode switch into its titlebar,
 * so document content has no overlay to clear.
 */
export function editorToolbarOverlapPx(): number {
  return isNoteWindow() ? 0 : EDITOR_TOOLBAR_HEIGHT;
}
