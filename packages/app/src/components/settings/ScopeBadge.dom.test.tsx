/**
 * DOM tests for ScopeBadge — the storage-scope indicator shown beside every
 * settings section heading. Asserts the visible label and the scope-specific
 * tooltip copy.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ScopeBadge, type SettingsScope } from './ScopeBadge';

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

function renderBadge(scope: SettingsScope) {
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

  test('project-local scope renders a "This machine" badge', () => {
    renderBadge('project-local');
    const badge = screen.getByTestId('settings-scope-badge-project-local');
    expect(badge.textContent).toBe('This machine');
    expect(screen.queryByTestId('settings-scope-badge-project')).toBeNull();
    expect(screen.queryByTestId('settings-scope-badge-user')).toBeNull();
  });

  // The user tooltip speaks to reach, not to a backing file: Configure agents
  // persists to localStorage and Hotkeys stores nothing, so a "stored in your
  // user config" claim would be false on pages this badge labels.
  test('user tooltip explains it stays on this device across every project', async () => {
    renderBadge('user');
    await userEvent.hover(screen.getByTestId('settings-scope-badge-user'));
    const tooltip = await screen.findAllByRole('tooltip');
    expect(within(tooltip[0]).getByText(/every project/i)).toBeDefined();
    expect(within(tooltip[0]).queryByText(/user config/i)).toBeNull();
  });

  test('project tooltip explains it is shared via git', async () => {
    renderBadge('project');
    await userEvent.hover(screen.getByTestId('settings-scope-badge-project'));
    const tooltip = await screen.findAllByRole('tooltip');
    // Names the project folder, not a file: this badge also covers .okignore,
    // the per-editor MCP files, .ok/skills/ and .ok/templates/.
    expect(within(tooltip[0]).getByText(/through git/i)).toBeDefined();
    expect(within(tooltip[0]).queryByText(/config\.yml/i)).toBeNull();
  });

  test('project-local tooltip explains it stays on this computer', async () => {
    renderBadge('project-local');
    await userEvent.hover(screen.getByTestId('settings-scope-badge-project-local'));
    const tooltip = await screen.findAllByRole('tooltip');
    expect(within(tooltip[0]).getByText(/\.ok\/local/i)).toBeDefined();
  });

  test('badge is keyboard-focusable and focus opens the tooltip', async () => {
    renderBadge('user');
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByTestId('settings-scope-badge-user'));
    const tooltip = await screen.findAllByRole('tooltip');
    expect(within(tooltip[0]).getByText(/every project/i)).toBeDefined();
  });
});
