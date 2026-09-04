import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { CommentThread } from './types';

const captured = { revealed: [] as string[], toggled: [] as string[], deleted: 0 };

vi.doMock('@/editor/active-editor', () => ({
  getVisibleEditorForDoc: () => null,
}));

vi.doMock('./comment-chips', () => ({
  propertyAddress: (key: string) => key,
  revealThread: (thread: CommentThread) => {
    captured.revealed.push(thread.id);
  },
}));

vi.doMock('./store', () => ({
  clearActiveThread: () => {},
  deleteThread: () => {
    captured.deleted += 1;
  },
  editComment: () => {},
  emitOpenThread: () => {},
  reopenThread: () => {},
  replaceOrphan: () => {},
  setActiveThread: () => {},
  toggleSending: (threadId: string) => {
    captured.toggled.push(threadId);
  },
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

function renderCard(overrides: Partial<CommentThread> = {}) {
  return render(
    <TooltipProvider>
      <ThreadCard
        thread={thread(overrides)}
        cardRef={() => {}}
        focused={false}
        active={false}
        sending={false}
      />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  captured.revealed = [];
  captured.toggled = [];
  captured.deleted = 0;
  window.getSelection()?.removeAllRanges();
});

afterEach(() => cleanup());

describe('clicking a card', () => {
  test('the body text ticks this comment', () => {
    renderCard();
    fireEvent.click(screen.getByTestId('thread-comment-body'));
    expect(captured.toggled).toEqual(['t1']);
    expect(captured.revealed).toEqual([]);
  });

  test("the card's whitespace ticks this comment", () => {
    renderCard();
    fireEvent.click(screen.getByRole('article'));
    expect(captured.toggled).toEqual(['t1']);
  });

  test('the checkbox does the same thing, once', () => {
    renderCard();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(captured.toggled).toEqual(['t1']);
  });

  test('the quote row keeps the jump, and a jump is not a tick', () => {
    renderCard();
    const row = screen.getByText(/the tofu/).closest('button');
    expect(row).not.toBeNull();
    if (row) fireEvent.click(row);
    expect(captured.revealed).toEqual(['t1']);
    expect(captured.toggled).toEqual([]);
  });

  test('delete stays delete', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /delete this comment/i }));
    expect(captured.deleted).toBe(1);
    expect(captured.toggled).toEqual([]);
  });

  test('a resolved card has no tick, so its body does nothing', () => {
    renderCard({ status: 'resolved' });
    fireEvent.click(screen.getByRole('article'));
    expect(captured.toggled).toEqual([]);
  });
});

describe('selecting text in a card', () => {
  function selectTextIn(node: Node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  test('a drag across the comment body does not tick the card', () => {
    renderCard();
    selectTextIn(screen.getByTestId('thread-comment-body'));
    fireEvent.click(screen.getByRole('article'));

    expect(captured.toggled).toEqual([]);
  });

  test('a selection somewhere else on the page leaves the click alone', () => {
    renderCard();
    const elsewhere = document.createElement('p');
    elsewhere.textContent = 'a passage in the document';
    document.body.append(elsewhere);
    selectTextIn(elsewhere);

    fireEvent.click(screen.getByRole('article'));
    expect(captured.toggled).toEqual(['t1']);
    elsewhere.remove();
  });

  test('an ordinary click with nothing selected still ticks', () => {
    renderCard();
    window.getSelection()?.removeAllRanges();
    fireEvent.click(screen.getByRole('article'));

    expect(captured.toggled).toEqual(['t1']);
  });
});
