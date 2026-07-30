/**
 * The ✕ on the queued-comments chip is a DISMISS, not a clear.
 *
 * It used to call `clearQueue()` — a server round-trip that unqueued every
 * thread in the project, with no confirmation and no undo — while wearing the
 * same affordance as the file chip's ✕ and the selection pill's ✕, both of which
 * only stop carrying context. Destroying the batch belongs to the Queue panel's
 * labelled Clear. These pin the three controls apart.
 */

import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  Plural: ({ value }: { value: number }) => <>{value}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

afterEach(() => cleanup());

async function renderChip(
  props: Partial<{
    count: number;
    attached: boolean;
    expanded: boolean;
    onAttach: () => void;
    onToggleExpanded: () => void;
    onDismiss: () => void;
  }> = {},
) {
  const { QueuedCommentsChip } = await import('./comment-chips');
  return render(
    <QueuedCommentsChip
      count={props.count ?? 3}
      // Attached by default: the ✕/peek distinction these pin down only exists
      // in that state.
      attached={props.attached ?? true}
      expanded={props.expanded ?? false}
      onAttach={props.onAttach ?? (() => {})}
      onToggleExpanded={props.onToggleExpanded ?? (() => {})}
      onDismiss={props.onDismiss ?? (() => {})}
    />,
  );
}

describe('the queued-comments chip', () => {
  test('the ✕ dismisses and does nothing else', async () => {
    let dismissed = 0;
    let expanded = 0;
    await renderChip({
      onDismiss: () => {
        dismissed += 1;
      },
      onToggleExpanded: () => {
        expanded += 1;
      },
    });

    fireEvent.click(screen.getByRole('button', { name: /leave these comments out/i }));
    expect(dismissed).toBe(1);
    expect(expanded).toBe(0);
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

  test('peeking is a separate control from dismissing', async () => {
    let dismissed = 0;
    let expanded = 0;
    await renderChip({
      onDismiss: () => {
        dismissed += 1;
      },
      onToggleExpanded: () => {
        expanded += 1;
      },
    });

    fireEvent.click(screen.getByTestId('composer-comments-peek'));
    expect(expanded).toBe(1);
    expect(dismissed).toBe(0);
  });

  test('an empty queue renders no chip', async () => {
    await renderChip({ count: 0 });
    expect(screen.queryByTestId('composer-context-chip-comments')).toBeNull();
  });

  test('attached, the chip drops the add affordance', async () => {
    await renderChip({ attached: true });
    // A `+` on a chip that is already carried would read as "add another".
    expect(
      screen.getByTestId('composer-context-chip-comments').querySelector('svg.lucide-plus'),
    ).toBeNull();
  });

  test('detached, the chip is the attach control', async () => {
    let attached = 0;
    let expanded = 0;
    await renderChip({
      attached: false,
      onAttach: () => {
        attached += 1;
      },
      onToggleExpanded: () => {
        expanded += 1;
      },
    });

    // Attaching is opt-in, so something has to say a queue exists before you opt
    // in — the chip's presence is that signal, and it names the source it would
    // pull from rather than the count it would carry.
    const chip = screen.getByTestId('composer-context-chip-comments');
    expect(chip.textContent).toContain('Queue');
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    // The two states occupy the same slot at different times, so the icon is what
    // distinguishes them — there is never a second chip to compare a fill against.
    expect(chip.querySelector('svg.lucide-plus')).not.toBeNull();

    fireEvent.click(chip);
    expect(attached).toBe(1);
    // One control, one bit: the detached chip neither peeks nor dismisses.
    expect(expanded).toBe(0);
    expect(screen.queryByRole('button', { name: /leave these comments out/i })).toBeNull();
    expect(screen.queryByTestId('composer-comments-peek')).toBeNull();
  });

  test('attaching is not sending — the chip only says what rides the message', async () => {
    await renderChip({ attached: false });
    // A name like "Send comments" would promise dispatch; this puts the batch on
    // the message and leaves the send to the send button.
    expect(
      screen.getByRole('button', { name: /add the queued comments to this message/i }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /send/i })).toBeNull();
  });
});
