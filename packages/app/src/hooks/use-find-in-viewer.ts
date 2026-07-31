/**
 * Shared Cmd/Ctrl+F capture for read-only viewer surfaces. The active
 * viewer is the only mounted surface with a live listener, so it owns the
 * shortcut even when focus remains in the sidebar after navigation.
 * Pair with `ProseFindBar`.
 */
import { type RefObject, useEffect, useState } from 'react';
import { isEditableShortcutTarget } from '@/lib/keyboard-shortcuts';

export function useFindInViewer(rootRef: RefObject<HTMLElement | null>): {
  findOpen: boolean;
  setFindOpen: (open: boolean) => void;
} {
  const [findOpen, setFindOpen] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: rootRef is a stable ref
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'f') return;
      const root = rootRef.current;
      if (root === null) return;
      const target = e.target;
      if (target instanceof Node && !root.contains(target) && isEditableShortcutTarget(target)) {
        return;
      }
      e.preventDefault();
      setFindOpen(true);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
  return { findOpen, setFindOpen };
}
