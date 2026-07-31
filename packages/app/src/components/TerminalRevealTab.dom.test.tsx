import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TerminalRevealTab } from './TerminalRevealTab';

/** The two panels' labels, so a rename in the component fails one place here. */
const LABEL = { bottom: 'Open terminal', right: 'Open agents panel' } as const;

function renderTab(edge: 'bottom' | 'right') {
  const onReveal = vi.fn(() => {});
  render(
    // The app mounts a root TooltipProvider (main.tsx); supply one here so the
    // reveal tab's tooltip has its context in isolation.
    <TooltipProvider>
      <TerminalRevealTab edge={edge} onReveal={onReveal} />
    </TooltipProvider>,
  );
  return { onReveal };
}

describe('TerminalRevealTab', () => {
  afterEach(() => cleanup());

  test('names the panel it reopens and fires onReveal on click', async () => {
    const user = userEvent.setup();
    const { onReveal } = renderTab('right');

    await user.click(screen.getByRole('button', { name: LABEL.right }));

    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  test('labels each edge for its own panel, so the two are never confusable', () => {
    renderTab('right');
    expect(screen.getByRole('button', { name: LABEL.right })).toBeTruthy();
    expect(screen.queryByRole('button', { name: LABEL.bottom })).toBeNull();
    cleanup();

    renderTab('bottom');
    expect(screen.getByRole('button', { name: LABEL.bottom })).toBeTruthy();
    expect(screen.queryByRole('button', { name: LABEL.right })).toBeNull();
  });

  test('marks which edge it hugs so it sits where the collapse control was', () => {
    renderTab('right');
    expect(
      screen.getByRole('button', { name: LABEL.right }).getAttribute('data-terminal-reveal'),
    ).toBe('right');
    cleanup();

    renderTab('bottom');
    expect(
      screen.getByRole('button', { name: LABEL.bottom }).getAttribute('data-terminal-reveal'),
    ).toBe('bottom');
  });

  test('surfaces its label in a tooltip on hover', async () => {
    const user = userEvent.setup();
    renderTab('bottom');

    await user.hover(screen.getByRole('button', { name: LABEL.bottom }));

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain(LABEL.bottom);
  });
});
