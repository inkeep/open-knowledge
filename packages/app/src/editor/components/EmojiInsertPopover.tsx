import { useLingui } from '@lingui/react/macro';
import type { Editor } from '@tiptap/react';
import { useEffect, useState } from 'react';
import { FrimousseEmojiPicker } from '@/components/emoji-picker';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import {
  EMOJI_PICKER_OPEN_EVENT,
  type EmojiPickerOpenDetail,
} from '@/editor/slash-command/emoji-picker-event';

export function insertEmojiAtCaret(editor: Editor, emoji: string): void {
  editor.chain().focus().insertContent({ type: 'text', text: emoji }).run();
}

interface CaretCoords {
  left: number;
  top: number;
  bottom: number;
}

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
