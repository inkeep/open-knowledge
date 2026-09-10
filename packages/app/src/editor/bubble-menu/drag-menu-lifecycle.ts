import type { Editor } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import { EDITOR_BUBBLE_MENU_KEY } from './bubble-menu-key';
import { shouldShowBubbleMenu } from './bubble-menu-state';

export function createDragMenuLifecycle(editor: Editor) {
  let activeView: EditorView | null = null;
  let dragDocument: Document | null = null;

  const cleanup = () => {
    dragDocument?.removeEventListener('dragend', finish);
    dragDocument?.removeEventListener('drop', finish);
    dragDocument = null;
    activeView = null;
  };

  const finish = () => {
    const view = activeView;
    cleanup();
    if (!view || view.isDestroyed) return;
    view.dragging = null;
    view.dispatch(
      view.state.tr.setMeta(
        EDITOR_BUBBLE_MENU_KEY,
        shouldShowBubbleMenu({ editor, view }) ? 'show' : 'hide',
      ),
    );
  };

  return {
    start(view: EditorView) {
      cleanup();
      view.dispatch(view.state.tr.setMeta(EDITOR_BUBBLE_MENU_KEY, 'hide'));
      activeView = view;
      dragDocument = view.dom.ownerDocument;
      dragDocument.addEventListener('dragend', finish);
      dragDocument.addEventListener('drop', finish);
    },
    destroy: cleanup,
  };
}
