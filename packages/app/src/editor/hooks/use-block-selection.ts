/**
 * useBlockSelection — React hook that exposes `SelectionStatePlugin` state
 * (Precedent #31) to the React tree.
 *
 * Implementation: subscribes to TipTap's `transaction` + `selectionUpdate`
 * events — the canonical TipTap integration pattern (same path used by
 * BubbleMenu, official example at tiptap.dev/guide/node-views#react).
 *
 * Stores the plugin snapshot in local state; the local state is updated
 * inside an event handler on every transaction/selection tick. React
 * re-renders whenever the snapshot reference changes (plugin's
 * `deriveBlockSelection` preserves identity on structural no-op so unrelated
 * text edits don't trigger re-renders).
 *
 * Why not `useSyncExternalStore` via the plugin's view.update notifier:
 *   empirically, React 19 + Strict Mode +
 *   the plugin-view update timing produced cases where the listener fired
 *   on an effect instance whose setState didn't propagate to a re-render.
 *   Wiring through `editor.on('transaction')` makes the subscription
 *   lifecycle TipTap-owned, which is proven out by the existing BubbleMenu
 *   + SideMenu implementations in this codebase.
 *
 * Returns `null` for a null editor (safe pre-mount rendering).
 */

import type { Editor } from '@tiptap/core';
import { useEffect, useState } from 'react';
import { type BlockSelection, getBlockSelection } from '../extensions/selection-state-plugin.ts';

export function useBlockSelection(editor: Editor | null): BlockSelection | null {
  const [snapshot, setSnapshot] = useState<BlockSelection | null>(() =>
    editor ? getBlockSelection(editor) : null,
  );

  useEffect(() => {
    if (!editor) {
      setSnapshot(null);
      return;
    }

    // Seed with the current state on mount.
    setSnapshot(getBlockSelection(editor));

    const update = () => {
      setSnapshot(getBlockSelection(editor));
    };

    editor.on('transaction', update);
    editor.on('selectionUpdate', update);
    return () => {
      editor.off('transaction', update);
      editor.off('selectionUpdate', update);
    };
  }, [editor]);

  return snapshot;
}
