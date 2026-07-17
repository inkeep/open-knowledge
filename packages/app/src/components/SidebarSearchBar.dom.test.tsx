import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';

mock.module('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

async function renderSidebarSearchBar(onClick: () => void = () => {}) {
  const { SidebarSearchBar } = await import('./SidebarSearchBar');
  render(<SidebarSearchBar onClick={onClick} className="extra-class" />);
}

describe('SidebarSearchBar runtime behavior', () => {
  afterEach(() => cleanup());

  test('exports the component', async () => {
    const mod = await import('./SidebarSearchBar');
    expect(typeof mod.SidebarSearchBar).toBe('function');
  });

  test('renders an accessible visible-label search button with the locked visual contract', async () => {
    await renderSidebarSearchBar();

    const button = screen.getByRole('button', { name: /Search/ });
    expect(button.getAttribute('aria-label')).toBeNull();
    expect(button.getAttribute('data-slot')).toBe('button');
    expect(button.getAttribute('data-variant')).toBe('outline');
    expect(button.getAttribute('data-telemetry-event')).toBe('ok.sidebar.search_pill.click');
    expect(button.classList.contains('extra-class')).toBe(true);
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(button.querySelector('span')?.textContent).toBe('Search');
    expect(['⌘ K', 'Ctrl K']).toContain(button.querySelector('kbd')?.textContent);
  });

  test('click delegates to the supplied handler', async () => {
    const clicks: string[] = [];
    await renderSidebarSearchBar(() => clicks.push('click'));

    await userEvent.click(screen.getByRole('button', { name: /Search/ }));

    expect(clicks).toEqual(['click']);
  });
});
