import type { OkNoteWindowMainAction } from '@inkeep/open-knowledge-core/desktop-bridge';
import { isNoteWindow } from '@/lib/note-window-mode';

export function routeNoteWindowActionToMain(
  action: OkNoteWindowMainAction,
  target: Pick<Window, 'dispatchEvent'> | EventTarget,
): boolean {
  if (typeof window === 'undefined' || target !== window || !isNoteWindow()) return false;
  const dispatch = window.okDesktop?.noteWindow?.dispatchToMain;
  if (typeof dispatch !== 'function') return false;

  void dispatch(action)
    .then((result) => {
      if (!result.ok) {
        console.warn('[note-window] main-window action dispatch declined', {
          reason: result.reason,
          kind: action.kind,
        });
      }
    })
    .catch((error: unknown) => {
      console.warn('[note-window] main-window action dispatch failed', error);
    });
  return true;
}
