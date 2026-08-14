import type { OkNoteWindowMainAction } from '@inkeep/open-knowledge-core/desktop-bridge';
import { isNoteWindow } from '@/lib/note-window-mode';

/**
 * Hand one action from the reduced note renderer to its owning project window.
 *
 * Custom EventTargets are test seams and must stay window-local. Production
 * callers pass the default `window`; only that path is eligible for IPC.
 */
export function routeNoteWindowActionToMain(
  action: OkNoteWindowMainAction,
  target: Pick<Window, 'dispatchEvent'> | EventTarget,
): boolean {
  if (typeof window === 'undefined' || target !== window || !isNoteWindow()) return false;
  const dispatch = window.okDesktop?.noteWindow?.dispatchToMain;
  if (typeof dispatch !== 'function') return false;

  // The invoke RESOLVES with `{ ok: false, reason }` on a main-side refusal (the
  // project window closed in the cascade-close gap, say) — a `.catch` alone
  // would drop that silently, leaving no signal for diagnosis. Inspect the
  // resolved value the way `open-note-window.ts` does, and log both arms.
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
