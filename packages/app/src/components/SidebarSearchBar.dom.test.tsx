import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

async function renderSidebarSearchBar(onClick: () => void = () => {}) {
  const { SidebarSearchBar } = await import('./SidebarSearchBar');
  const { TooltipProvider } = await import('@/components/ui/tooltip');
  render(
    <TooltipProvider>
      <SidebarSearchBar onClick={onClick} className="extra-class" />
    </TooltipProvider>,
  );
}

describe('SidebarSearchBar runtime behavior', () => {
  afterEach(() => cleanup());

  test('exports the component', async () => {
    const mod = await import('./SidebarSearchBar');
    expect(typeof mod.SidebarSearchBar).toBe('function');
  });

  test('renders an accessible icon-only search button with the locked visual contract', async () => {
    await renderSidebarSearchBar();

    // Icon-only: the accessible name comes from the aria-label, not a visible
    // label span. The keyboard hint moved into the (portal-rendered, hover-only)
    // tooltip, so the button itself carries no visible text or kbd.
    const button = screen.getByRole('button', { name: 'Search' });
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('aria-label')).toBe('Search');
    // `asChild` merges the Radix trigger onto the Button, so `data-slot` reads
    // `tooltip-trigger` (Radix wins the merge) rather than the Button's own slot.
    expect(button.getAttribute('data-slot')).toBe('tooltip-trigger');
    expect(button.getAttribute('data-variant')).toBe('ghost');
    expect(button.getAttribute('data-telemetry-event')).toBe('ok.sidebar.search_pill.click');
    expect(button.classList.contains('extra-class')).toBe(true);
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(button.textContent).toBe('');
    expect(button.querySelector('kbd')).toBeNull();
  });

  test('click delegates to the supplied handler', async () => {
    const clicks: string[] = [];
    await renderSidebarSearchBar(() => clicks.push('click'));

    await userEvent.click(screen.getByRole('button', { name: /Search/ }));

    expect(clicks).toEqual(['click']);
  });
});
