import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

async function renderHeaderSearchBar(onClick: () => void = () => {}) {
  const { HeaderSearchBar } = await import('./HeaderSearchBar');
  const { TooltipProvider } = await import('@/components/ui/tooltip');
  render(
    <TooltipProvider>
      <HeaderSearchBar onClick={onClick} className="extra-class" />
    </TooltipProvider>,
  );
}

describe('HeaderSearchBar runtime behavior', () => {
  afterEach(() => cleanup());

  test('exports the component', async () => {
    const mod = await import('./HeaderSearchBar');
    expect(typeof mod.HeaderSearchBar).toBe('function');
  });

  test('renders an accessible icon-only search button with the locked visual contract', async () => {
    await renderHeaderSearchBar();

    const button = screen.getByRole('button', { name: 'Search' });
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('aria-label')).toBe('Search');
    expect(button.getAttribute('data-slot')).toBe('tooltip-trigger');
    expect(button.getAttribute('data-variant')).toBe('ghost');
    expect(button.getAttribute('data-telemetry-event')).toBe('ok.app_header.search.click');
    expect(button.classList.contains('extra-class')).toBe(true);
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(button.textContent).toBe('');
    expect(button.querySelector('kbd')).toBeNull();
  });

  test('click delegates to the supplied handler', async () => {
    const clicks: string[] = [];
    await renderHeaderSearchBar(() => clicks.push('click'));

    await userEvent.click(screen.getByRole('button', { name: /Search/ }));

    expect(clicks).toEqual(['click']);
  });
});
