/**
 * DOM test for AppMenubar's Help menu.
 *
 * AppMenubar is the custom-drawn Windows/Linux menu bar; it self-gates on
 * `window.okDesktop` and returns null on darwin, so its Help entries never
 * render during macOS review. These pin the two entries that route to in-app
 * dialogs, asserting the `bridge.menu.dispatch` payload each one sends.
 *
 * Invocation: `pnpm exec vitest run --config vitest.dom.config.ts
 * src/components/AppMenubar.dom.test.tsx` from `packages/app/`.
 */
import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen } from '@testing-library/react';
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

async function openHelpMenu() {
  const { AppMenubar } = await import('./AppMenubar');
  render(<AppMenubar />);
  await userEvent.click(screen.getByRole('menuitem', { name: 'Help' }));
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
