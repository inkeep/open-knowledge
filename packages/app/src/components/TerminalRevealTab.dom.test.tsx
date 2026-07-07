import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TerminalRevealTab } from './TerminalRevealTab';

function renderTab(dockPosition: 'bottom' | 'right') {
  const onReveal = mock(() => {});
  render(
    // The app mounts a root TooltipProvider (main.tsx); supply one here so the
    // reveal tab's tooltip has its context in isolation.
    <TooltipProvider>
      <TerminalRevealTab dockPosition={dockPosition} onReveal={onReveal} />
    </TooltipProvider>,
  );
  return { onReveal };
}

describe('TerminalRevealTab', () => {
  afterEach(() => cleanup());

  test('exposes a "Show terminal" control and fires onReveal on click', async () => {
    const user = userEvent.setup();
    const { onReveal } = renderTab('right');

    await user.click(screen.getByRole('button', { name: 'Show terminal' }));

    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  test('marks which edge it hugs so it sits where the collapse control was', () => {
    renderTab('right');
    expect(
      screen.getByRole('button', { name: 'Show terminal' }).getAttribute('data-terminal-reveal'),
    ).toBe('right');
    cleanup();

    renderTab('bottom');
    expect(
      screen.getByRole('button', { name: 'Show terminal' }).getAttribute('data-terminal-reveal'),
    ).toBe('bottom');
  });

  test('surfaces its label in a tooltip on hover', async () => {
    const user = userEvent.setup();
    renderTab('bottom');

    await user.hover(screen.getByRole('button', { name: 'Show terminal' }));

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Show terminal');
  });
});
