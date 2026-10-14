import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { CommentThread } from './types';

const toastError = vi.fn();

vi.doMock('sonner', () => ({ toast: { error: toastError } }));

vi.doMock('@/components/doc-panel-events', () => ({ requestDocPanelTab: () => {} }));

vi.doMock('@/editor/active-editor', () => ({
  getVisibleEditorForDoc: () => ({ state: { doc: { content: { size: 0 } } }, isDestroyed: false }),
  subscribeEditorRegistry: () => () => {},
}));

vi.doMock('./store', () => ({
  clearActiveThread: () => {},
  deleteThread: () => {},
  editComment: () => {},
  emitFocusThread: () => {},
  emitOpenThread: () => {},
  reopenThread: () => {},
  replaceOrphan: () => {},
  setActiveThread: () => {},
  toggleSending: () => {},
}));

const { ThreadCard } = await import('./ThreadCard');
const { __resetPropertiesCollapsedForTests, getPropertiesCollapsed, setPropertiesCollapsed } =
  await import('@/components/properties-collapsed-store');

const MISSING = "Couldn't find that passage — the text it was on may have changed.";

const thread: CommentThread = {
  id: 't2',
  docName: 'recipes/stir-fry',
  target: { kind: 'property', key: 'servings', path: [] },
  anchor: { quote: 'the tofu', prefix: '', suffix: '', start: 0, end: 8 },
  status: 'open',
  body: 'press it?',
  createdAt: 1000,
  updatedAt: 1000,
  queued: true,
};

function renderPropertyRow(value: string): HTMLInputElement {
  const row = document.createElement('div');
  row.dataset.testid = 'property-row';
  row.dataset.key = 'servings';
  const input = document.createElement('input');
  input.value = value;
  row.append(input);
  document.body.append(row);
  return input;
}

function clickQuote() {
  render(
    <TooltipProvider>
      <ThreadCard
        layout="doc"
        thread={thread}
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
  vi.useFakeTimers();
  toastError.mockClear();
});

afterEach(() => {
  cleanup();
  for (const row of document.querySelectorAll('[data-testid="property-row"]')) row.remove();
  __resetPropertiesCollapsedForTests();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('jumping to a property comment', () => {
  test('a shown property whose value no longer holds the quote says so at once', () => {
    const input = renderPropertyRow('4 people');
    clickQuote();
    expect(input.value).toBe('4 people');
    expect(toastError).toHaveBeenCalledWith(MISSING);
  });

  test('expanded Properties with no rows left, after the last property was deleted, says so at once', () => {
    setPropertiesCollapsed(false);
    clickQuote();
    expect(document.querySelector('[data-testid="property-row"]')).toBeNull();
    expect(toastError).toHaveBeenCalledWith(MISSING);
  });

  test('collapsed Properties is expanded and revealed instead of reported missing', () => {
    setPropertiesCollapsed(true);
    clickQuote();
    expect(getPropertiesCollapsed()).toBe(false);
    expect(toastError).not.toHaveBeenCalled();
  });
});
