import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MockComposerMentionInput } from '@/components/acp/composer-mention-input.test-helper';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { CommentThread } from './types';

const editComment = vi.fn();
const deleteThread = vi.fn();

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
  const field = screen.getByRole('textbox', { name: /edit this comment/i });
  expect((field as HTMLTextAreaElement).value).toBe(t.body);
  return { view, field };
}

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

describe('the click-away commit', () => {
  test('an unmount mid-edit files what was typed', () => {
    const { view, field } = renderEditing();
    type(field, 'press it overnight');
    view.unmount();

    expect(editComment).toHaveBeenCalledWith('t1', 'press it overnight');
  });

  test('an unmount with the text untouched writes nothing', () => {
    const { view } = renderEditing();
    view.unmount();

    expect(editComment).not.toHaveBeenCalled();
  });

  test('deleting mid-edit discards the revision instead of filing it', () => {
    const { view, field } = renderEditing();
    type(field, 'press it overnight');
    fireEvent.click(screen.getByRole('button', { name: /delete this comment/i }));
    view.unmount();

    expect(deleteThread).toHaveBeenCalledWith('t1');
    expect(editComment).not.toHaveBeenCalled();
  });
});
