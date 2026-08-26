/**
 * What an orphaned card says, and what it still shows.
 *
 * Losing the passage used to print a bare "the anchored text is gone" and drop
 * the quote with it, so a panel of orphans was a column of identical blue
 * notices with no way to tell which comment had been on what. Orphaning mutates
 * state alone — the stored words survive — so the card shows them as the last
 * thing the comment was on.
 */

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
    // The strikethrough is reinforcement, not the message — a screen reader and
    // a monochrome display both get the fact from the sentence.
    renderCard();
    expect(screen.getByText(/The original text was deleted/)).toBeTruthy();
  });

  test('still offers the one-click recovery', () => {
    renderCard();
    expect(screen.getByText('Re-place on selected text')).toBeTruthy();
  });

  test('carries no status badge — the block below is the only statement', () => {
    // The state used to be announced twice: a badge in the header and the
    // sentence two lines under it. The sentence sits next to the words it is
    // about, so it is the one that stays. The wire state is still `orphaned`.
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
    // A whole-property comment carries no quote. The sentence still has to run.
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
