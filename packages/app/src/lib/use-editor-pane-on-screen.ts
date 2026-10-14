import { createContext, use, useSyncExternalStore } from 'react';
import { paneVisibilityStore } from '@/lib/pane-visibility-store';

export const EditorContentOnScreenContext = createContext(true);

export function useEditorPaneOnScreen(): boolean {
  const contentOnScreen = use(EditorContentOnScreenContext);
  const paneOnScreen = useSyncExternalStore(
    paneVisibilityStore.subscribe,
    () => paneVisibilityStore.getSnapshot().editor?.onScreen ?? true,
    () => true,
  );
  return contentOnScreen && paneOnScreen;
}
