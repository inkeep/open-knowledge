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
  return render(
    <TooltipProvider>
      <QueuedCommentsChip
        count={props.count ?? 3}
        {...(props.docs !== undefined ? { docs: props.docs } : {})}
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
    expect(revealed).toBe(1);
  });

  test('it offers no way to re-pick in place', async () => {
    await renderChip({ count: 3 });
    const chip = screen.getByTestId('composer-context-chip-comments');
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

    const chip = screen.getByTestId('composer-context-chip-comments');
    expect(chip.textContent).toContain('Comments');
    expect(chip.textContent).not.toContain('3');
    expect(chip.querySelector('svg.lucide-plus')).not.toBeNull();

    fireEvent.click(chip);
    expect(attached).toBe(1);
    expect(screen.queryByRole('button', { name: /leave these comments out/i })).toBeNull();
  });
});

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
    await renderChip({ count: 4 });
    const label = screen.getByTestId('composer-comments-open-panel').textContent;
    expect(label).toContain('4 comments');
    expect(label).not.toContain('file');
  });
});
