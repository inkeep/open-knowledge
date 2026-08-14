/**
 * One card, two click meanings — and neither may bleed into the other.
 *
 * The card's whitespace and body are a bigger target for its own TICK; the
 * quote row keeps the JUMP. They used to differ: the body meant "send only this
 * one", clearing every other comment, which readers reached for expecting the
 * additive meaning they get from a checklist. What these pin is the split —
 * each gesture fires its own action and never also the other.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { CommentThread } from './types';

const captured = { revealed: [] as string[], toggled: [] as string[], deleted: 0 };

// No visible editor: the jump routes through `revealThread`, which is the one
// observable seam shared by the local and cross-document paths.
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
  // A selection left behind by one test would change what a click means in the
  // next — the card now reads it.
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
    // The card body is a bigger target for this control, not a second one, so
    // a click on the box itself must not also run the card handler.
    renderCard();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(captured.toggled).toEqual(['t1']);
  });

  test('the quote row keeps the jump, and a jump is not a tick', () => {
    renderCard();
    // Found by the quote it shows — the row's hint is a Tooltip, which renders
    // nothing until it opens, so the quote is the button's accessible name.
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

/**
 * Selecting a card's words is reading, not ticking.
 *
 * A drag that ends inside the element it started in still fires a click on it,
 * so copying a sentence out of a comment also flipped whether that comment was
 * going to be sent — the batch changed under a gesture that never touched a
 * control.
 */
describe('selecting text in a card', () => {
  /** Put a real selection across `node`'s text, the way a drag leaves one. */
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
    // The panel sits beside a document whose text readers select constantly.
    // Reading the selection without asking WHERE it is would swallow every
    // click on a card made while a passage was highlighted.
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
