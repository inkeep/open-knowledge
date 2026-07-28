/**
 * DOM tests for AppMenubar's custom Windows/Linux menus.
 *
 * AppMenubar is the custom-drawn Windows/Linux menu bar; it self-gates on
 * `window.okDesktop` and returns null on darwin. These pin the Help entries
 * that route to in-app dialogs and the View history rows, including their
 * ordering, shortcut hints, and `bridge.menu.dispatch` payloads.
 *
 * Invocation: `pnpm exec vitest run --config vitest.dom.config.ts
 * src/components/AppMenubar.dom.test.tsx` from `packages/app/`.
 */
import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

type DispatchMock = ReturnType<typeof vi.fn>;

function installBridge(platform: string): DispatchMock {
  // `query` resolves null so the snapshot-gated rows stay hidden; the two
  // rows under test are unconditional.
  const dispatch = vi.fn(() => Promise.resolve(null));
  (window as unknown as { okDesktop?: unknown }).okDesktop = {
    platform,
    menu: { dispatch },
  };
  return dispatch;
}

async function openMenu(name: string) {
  const { AppMenubar } = await import('./AppMenubar');
  render(<AppMenubar />);
  await userEvent.click(screen.getByRole('menuitem', { name }));
}

async function openHelpMenu() {
  await openMenu('Help');
}

describe('AppMenubar Help menu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    (window as unknown as { okDesktop?: unknown }).okDesktop = undefined;
  });

  test('returns null on darwin, where the native menu bar owns Help', async () => {
    installBridge('darwin');
    const { AppMenubar } = await import('./AppMenubar');
    const { container } = render(<AppMenubar />);
    expect(container.firstChild).toBeNull();
  });

  test('returns null on the web host', async () => {
    const { AppMenubar } = await import('./AppMenubar');
    const { container } = render(<AppMenubar />);
    expect(container.firstChild).toBeNull();
  });

  test('Send feedback dispatches the send-feedback menu action', async () => {
    const dispatch = installBridge('win32');
    await openHelpMenu();

    await userEvent.click(screen.getByRole('menuitem', { name: 'Send feedback…' }));

    expect(dispatch).toHaveBeenCalledWith({ kind: 'menu-action', action: 'send-feedback' });
  });

  test('Report a bug dispatches the report-bug menu action', async () => {
    const dispatch = installBridge('win32');
    await openHelpMenu();

    await userEvent.click(screen.getByRole('menuitem', { name: 'Report a bug…' }));

    expect(dispatch).toHaveBeenCalledWith({ kind: 'menu-action', action: 'report-bug' });
  });

  test('Help entries read identically to the native menu, ellipsis included', async () => {
    installBridge('linux');
    await openHelpMenu();

    // Sentence case + the ellipsis on the two entries that open a form rather
    // than acting on click. Drift here means the two Help surfaces disagree.
    expect(screen.getByRole('menuitem', { name: 'Report a bug…' })).not.toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Send feedback…' })).not.toBeNull();
    expect(screen.getByRole('menuitem', { name: 'OpenKnowledge on GitHub' })).not.toBeNull();
  });
});

describe('AppMenubar View navigation history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    (window as unknown as { okDesktop?: unknown }).okDesktop = undefined;
  });

  test('does not add a standalone Go menu on Windows/Linux', async () => {
    installBridge('linux');
    const { AppMenubar } = await import('./AppMenubar');
    render(<AppMenubar />);

    const labels = within(screen.getByTestId('app-menubar'))
      .getAllByRole('menuitem')
      .map((item) => item.textContent);
    expect(labels).toEqual(['File', 'Edit', 'View', 'Window', 'Help']);
  });

  test('starts View with Back then Forward and Alt-arrow shortcut hints', async () => {
    installBridge('win32');
    await openMenu('View');

    const rows = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(rows.slice(0, 2).map((row) => row.textContent)).toEqual([
      'BackAlt+Left',
      'ForwardAlt+Right',
    ]);
  });

  test('dispatches each navigation-history action once', async () => {
    const dispatch = installBridge('linux');
    await openMenu('View');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ kind: 'query' });
    dispatch.mockClear();

    await userEvent.click(screen.getByRole('menuitem', { name: /Back/ }));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      kind: 'menu-action',
      action: 'navigate-back',
    });
    dispatch.mockClear();

    await userEvent.click(screen.getByRole('menuitem', { name: 'View' }));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ kind: 'query' });
    dispatch.mockClear();

    await userEvent.click(screen.getByRole('menuitem', { name: /Forward/ }));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      kind: 'menu-action',
      action: 'navigate-forward',
    });
  });
});
