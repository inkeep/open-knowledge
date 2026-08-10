/**
 * The edit field's Save and Cancel row.
 *
 * The field used to be Enter-only. For an IME user the commit Enter belongs to
 * the composition — the keydown guard eats it, correctly — and with no visible
 * way to save, the revision sat in the field until the card closed and was
 * silently gone. The row is the fix, so what is worth pinning is that Save
 * actually writes the revision through, that Cancel actually discards it, and
 * that the no-op cases (unchanged, emptied) do not write at all.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CommentThread } from './types';

const editComment = vi.fn();

vi.doMock('./store', () => ({
  editComment,
  toggleSending: () => {},
  deleteThread: () => {},
  reopenThread: () => {},
  replaceOrphan: () => {},
  setActiveThread: () => {},
  clearActiveThread: () => {},
}));

function thread(overrides: Partial<CommentThread> = {}): CommentThread {
  return {
    id: 't1',
    docName: 'recipes/stir-fry',
    target: { kind: 'body' },
    anchor: { quote: 'the tofu', prefix: '', suffix: '', start: 0, end: 8 },
    status: 'open',
    body: 'press it?',
    createdAt: 1000,
    queued: true,
    ...overrides,
  };
}

async function renderEditing(t: CommentThread = thread()) {
  const { ThreadCard } = await import('./ThreadCard');
  const view = render(
    <ThreadCard thread={t} now={2000} cardRef={() => {}} focused={false} sending={false} />,
  );
  fireEvent.click(screen.getByRole('button', { name: /edit this comment/i }));
  const field = (await screen.findByDisplayValue(t.body)) as HTMLTextAreaElement;
  return { view, field };
}

beforeEach(() => editComment.mockClear());
afterEach(() => cleanup());

describe('saving an edit', () => {
  test('the Save button writes the revision through and closes the field', async () => {
    const { field } = await renderEditing();
    fireEvent.change(field, { target: { value: 'press it overnight' } });
    fireEvent.click(screen.getByRole('button', { name: /save this comment/i }));

    expect(editComment).toHaveBeenCalledWith('t1', 'press it overnight');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  test('an unchanged comment closes without a write', async () => {
    await renderEditing();
    fireEvent.click(screen.getByRole('button', { name: /save this comment/i }));

    expect(editComment).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  test('an emptied field cannot be saved', async () => {
    const { field } = await renderEditing();
    fireEvent.change(field, { target: { value: '   ' } });

    const save = screen.getByRole('button', { name: /save this comment/i });
    expect(save.hasAttribute('disabled')).toBe(true);
  });
});

describe('cancelling an edit', () => {
  test('Cancel discards the revision and the next open seeds the original', async () => {
    const { field } = await renderEditing();
    fireEvent.change(field, { target: { value: 'something else entirely' } });
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(editComment).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();

    // The discarded draft must not leak into the next edit.
    fireEvent.click(screen.getByRole('button', { name: /edit this comment/i }));
    expect(await screen.findByDisplayValue('press it?')).toBeTruthy();
  });
});
