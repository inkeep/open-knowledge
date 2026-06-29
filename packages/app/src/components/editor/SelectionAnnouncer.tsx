import type { Editor } from '@tiptap/core';
import { useEffect, useRef } from 'react';
import { useBlockSelection } from '../../editor/hooks/use-block-selection.ts';
import { getEntryLabel } from '../../editor/selection/entry-label.ts';

const ANNOUNCE_DEBOUNCE_MS = 200;
const DESELECTION_MESSAGE = 'Outside any block';

export function SelectionAnnouncer({ editor }: { editor: Editor | null }) {
  const blockSelection = useBlockSelection(editor);
  const regionRef = useRef<HTMLDivElement | null>(null);
  const timeoutRef = useRef<number | null>(null);
  /** Tracks whether the most-recent announcement was non-empty. Used to
   *  decide if a transition to no-selection deserves a "deselection"
   *  announcement (transition matters; standing-empty does not). */
  const lastWasSelected = useRef(false);

  useEffect(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    if (!editor || !regionRef.current) return;

    const isSelected = blockSelection !== null && blockSelection.ancestorChain.length > 0;

    let message: string;
    if (isSelected) {
      message = formatSelectionMessage(editor, blockSelection);
    } else if (lastWasSelected.current) {
      message = DESELECTION_MESSAGE;
    } else {
      message = '';
    }

    timeoutRef.current = window.setTimeout(() => {
      if (regionRef.current) {
        regionRef.current.textContent = '';
        regionRef.current.textContent = message;
      }
      lastWasSelected.current = isSelected;
      timeoutRef.current = null;
    }, ANNOUNCE_DEBOUNCE_MS);

    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [editor, blockSelection]);

  return (
    <div ref={regionRef} role="status" aria-live="polite" aria-atomic="true" className="sr-only" />
  );
}

export function formatSelectionMessage(
  editor: Editor,
  blockSelection: ReturnType<typeof useBlockSelection>,
): string {
  if (!blockSelection || blockSelection.ancestorChain.length === 0) {
    return '';
  }

  const chain = blockSelection.ancestorChain;
  const innermost = chain[chain.length - 1];
  const innermostLabel = getEntryLabel(innermost, { unregisteredSuffix: true });

  if (chain.length === 1) {
    return `Selected: ${innermostLabel}`;
  }

  const parent = chain[chain.length - 2];
  const parentLabel = getEntryLabel(parent);

  try {
    const $pos = editor.state.doc.resolve(innermost.pos);
    const index = $pos.index($pos.depth);
    const total = $pos.parent.childCount;
    return `Selected: ${innermostLabel}, ${index + 1} of ${total} in ${parentLabel}`;
  } catch {
    return `Selected: ${innermostLabel} in ${parentLabel}`;
  }
}
