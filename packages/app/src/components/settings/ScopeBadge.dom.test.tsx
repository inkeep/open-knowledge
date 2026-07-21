/**
 * DOM tests for ScopeBadge — the User/Project indicator shown in plugin panel
 * headers. Asserts the visible label and the scope-specific tooltip copy.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ScopeBadge } from './ScopeBadge';

// Radix Tooltip reaches for globals jsdom's preload doesn't expose.
type GlobalWithShims = typeof globalThis & { ResizeObserver?: unknown };
const g = globalThis as GlobalWithShims;
if (g.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  g.ResizeObserver = NoopResizeObserver;
}

function renderBadge(scope: 'user' | 'project') {
  return render(
    <TooltipProvider>
      <ScopeBadge scope={scope} />
    </TooltipProvider>,
  );
}

describe('ScopeBadge', () => {
  afterEach(() => cleanup());

  test('user scope renders a "User" badge', () => {
    renderBadge('user');
    const badge = screen.getByTestId('settings-scope-badge-user');
    expect(badge.textContent).toBe('User');
    expect(screen.queryByTestId('settings-scope-badge-project')).toBeNull();
  });

  test('project scope renders a "Project" badge', () => {
    renderBadge('project');
    const badge = screen.getByTestId('settings-scope-badge-project');
    expect(badge.textContent).toBe('Project');
    expect(screen.queryByTestId('settings-scope-badge-user')).toBeNull();
  });

  test('user tooltip explains it is stored in user config', async () => {
    renderBadge('user');
    await userEvent.hover(screen.getByTestId('settings-scope-badge-user'));
    const tooltip = await screen.findAllByRole('tooltip');
    expect(within(tooltip[0]).getByText(/user config/i)).toBeDefined();
  });

  test('project tooltip explains it is shared via git', async () => {
    renderBadge('project');
    await userEvent.hover(screen.getByTestId('settings-scope-badge-project'));
    const tooltip = await screen.findAllByRole('tooltip');
    expect(within(tooltip[0]).getByText(/config\.yml/i)).toBeDefined();
  });

  test('badge is keyboard-focusable and focus opens the tooltip', async () => {
    renderBadge('user');
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByTestId('settings-scope-badge-user'));
    const tooltip = await screen.findAllByRole('tooltip');
    expect(within(tooltip[0]).getByText(/user config/i)).toBeDefined();
  });
});
