/**
 * EmojiInsertPopover — opens in response to `ok:emoji-picker-open` events
 * fired by the slash menu's Emoji item. Anchors a frimousse picker at the
 * caret (tracking editor scroll while open); picking inserts the emoji as
 * plain text (emoji are ordinary Unicode, so GFM round-trips them
 * byte-for-byte) and returns focus to the editor. Escape also restores
 * focus; pointer/focus dismissal deliberately does NOT refocus — the
 * control the user clicked must keep the focus it just took (TipTap's
 * `focus` defers to rAF, so an unconditional refocus would land one frame
 * after the click and steal it back).
 *
 * Mounts once at app shell scope (EditorPane) — see TagDialog for the
 * singleton-listener rationale.
 */

import { useLingui } from '@lingui/react/macro';
import type { Editor } from '@tiptap/react';
import { useEffect, useState } from 'react';
import { FrimousseEmojiPicker } from '@/components/emoji-picker';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import {
  EMOJI_PICKER_OPEN_EVENT,
  type EmojiPickerOpenDetail,
} from '@/editor/slash-command/emoji-picker-event';

/**
 * Insert at the current caret rather than a position captured at open time:
 * remote CRDT edits can shift positions while the picker is up, and the
 * editor's own selection is the one thing the collab binding keeps mapped.
 */
export function insertEmojiAtCaret(editor: Editor, emoji: string): void {
  editor.chain().focus().insertContent({ type: 'text', text: emoji }).run();
}

interface CaretCoords {
  left: number;
  top: number;
  bottom: number;
}

/** `editor.view` is a throwing proxy before ProseMirror mount (WARN rule). */
function caretCoords(editor: Editor): CaretCoords | null {
  if (editor.isDestroyed) return null;
  try {
    const c = editor.view.coordsAtPos(editor.state.selection.from);
    return { left: c.left, top: c.top, bottom: c.bottom };
  } catch {
    return null;
  }
}

interface OpenState extends CaretCoords {
  editor: Editor;
}

export function EmojiInsertPopover() {
  const { t } = useLingui();
  const [state, setState] = useState<OpenState | null>(null);

  useEffect(() => {
    function onOpen(event: Event): void {
      const detail = (event as CustomEvent<EmojiPickerOpenDetail>).detail;
      if (!detail?.editor || detail.editor.isDestroyed) return;
      const coords = caretCoords(detail.editor);
      if (!coords) return;
      setState({ editor: detail.editor, ...coords });
    }
    document.addEventListener(EMOJI_PICKER_OPEN_EVENT, onOpen);
    return () => document.removeEventListener(EMOJI_PICKER_OPEN_EVENT, onOpen);
  }, []);

  // While open, follow the caret through editor scroll / viewport resize —
  // the fixed-position anchor otherwise parks at the open-time pixels.
  const openEditor = state?.editor ?? null;
  useEffect(() => {
    if (!openEditor) return;
    function reposition(): void {
      const editor = openEditor as Editor;
      const coords = caretCoords(editor);
      setState((current) => {
        if (!current || current.editor !== editor) return current;
        return coords ? { ...current, ...coords } : null;
      });
    }
    document.addEventListener('scroll', reposition, { capture: true, passive: true });
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('scroll', reposition, { capture: true });
      window.removeEventListener('resize', reposition);
    };
  }, [openEditor]);

  if (!state) return null;

  function close(refocus: boolean): void {
    if (!state) return;
    const { editor } = state;
    setState(null);
    if (refocus && !editor.isDestroyed) editor.commands.focus();
  }

  return (
    <Popover
      open
      onOpenChange={(open) => {
        // Fallback for dismissal paths not covered by the explicit
        // callbacks below; those run first in the same tick, so this
        // close is a no-op after them.
        if (!open) close(false);
      }}
    >
      <PopoverAnchor asChild>
        <span
          aria-hidden
          data-testid="emoji-picker-anchor"
          className="pointer-events-none fixed"
          style={{ left: state.left, top: state.top, height: state.bottom - state.top }}
        />
      </PopoverAnchor>
      <PopoverContent
        className="w-auto p-0"
        align="start"
        aria-label={t`Emoji picker`}
        data-testid="emoji-picker-popover"
        onEscapeKeyDown={() => close(true)}
        onInteractOutside={() => close(false)}
      >
        <FrimousseEmojiPicker
          onSelect={(emoji) => {
            const editor = state.editor;
            setState(null);
            insertEmojiAtCaret(editor, emoji);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
