/**
 * The ✕ on the queued-comments chip is a DISMISS, not a clear.
 *
 * It used to call `clearQueue()` — a server round-trip that unqueued every
 * thread in the project, with no confirmation and no undo — while wearing the
 * same affordance as the file chip's ✕ and the selection pill's ✕, both of which
 * only stop carrying context. Destroying the batch belongs to the All-comments
 * panel's labelled Clear. These pin the two controls apart.
 *
 * The chip is a read-out of what the Comments panel has ticked, not a second
 * picker: it carries no expandable list, so the panel stays the one place a
 * batch is chosen — and the count is the way there, since a chip naming a batch
 * you cannot reach is a dead end. It rides every message by default; the ✕ takes
 * it off this one and leaves the chip as the way back.
 */

import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

let revealed = 0;
vi.doMock('./reveal-queue', () => ({
  revealQueue: () => {
    revealed += 1;
  },
}));

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  // Renders the real plural FORM, not just the number: the chip's label is the
  // subject of the tests below, and a mock that dropped "comments"/"files" would
  // let them pass on a label that said neither.
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) => (
    <>{(value === 1 ? one : other).replace('#', String(value))}</>
  ),
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

afterEach(() => {
  cleanup();
  revealed = 0;
});

async function renderChip(
  props: Partial<{
    count: number;
    docs: readonly { docName: string; count: number }[];
    attached: boolean;
    onAttach: () => void;
    onDismiss: () => void;
  }> = {},
) {
  const { QueuedCommentsChip } = await import('./comment-chips');
  const { TooltipProvider } = await import('@/components/ui/tooltip');
  // Production wraps the app in one provider (main.tsx); the chip's per-file
  // breakdown is a Radix Tooltip, which throws without one.
  return render(
    <TooltipProvider>
      <QueuedCommentsChip
        count={props.count ?? 3}
        {...(props.docs !== undefined ? { docs: props.docs } : {})}
        // Attached by default, as the composers mount it.
        attached={props.attached ?? true}
        onAttach={props.onAttach ?? (() => {})}
        onDismiss={props.onDismiss ?? (() => {})}
      />
    </TooltipProvider>,
  );
}

describe('the queued-comments chip', () => {
  test('the ✕ dismisses', async () => {
    let dismissed = 0;
    await renderChip({
      onDismiss: () => {
        dismissed += 1;
      },
    });

    fireEvent.click(screen.getByRole('button', { name: /leave these comments out/i }));
    expect(dismissed).toBe(1);
  });

  test('its name says it affects the message, not the queue', async () => {
    await renderChip();
    // A name like "Clear queued comments" would promise destruction; this button
    // only takes the batch out of this one send.
    expect(
      screen.getByRole('button', { name: /leave these comments out of this message/i }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /clear/i })).toBeNull();
  });

  test('nothing ticked renders no chip', async () => {
    await renderChip({ count: 0 });
    expect(screen.queryByTestId('composer-context-chip-comments')).toBeNull();
  });

  test('the count opens the panel that owns the batch', async () => {
    await renderChip({ count: 3 });
    const chip = screen.getByTestId('composer-context-chip-comments');
    expect(chip.textContent).toContain('3');

    fireEvent.click(screen.getByTestId('composer-comments-open-panel'));
    // The panel opens on the whole queue — the batch spans documents, so the
    // open doc's own comments are not what this chip counted.
    expect(revealed).toBe(1);
  });

  test('it offers no way to re-pick in place', async () => {
    await renderChip({ count: 3 });
    const chip = screen.getByTestId('composer-context-chip-comments');
    // Attached, no `+` (it already rides this message) and no inline peek — the
    // count goes to the panel instead of growing a second list here.
    expect(chip.querySelector('svg.lucide-plus')).toBeNull();
    expect(screen.queryByTestId('composer-comments-list')).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  test('dismissed, it becomes the way back rather than disappearing', async () => {
    let attached = 0;
    await renderChip({
      attached: false,
      onAttach: () => {
        attached += 1;
      },
    });

    // Detached it names the SOURCE and carries no count: the number is a fact
    // about the message, and this batch is not on it.
    const chip = screen.getByTestId('composer-context-chip-comments');
    expect(chip.textContent).toContain('Comments');
    expect(chip.textContent).not.toContain('3');
    expect(chip.querySelector('svg.lucide-plus')).not.toBeNull();

    fireEvent.click(chip);
    expect(attached).toBe(1);
    // One control, one bit — detached, there is nothing to dismiss.
    expect(screen.queryByRole('button', { name: /leave these comments out/i })).toBeNull();
  });
});

/**
 * What the chip says when the batch crosses documents.
 *
 * A bare "5 comments" is honest and unreadable in that case: the reader is
 * looking at one file, the number counts comments they cannot see, and the send
 * goes on to edit documents they were not looking at. The chip says how far it
 * reaches; the names go in the tooltip, where a row shared with file chips
 * cannot grow by a path per document.
 */
describe('the chip across documents', () => {
  test('one file keeps the bare count', async () => {
    await renderChip({ count: 3, docs: [{ docName: 'recipes/a', count: 3 }] });
    const label = screen.getByTestId('composer-comments-open-panel').textContent;
    expect(label).toContain('3 comments');
    expect(label).not.toContain('file');
  });

  test('several files say how many', async () => {
    await renderChip({
      count: 5,
      docs: [
        { docName: 'recipes/a', count: 3 },
        { docName: 'recipes/b', count: 2 },
      ],
    });
    const label = screen.getByTestId('composer-comments-open-panel').textContent;
    expect(label).toContain('5 comments');
    expect(label).toContain('2 files');
  });

  test('told nothing, it degrades to the bare count rather than guessing', async () => {
    // A host that has not been updated to pass the tally must not make the chip
    // claim a span it does not know.
    await renderChip({ count: 4 });
    const label = screen.getByTestId('composer-comments-open-panel').textContent;
    expect(label).toContain('4 comments');
    expect(label).not.toContain('file');
  });
});
