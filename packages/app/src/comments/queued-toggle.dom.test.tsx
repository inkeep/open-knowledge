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
import type { Editor } from '@tiptap/react';
import { afterEach, describe, expect, test } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
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
    updatedAt: 1000,
    queued: true,
    ...overrides,
  };
}

function renderCard(t: CommentThread, sending = true) {
  // The card's hints are shadcn Tooltips, which Radix requires a provider for.
  // The app has one at its root; a standalone render has to bring its own.
  return render(
    <TooltipProvider>
      <ThreadCard thread={t} cardRef={() => {}} focused={false} sending={sending} />
    </TooltipProvider>,
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

/**
 * The revision field is the SAME composer a comment is written in — a mention
 * editor, not a textarea — so `@`-ing a file works in both. These reach the live
 * TipTap instance the way `ComposerMentionInput.dom.test.tsx` does: the textbox
 * node carries it.
 */
function openEdit(body: string) {
  renderCard(thread({ body }));
  fireEvent.click(screen.getByRole('button', { name: /edit this comment/i }));
  return screen.getByRole('textbox', { name: /edit this comment/i });
}

function editorOf(box: HTMLElement): Editor {
  return (box as unknown as { editor: Editor }).editor;
}

describe('opening an edit', () => {
  test('puts the caret after the existing text, not in front of it', async () => {
    const box = openEdit('press it?');
    await waitFor(() => expect(document.activeElement).toBe(box));

    // Focus alone would leave the caret at the document start — you would be
    // typing in front of your own sentence. The last position inside the
    // paragraph is `size - 1` (the paragraph's own close token is the last).
    const editor = editorOf(box);
    expect(editor.state.selection.from).toBe(editor.state.doc.content.size - 1);
  });

  test('seeds the field with the comment as it stands', () => {
    const box = openEdit('these quantities disagree');
    expect(box.textContent).toContain('these quantities disagree');
  });

  test('the field REPLACES the comment rather than opening under it', () => {
    openEdit('these quantities disagree');
    // One slot, never both: a field seeded from the text it sits under printed
    // the same sentence twice, inches apart. By test id, because the field's own
    // ProseMirror content is a `<p>` carrying the same words.
    expect(screen.queryByTestId('thread-comment-body')).toBeNull();
  });
});

describe('the active-thread tint', () => {
  test('the card being read in the document carries the highlight amber', () => {
    render(
      <TooltipProvider>
        <ThreadCard
          thread={thread()}
          cardRef={() => {}}
          focused={false}
          active={true}
          sending={false}
        />
      </TooltipProvider>,
    );
    // The same statement the document already makes in the other direction —
    // touching a card deepens its passage; an open popover tints its card.
    // A WASH, deliberately not a border: an outline reads as "this comment is
    // picked", and being read is not being selected — the tick owns that.
    const card = screen.getByRole('article');
    expect(card.className).toContain('bg-amber-500/10');
    expect(card.className).not.toContain('border-amber-500/60');
  });

  test('an inactive card carries none', () => {
    render(
      <TooltipProvider>
        <ThreadCard thread={thread()} cardRef={() => {}} focused={false} sending={false} />
      </TooltipProvider>,
    );
    expect(screen.getByRole('article').className).not.toContain('bg-amber-500/10');
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
    // Found by what it shows: the hint is a shadcn Tooltip now, which renders
    // nothing until it opens — and a disabled control never opens one.
    const target = screen.getByText('tags:').closest('button');
    expect(target?.hasAttribute('disabled')).toBe(true);
  });
});
