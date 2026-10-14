import { flushSync } from 'react-dom';
import { paneVisibilityStore } from '@/lib/pane-visibility-store';

function editorHidden(): boolean {
  return paneVisibilityStore.getSnapshot().editor?.open === false;
}

export function revealEditor(): void {
  paneVisibilityStore.request('editor', true);
}

export function revealEditorBeforeActing(): void {
  if (editorHidden()) flushSync(revealEditor);
  else revealEditor();
}
