import { startTransition, useEffect, useState } from 'react';
import {
  isEditableShortcutTarget,
  matchesKeyboardShortcut,
  type ShortcutEventLike,
} from '@/lib/keyboard-shortcuts';

export const SETTINGS_OPEN_HASH = '#settings';

interface SettingsRouteState {
  open: boolean;
  close: () => void;
}

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
