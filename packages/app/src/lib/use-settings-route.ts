/**
 * Hash-based routing for the Settings dialog.
 *
 * One recognized hash form: `#settings` → dialog open.
 * The earlier per-scope sub-routes (`#settings/project`, `#settings/user`)
 * went away when the scope toggle was removed; sidebar group membership
 * communicates scope now, so there's nothing to encode in the hash.
 *
 * Closing the dialog navigates back via `history.back()` so the prior
 * doc hash is restored when settings was opened from a doc view. If the
 * prior history entry isn't part of this session (deep link),
 * `history.back()` exits the SPA — accepted trade-off; users can
 * press Forward to return.
 *
 * Sibling pattern to `NavigationHandler` and `InstallInClaudeDesktopTrigger`
 * in `App.tsx`: hash IS the route state; entry points (Cmd-,, Electron menu,
 * header `<SettingsButton>`, CommandPalette) mutate the hash; this hook
 * reads it.
 */

import { startTransition, useEffect, useState } from 'react';
import {
  isEditableShortcutTarget,
  matchesKeyboardShortcut,
  type ShortcutEventLike,
} from '@/lib/keyboard-shortcuts';

/**
 * Canonical hash literal for opening Settings via an entry point.
 * Mirrors the `INSTALL_DIALOG_HASH = '#install-claude-desktop'` precedent in
 * App.tsx — entry points (Cmd-,, Electron menu, header `<SettingsButton>`,
 * CommandPalette) all funnel through this single literal.
 */
export const SETTINGS_OPEN_HASH = '#settings';

interface SettingsRouteState {
  /** True when the dialog is open (hash is `#settings`). */
  open: boolean;
  /** Close the dialog via `history.back()`. No-op when already closed. */
  close: () => void;
}

/**
 * Cmd-, (macOS) / Ctrl-, (Windows/Linux) — the standard "open Settings" gesture.
 *
 * Suppresses on text inputs / textareas / contenteditable surfaces so a stray
 * Cmd-held-while-typing-comma in a number field doesn't hijack focus to the
 * Settings dialog. The Electron menu accelerator (set in `desktop/menu.ts`)
 * captures Cmd-, at the OS level for the Electron app and is independent of
 * this predicate; this predicate is the BROWSER-mode fallback. Same shape as
 * `isNewItemShortcut` in NewItemDialog.tsx.
 */
export function isSettingsShortcut(e: ShortcutEventLike): boolean {
  if (isEditableShortcutTarget(e.target)) return false;
  return matchesKeyboardShortcut(e, 'settings');
}

export function isSettingsHashOpen(hash: string): boolean {
  const cleaned = hash.replace(/^#/, '');
  return cleaned === 'settings';
}

function readCurrentHash(): string {
  if (typeof window === 'undefined') return '';
  return window.location.hash;
}

export function useSettingsRoute(): SettingsRouteState {
  const [open, setOpen] = useState<boolean>(() => isSettingsHashOpen(readCurrentHash()));

  useEffect(() => {
    const onHashChange = () => {
      // Wrap the open-state flip in a transition so a warm reopen — when
      // the lazy SettingsDialogBody chunk is already cached — commits the
      // resolved tree directly. Without the transition, React re-renders
      // the shell with `open=true` urgently and the lazy reference's
      // microtask resolution can flash the body's Suspense fallback for
      // one frame even when the chunk is fully loaded. The transition
      // tells React to keep the prior (closed) tree on screen while the
      // new tree resolves and only then commit — cached body chunks
      // resolve in the same task, so the dialog opens with content and
      // no skeleton flash. Cold opens still see the fallback (the chunk
      // genuinely needs to fetch); the dialog shell paints synchronously
      // in either case because it lives in the main bundle.
      startTransition(() => {
        setOpen(isSettingsHashOpen(readCurrentHash()));
      });
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const close = () => {
    if (typeof window === 'undefined') return;
    if (!isSettingsHashOpen(readCurrentHash())) return;
    window.history.back();
  };

  return { open, close };
}
