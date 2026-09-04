import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThreadCard } from './ThreadCard';
import type { CommentThread } from './types';

const QUOTE = 'add pepitas for crunch.';

function renderCard(overrides: Partial<CommentThread> = {}) {
  const thread: CommentThread = {
    id: 't1',
    docName: 'recipes/vegetarian/bowls',
    target: { kind: 'body' },
    anchor: { quote: QUOTE, prefix: '', suffix: '', start: 0, end: QUOTE.length },
    status: 'orphaned',
    body: 'test',
    createdAt: 0,
    updatedAt: 0,
    queued: true,
    ...overrides,
  };
  return render(
    <TooltipProvider>
      <ThreadCard
        thread={thread}
        cardRef={() => {}}
        focused={false}
        active={false}
        sending={false}
      />
    </TooltipProvider>,
  );
}

afterEach(cleanup);

describe('an orphaned card', () => {
  test('names the text that was deleted', () => {
    renderCard();
    expect(screen.getByText(`“${QUOTE}”`)).toBeTruthy();
  });

  test('says the original text was deleted, in words', () => {
    renderCard();
    expect(screen.getByText(/The original text was deleted/)).toBeTruthy();
  });

  test('still offers the one-click recovery', () => {
    renderCard();
    expect(screen.getByText('Re-place on selected text')).toBeTruthy();
  });

  test('carries no status badge — the block below is the only statement', () => {
    renderCard();
    expect(screen.queryByText(/[Oo]rphan/)).toBeNull();
    expect(screen.queryByText('Text deleted')).toBeNull();
    expect(screen.getByText(/The original text was deleted/)).toBeTruthy();
  });

  test('a resolved card keeps its badge, which nothing else replaces', () => {
    renderCard({ status: 'resolved' });
    expect(screen.getByText('Resolved')).toBeTruthy();
  });

  test('an orphan with no stored passage says so without inventing a quote', () => {
    renderCard({ anchor: null });
    expect(screen.getByText(/The original text was deleted/)).toBeTruthy();
    expect(screen.queryByText(/“/)).toBeNull();
  });

  test('an open card shows the live quote row, not the deleted-text block', () => {
    renderCard({ status: 'open' });
    expect(screen.queryByText(/The original text was deleted/)).toBeNull();
    expect(screen.getByText(`“${QUOTE}”`)).toBeTruthy();
  });
});
