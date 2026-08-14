/**
 * The edit field's Save and Cancel row.
 *
 * The field used to be Enter-only. For an IME user the commit Enter belongs to
 * the composition — the keydown guard eats it, correctly — and with no visible
 * way to save, the revision sat in the field until the card closed. The row is
 * the fix, so what is worth pinning is that Save actually writes the revision
 * through, that Cancel actually discards it, and that the no-op cases
 * (unchanged, emptied) do not write at all.
 *
 * Cancel carries a second job the button did not have when the field was a
 * plain textarea: the card now SAVES on click-away, so a discard has to settle
 * the edit itself or the unmount commit would file the words Cancel just threw
 * out.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MockComposerMentionInput } from '@/components/acp/composer-mention-input.test-helper';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { CommentThread } from './types';

const editComment = vi.fn();
const deleteThread = vi.fn();

// The real field is a ProseMirror contentEditable that jsdom cannot type into.
vi.doMock('@/editor/ComposerMentionInput', () => ({
  ComposerMentionInput: MockComposerMentionInput,
}));

vi.doMock('@/editor/active-editor', () => ({
  getVisibleEditorForDoc: () => null,
}));

vi.doMock('./comment-chips', () => ({
  propertyAddress: (key: string) => key,
  revealThread: () => {},
}));

vi.doMock('./store', () => ({
  editComment,
  clearActiveThread: () => {},
  deleteThread,
  emitOpenThread: () => {},
  reopenThread: () => {},
  replaceOrphan: () => {},
  setActiveThread: () => {},
  toggleSending: () => {},
}));

const { ThreadCard } = await import('./ThreadCard');

function thread(overrides: Partial<CommentThread> = {}): CommentThread {
  return {
    id: 't1',
    docName: 'recipes/stir-fry',
    target: { kind: 'body' },
    anchor: { quote: 'the tofu', prefix: '', suffix: '', start: 0, end: 8 },
    status: 'open',
    body: 'press it?',
    createdAt: 1000,
    updatedAt: 1000,
    queued: true,
    ...overrides,
  };
}

function renderEditing(t: CommentThread = thread()) {
  const view = render(
    <TooltipProvider>
      <ThreadCard thread={t} cardRef={() => {}} focused={false} active={false} sending={false} />
    </TooltipProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /edit this comment/i }));
  // Seeded with the current text by the card's own effect, so this is also the
  // check that the field opens holding the comment rather than empty.
  const field = screen.getByRole('textbox', { name: /edit this comment/i });
  expect((field as HTMLTextAreaElement).value).toBe(t.body);
  return { view, field };
}

/** Type into the field the way the user would — every keystroke, so the card's
 *  emptiness tracking and its live-draft mirror both see it. */
function type(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
}

beforeEach(() => {
  editComment.mockClear();
  deleteThread.mockClear();
});
afterEach(() => cleanup());

describe('saving an edit', () => {
  test('the Save button writes the revision through and closes the field', () => {
    const { field } = renderEditing();
    type(field, 'press it overnight');
    fireEvent.click(screen.getByRole('button', { name: /save this comment/i }));

    expect(editComment).toHaveBeenCalledWith('t1', 'press it overnight');
    expect(screen.queryByRole('textbox', { name: /edit this comment/i })).toBeNull();
  });

  test('an unchanged comment closes without a write', () => {
    renderEditing();
    fireEvent.click(screen.getByRole('button', { name: /save this comment/i }));

    expect(editComment).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: /edit this comment/i })).toBeNull();
  });

  test('an emptied field cannot be saved', () => {
    const { field } = renderEditing();
    type(field, '   ');

    const save = screen.getByRole('button', { name: /save this comment/i });
    expect(save.hasAttribute('disabled')).toBe(true);
  });
});

describe('cancelling an edit', () => {
  test('Cancel discards the revision and the next open seeds the original', () => {
    const { field } = renderEditing();
    type(field, 'something else entirely');
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(editComment).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: /edit this comment/i })).toBeNull();

    // The discarded draft must not leak into the next edit.
    fireEvent.click(screen.getByRole('button', { name: /edit this comment/i }));
    const reopened = screen.getByRole('textbox', { name: /edit this comment/i });
    expect((reopened as HTMLTextAreaElement).value).toBe('press it?');
  });

  test('Cancel stands the click-away commit down — an unmount after it writes nothing', () => {
    const { view, field } = renderEditing();
    type(field, 'something else entirely');
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    view.unmount();

    expect(editComment).not.toHaveBeenCalled();
  });
});

/**
 * The click-away save itself.
 *
 * The guard above only means something if an unmount with a live draft DOES
 * write — otherwise it passes against a card that never saves anything, which
 * is exactly what it did while the field double dropped `onContentChange` on
 * the floor and left the live draft permanently null.
 */
describe('the click-away commit', () => {
  test('an unmount mid-edit files what was typed', () => {
    const { view, field } = renderEditing();
    type(field, 'press it overnight');
    // The popover host closes on any outside click, unmounting the card with
    // the field still open — Notion's behaviour is that this SAVES.
    view.unmount();

    expect(editComment).toHaveBeenCalledWith('t1', 'press it overnight');
  });

  test('an unmount with the text untouched writes nothing', () => {
    const { view } = renderEditing();
    view.unmount();

    expect(editComment).not.toHaveBeenCalled();
  });

  test('deleting mid-edit discards the revision instead of filing it', () => {
    // The card unmounts either way, but only one of them means "file what I
    // typed". Filed against a deleted thread, the write is refused and the
    // reader gets a failure toast on top of a delete that worked.
    const { view, field } = renderEditing();
    type(field, 'press it overnight');
    fireEvent.click(screen.getByRole('button', { name: /delete this comment/i }));
    view.unmount();

    expect(deleteThread).toHaveBeenCalledWith('t1');
    expect(editComment).not.toHaveBeenCalled();
  });
});
