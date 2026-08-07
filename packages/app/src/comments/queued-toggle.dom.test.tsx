/**
 * The card's send tick, and the two states around it.
 *
 * The tick is the whole send decision now — both comment scopes list every
 * thread and the checkbox says which of them go out — so what is worth pinning
 * is that it reflects the passed-in sending state rather than the raw `queued`
 * flag (the two differ when a comment is unchecked from the composer chip), and
 * that a resolved thread offers none: it has been dealt with, and the queue
 * excludes it by construction.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ThreadCard } from './ThreadCard';
import type { CommentThread } from './types';

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

function renderCard(t: CommentThread, sending = true) {
  return render(
    <ThreadCard thread={t} now={2000} cardRef={() => {}} focused={false} sending={sending} />,
  );
}

afterEach(() => cleanup());

describe('the send tick', () => {
  test('names the action, not the state', () => {
    renderCard(thread());
    // Checked, so activating it REMOVES the comment from the batch — which is
    // what a screen reader user has to be told, rather than "checked".
    const tick = screen.getByRole('checkbox', { name: /don't send this comment/i });
    expect(tick.getAttribute('data-state')).toBe('checked');
  });

  test('follows the sending set, not the raw queued flag', () => {
    // Queued but unchecked from the composer chip: the panel has to show it as
    // it will actually behave, or ticking it would read as a no-op.
    renderCard(thread({ queued: true }), false);
    const tick = screen.getByRole('checkbox', { name: /^send this comment$/i });
    expect(tick.getAttribute('data-state')).toBe('unchecked');
  });

  test('a resolved thread carries no tick', () => {
    renderCard(thread({ status: 'resolved' }), false);
    expect(screen.queryByRole('checkbox')).toBeNull();
    // It offers the way back instead — dispatch auto-resolves, so reopening is
    // the correction when the agent didn't actually settle it.
    expect(screen.getByRole('button', { name: /reopen/i })).toBeTruthy();
  });
});

describe('opening an edit', () => {
  test('puts the caret after the existing text, not in front of it', async () => {
    renderCard(thread({ body: 'press it?' }));
    fireEvent.click(screen.getByRole('button', { name: /edit this comment/i }));

    const field = await screen.findByDisplayValue('press it?');
    await waitFor(() => expect(document.activeElement).toBe(field));
    // `autoFocus` alone would leave both at 0 — you would be typing in front of
    // your own sentence.
    expect((field as HTMLTextAreaElement).selectionStart).toBe('press it?'.length);
    expect((field as HTMLTextAreaElement).selectionEnd).toBe('press it?'.length);
  });

  test('seeds the field with the comment as it stands', async () => {
    renderCard(thread({ body: 'these quantities disagree' }));
    fireEvent.click(screen.getByRole('button', { name: /edit this comment/i }));
    expect(await screen.findByDisplayValue('these quantities disagree')).toBeTruthy();
  });
});

describe('a property thread in the panel', () => {
  test('shows its key as YAML instead of a quote, and offers no jump', () => {
    renderCard(thread({ target: { kind: 'property', key: 'tags', path: [] }, anchor: null }));
    // `tags:` reads as the frontmatter it is — which is the whole distinction
    // from a short quote, since both are a few characters of monospace.
    expect(screen.getByText('tags:')).toBeTruthy();
    // A whole-field comment has no words to reveal, so the control is inert
    // rather than scrolling the reader somewhere arbitrary. (A comment on a
    // passage INSIDE a value is clickable — it selects those words.)
    const target = screen.getByTitle(/on the whole property/i);
    expect(target.hasAttribute('disabled')).toBe(true);
  });
});
