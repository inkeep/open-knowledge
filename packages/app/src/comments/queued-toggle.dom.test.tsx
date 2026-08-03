/**
 * The ready-to-send button's hover-swap affordance.
 *
 * "Ready to send" is a settled state that doubles as its own undo: ✓ at rest, ✕ on
 * hover. The properties worth pinning are the ones easy to lose in a restyle —
 * both glyphs must be present (a swap done by conditional render can't
 * cross-fade), the reveal must be keyboard-reachable and not pointer-only, and
 * the accessible name must say what the click DOES rather than echo the label.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ThreadCard } from './CommentsPanel';
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

function renderCard(t: CommentThread) {
  return render(<ThreadCard thread={t} now={2000} cardRef={() => {}} focused={false} />);
}

afterEach(() => cleanup());

describe('the ready-to-send toggle', () => {
  test('names the action, not the state', () => {
    renderCard(thread());
    // "Ready to send" is the visible label; the accessible name has to tell a screen
    // reader user that activating it REMOVES the comment from the batch.
    expect(screen.getByRole('button', { name: /don't send this comment/i })).toBeTruthy();
  });

  test('carries both glyphs so the swap can cross-fade', () => {
    const { container } = renderCard(thread());
    const button = screen.getByRole('button', { name: /don't send this comment/i });
    // Two absolutely-positioned icons, one visible at rest and one on hover —
    // rendering only the current glyph would make the transition impossible.
    expect(button.querySelectorAll('svg').length).toBe(2);
    expect(container.querySelector('.group\\/queued')).toBeTruthy();
  });

  test('reveals on keyboard focus as well as hover, but not after a click', () => {
    renderCard(thread());
    const markup = screen.getByRole('button', { name: /don't send this comment/i }).innerHTML;
    // Keyboard parity: hover alone would make this a pointer-only affordance.
    expect(markup).toContain('group-focus-visible/queued:opacity-100');
    expect(markup).toContain('group-hover/queued:opacity-100');
    // `focus-within` would match the focus a mouse click leaves behind, pinning
    // one card's ✕ open while every other card rests at ✓.
    expect(markup).not.toContain('group-focus-within/queued:');
  });

  test('a comment that is not in the batch offers Send later instead', () => {
    renderCard(thread({ id: 't2', queued: false }));
    expect(screen.getByRole('button', { name: /^send later$/i })).toBeTruthy();
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
    render(
      <ThreadCard
        thread={thread({ target: { kind: 'property', key: 'tags', path: [] }, anchor: null })}
      />,
    );
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
