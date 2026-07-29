/**
 * Pins the `ok:emoji-picker-open` → popover → insert contract:
 *
 *   1. Dispatching the open event mounts the caret-anchored picker popover.
 *   2. `insertEmojiAtCaret` lands the emoji as plain text at the caret (the
 *      select path's only editor mutation).
 *   3. Dismissing the popover returns focus to the editor.
 *
 * Tier: `.dom.test.tsx` (jsdom) — the popover anchors off a mounted TipTap
 * Editor's `view.coordsAtPos`.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, test } from 'vitest';
import { sharedExtensions } from '../extensions/shared';
import { openEmojiPickerForEditor } from '../slash-command/emoji-picker-event';
import { EmojiInsertPopover, insertEmojiAtCaret } from './EmojiInsertPopover';

function mountEditor(): { editor: Editor; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const editor = new Editor({
    element: container,
    extensions: sharedExtensions,
    editable: true,
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  });
  return { editor, container };
}

afterEach(cleanup);

describe('EmojiInsertPopover', () => {
  test('the open event mounts the picker anchored at the caret', async () => {
    const { editor, container } = mountEditor();
    try {
      render(<EmojiInsertPopover />);
      expect(screen.queryByTestId('emoji-picker-anchor')).toBeNull();

      openEmojiPickerForEditor({ editor });

      await waitFor(() => {
        expect(screen.getByTestId('emoji-picker-anchor')).toBeTruthy();
      });
    } finally {
      editor.destroy();
      container.remove();
    }
  });

  test('insertEmojiAtCaret lands the emoji as plain text at the caret', () => {
    const { editor, container } = mountEditor();
    try {
      editor.commands.insertContent({ type: 'text', text: 'before after' });
      editor.commands.setTextSelection(1 + 'before'.length);

      insertEmojiAtCaret(editor, '🎉');

      expect(editor.state.doc.textContent).toBe('before🎉 after');
    } finally {
      editor.destroy();
      container.remove();
    }
  });

  test('the open event with a destroyed editor mounts nothing', () => {
    const { editor, container } = mountEditor();
    render(<EmojiInsertPopover />);
    editor.destroy();
    container.remove();

    openEmojiPickerForEditor({ editor });

    expect(screen.queryByTestId('emoji-picker-anchor')).toBeNull();
  });

  test('dismissing after the editor was destroyed closes without throwing', async () => {
    const { editor, container } = mountEditor();
    render(<EmojiInsertPopover />);
    openEmojiPickerForEditor({ editor });
    await waitFor(() => {
      expect(screen.getByTestId('emoji-picker-anchor')).toBeTruthy();
    });

    editor.destroy();
    container.remove();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    await waitFor(() => {
      expect(screen.queryByTestId('emoji-picker-anchor')).toBeNull();
    });
  });

  test('pointer-down outside dismisses WITHOUT stealing focus back to the editor', async () => {
    const { editor, container } = mountEditor();
    const outside = document.createElement('button');
    outside.type = 'button';
    document.body.appendChild(outside);
    try {
      render(<EmojiInsertPopover />);
      openEmojiPickerForEditor({ editor });
      await waitFor(() => {
        expect(screen.getByTestId('emoji-picker-anchor')).toBeTruthy();
      });

      outside.focus();
      outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

      await waitFor(() => {
        expect(screen.queryByTestId('emoji-picker-anchor')).toBeNull();
      });
      // The refocus split's whole point: the clicked control keeps focus.
      expect(document.activeElement).toBe(outside);
      expect(editor.isFocused).toBe(false);
    } finally {
      outside.remove();
      editor.destroy();
      container.remove();
    }
  });

  test('dismissing the popover unmounts it and refocuses the editor', async () => {
    const { editor, container } = mountEditor();
    try {
      render(<EmojiInsertPopover />);
      openEmojiPickerForEditor({ editor });
      await waitFor(() => {
        expect(screen.getByTestId('emoji-picker-anchor')).toBeTruthy();
      });

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

      await waitFor(() => {
        expect(screen.queryByTestId('emoji-picker-anchor')).toBeNull();
      });
      // jsdom delivers the focus event (which flips `isFocused`) async.
      await waitFor(() => {
        expect(editor.isFocused).toBe(true);
      });
    } finally {
      editor.destroy();
      container.remove();
    }
  });
});
