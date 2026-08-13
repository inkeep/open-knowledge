/**
 * Clicking a second highlight while the popover is open.
 *
 * The popover swaps its thread IN PLACE — the bus hands it the next id and
 * there is no null in between — so the card underneath is at the same position
 * in the tree with the same type across the swap. Unkeyed, React keeps that
 * instance: its open edit field, the draft seeded from the FIRST comment, and
 * the flag saying the edit had not settled yet all carried over to the second
 * thread, and the next settle filed one comment's words as a revision of
 * another. What pins the fix is that the card is a different card afterwards.
 */

import * as actualLinguiMacro from '@lingui/react/macro';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MockComposerMentionInput } from '@/components/acp/composer-mention-input.test-helper';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { CommentThread } from './types';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

// The real field is a ProseMirror contentEditable that jsdom cannot type into.
vi.doMock('@/editor/ComposerMentionInput', () => ({
  ComposerMentionInput: MockComposerMentionInput,
}));

function thread(id: string, body: string): CommentThread {
  return {
    id,
    docName: 'recipes/wiki',
    target: { kind: 'body' },
    anchor: { quote: 'the tofu', prefix: '', suffix: '', start: 0, end: 8 },
    status: 'open',
    body,
    createdAt: 1000,
    updatedAt: 1000,
    queued: true,
  };
}

const THREADS = [thread('t1', 'press it?'), thread('t2', 'drain it?')];
const editComment = vi.fn();

vi.doMock('./store', () => ({
  useCommentThreads: () => THREADS,
  useAllThreads: () => THREADS,
  useQueueSelection: () => [],
  subscribeOpenThreadPopover: (cb: (id: string | null) => void) => {
    openPopover = cb;
    return () => {
      openPopover = null;
    };
  },
  editComment,
  emitOpenThreadPopover: () => {},
  toggleSending: () => {},
  deleteThread: () => {},
  reopenThread: () => {},
  replaceOrphan: () => {},
  setActiveThread: () => {},
  clearActiveThread: () => {},
}));

// Positioning reads a live ProseMirror view; nothing here is about where the
// card lands.
vi.doMock('@/editor/utils/get-editor-view', () => ({ getEditorView: () => null }));
vi.doMock('@/editor/active-editor', () => ({ getVisibleEditorForDoc: () => null }));
vi.doMock('./anchor-search', () => ({
  findQuoteRange: () => null,
  captureSelectionContext: () => ({ prefix: '', suffix: '' }),
}));
vi.doMock('./property-row-rect', () => ({
  propertyRowRect: () => null,
  revealPropertyValueRange: () => true,
}));
vi.doMock('./comment-chips', () => ({
  propertyAddress: (key: string) => key,
  revealThread: () => {},
}));

let openPopover: ((id: string | null) => void) | null = null;

async function renderPopover() {
  const { CommentThreadPopover } = await import('./CommentThreadPopover');
  return render(
    <TooltipProvider>
      {/* biome-ignore lint/suspicious/noExplicitAny: structural editor double */}
      <CommentThreadPopover editor={{ state: {} } as any} docName="recipes/wiki" />
    </TooltipProvider>,
  );
}

beforeEach(() => editComment.mockClear());

afterEach(() => {
  cleanup();
  openPopover = null;
});

describe('retargeting the popover mid-edit', () => {
  test('the outgoing edit is filed against the comment it was typed on', async () => {
    await renderPopover();
    act(() => openPopover?.('t1'));
    fireEvent.click(await screen.findByRole('button', { name: /edit this comment/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /edit this comment/i }), {
      target: { value: 'press it overnight' },
    });

    // The reader clicks another highlight without dismissing this one first.
    // Wrapped, because the bus is not a React event — without flushing the
    // re-render the assertions would read the pre-swap tree and pass either way.
    act(() => openPopover?.('t2'));

    // Click-away saves, and the words belong to t1 — the card that held them.
    expect(editComment).toHaveBeenCalledWith('t1', 'press it overnight');
    expect(editComment).toHaveBeenCalledTimes(1);
  });

  test('the next thread arrives as a fresh card, not mid-edit', async () => {
    await renderPopover();
    act(() => openPopover?.('t1'));
    fireEvent.click(await screen.findByRole('button', { name: /edit this comment/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /edit this comment/i }), {
      target: { value: 'press it overnight' },
    });

    act(() => openPopover?.('t2'));

    // No field open, and the second comment's own text on screen — the field
    // used to survive the swap still holding the first comment's draft.
    expect(screen.queryByRole('textbox', { name: /edit this comment/i })).toBeNull();
    expect(screen.getByTestId('thread-comment-body').textContent).toBe('drain it?');
  });

  test('editing the second comment writes against the second id', async () => {
    await renderPopover();
    act(() => openPopover?.('t1'));
    act(() => openPopover?.('t2'));

    fireEvent.click(await screen.findByRole('button', { name: /edit this comment/i }));
    const field = screen.getByRole('textbox', { name: /edit this comment/i });
    // Seeded from t2, so the swap re-ran the seed rather than keeping t1's.
    expect((field as HTMLTextAreaElement).value).toBe('drain it?');

    fireEvent.change(field, { target: { value: 'drain it twice' } });
    fireEvent.click(screen.getByRole('button', { name: /save this comment/i }));

    expect(editComment).toHaveBeenCalledWith('t2', 'drain it twice');
  });
});
