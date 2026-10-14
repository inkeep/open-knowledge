import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { CommentThread } from './types';

const toastError = vi.fn();
const scrolled = { result: true };
const quoteRange = { value: null as { from: number; to: number } | null };
const propertyTarget = { value: null as HTMLElement | null };
const revealThread = vi.fn();

vi.doMock('sonner', () => ({ toast: { error: toastError } }));

vi.doMock('@/editor/active-editor', () => ({
  getVisibleEditorForDoc: () => ({ state: { doc: {} } }),
}));

vi.doMock('./anchor-search', () => ({
  captureSelectionContext: () => null,
  findQuoteRange: () => quoteRange.value,
}));

vi.doMock('./scroll-to-anchor', () => ({
  scrollAnchorIntoView: () => scrolled.result,
}));

vi.doMock('./property-row-rect', () => ({
  revealPropertyValueRange: () => propertyTarget.value,
}));

vi.doMock('./comment-chips', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./comment-chips')>()),
  revealThread,
}));

vi.doMock('./store', () => ({
  clearActiveThread: () => {},
  deleteThread: () => {},
  editComment: () => {},
  emitOpenThread: () => {},
  reopenThread: () => {},
  replaceOrphan: () => {},
  setActiveThread: () => {},
  toggleSending: () => {},
}));

const { ThreadCard } = await import('./ThreadCard');
const { __resetPropertiesCollapsedForTests, setPropertiesCollapsed } = await import(
  '@/components/properties-collapsed-store'
);

const thread: CommentThread = {
  id: 't1',
  docName: 'recipes/stir-fry',
  target: { kind: 'body' },
  anchor: { quote: 'the tofu', prefix: '', suffix: '', start: 0, end: 8 },
  status: 'open',
  body: 'press it?',
  createdAt: 1000,
  updatedAt: 1000,
  queued: true,
};

const propertyThread: CommentThread = {
  ...thread,
  id: 't2',
  target: { kind: 'property', key: 'servings', path: [] },
};

function clickQuote(clicked: CommentThread = thread) {
  render(
    <TooltipProvider>
      <ThreadCard
        layout="doc"
        thread={clicked}
        cardRef={() => {}}
        focused={false}
        active={false}
        sending={false}
      />
    </TooltipProvider>,
  );
  const row = screen.getByText(/the tofu/).closest('button');
  expect(row).not.toBeNull();
  if (row) fireEvent.click(row);
}

beforeEach(() => {
  toastError.mockClear();
  revealThread.mockClear();
  scrolled.result = true;
  quoteRange.value = null;
  propertyTarget.value = null;
});

afterEach(() => {
  cleanup();
  __resetPropertiesCollapsedForTests();
});

describe('jumping to a comment quote in the open document', () => {
  test('an unfound quote says so instead of doing nothing', () => {
    clickQuote();
    expect(toastError).toHaveBeenCalledWith(
      "Couldn't find that passage — the text it was on may have changed.",
    );
  });

  test('a found quote whose scroll is refused retries the reveal instead of saying it changed', () => {
    quoteRange.value = { from: 1, to: 9 };
    scrolled.result = false;
    clickQuote();
    expect(toastError).not.toHaveBeenCalled();
    expect(revealThread).toHaveBeenCalledWith(thread, undefined);
  });

  test('a property quote under collapsed Properties retries the reveal instead of saying it changed', () => {
    setPropertiesCollapsed(true);
    clickQuote(propertyThread);
    expect(toastError).not.toHaveBeenCalled();
    expect(revealThread).toHaveBeenCalledWith(propertyThread, undefined);
  });
});
