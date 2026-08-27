/**
 * SharingSection — the settings pane's shared / local-only toggle.
 *
 * The value under test is the pairing between what a row SAYS and what it
 * SENDS. `onSelect` feeds `bridge.sharing.setMode`, which adds or removes OK
 * paths in the user's real `.git/info/exclude`, so a label/value mismatch
 * would silently invert a privacy choice: a user clicking "Only me" would
 * publish the config they asked to keep local. Nothing pinned that pairing
 * before, and the rows were reordered so "Only me" leads.
 */

import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { OkSharingStatusResult } from '@/lib/desktop-bridge-types';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

vi.doMock('sonner', () => ({
  toast: { error: vi.fn(() => {}), info: vi.fn(() => {}), success: vi.fn(() => {}) },
}));

const { SharingSection } = await import('./SharingSection');
const { TooltipProvider } = await import('@/components/ui/tooltip');

const SHARED_STATUS: OkSharingStatusResult = {
  kind: 'status',
  mode: 'shared',
  excluded: [],
  trackedUpstream: [],
};

/** Installs a fake desktop bridge; returns the calls `setMode` received. */
function renderSection(status: OkSharingStatusResult = SHARED_STATUS) {
  const setModeCalls: string[] = [];
  const sharing = {
    status: vi.fn(() => Promise.resolve(status)),
    setMode: vi.fn((mode: string) => {
      setModeCalls.push(mode);
      return Promise.resolve({ kind: 'applied', mode });
    }),
  };
  // The component reads `window.okDesktop.sharing` directly rather than taking
  // a prop, so the bridge has to be installed on the global.
  (window as unknown as { okDesktop?: unknown }).okDesktop = { sharing };
  render(
    <TooltipProvider>
      <SharingSection />
    </TooltipProvider>,
  );
  return { setModeCalls, sharing };
}

describe('SharingSection', () => {
  afterEach(() => {
    cleanup();
    (window as unknown as { okDesktop?: unknown }).okDesktop = undefined;
  });

  test('"Only me" is the first option and its label matches its value', async () => {
    renderSection();

    const localOnly = await screen.findByTestId('settings-sharing-local-only');
    const shared = screen.getByTestId('settings-sharing-shared');

    // DOM order is the reading order: the leading card is "Only me".
    const radios = screen.getAllByRole('radio');
    expect(radios[0]).toBe(localOnly);
    expect(radios[1]).toBe(shared);

    // The label a user reads has to belong to the value that gets sent. Each
    // radio is associated to its own label by htmlFor/id, so walking from the
    // element to its label text is what catches a swapped pairing.
    const labelTextFor = (el: HTMLElement) => el.closest('label')?.textContent ?? '';
    expect(labelTextFor(localOnly)).toContain('Only me');
    expect(labelTextFor(shared)).toContain('Shared');
  });

  test('clicking "Only me" sends local-only to the bridge', async () => {
    const { setModeCalls } = renderSection();

    await userEvent.click(await screen.findByTestId('settings-sharing-local-only'));

    await waitFor(() => {
      expect(setModeCalls).toEqual(['local-only']);
    });
  });

  test('selecting the mode already in effect sends nothing', async () => {
    // The component short-circuits a no-op selection rather than re-running a
    // git-exclude write for a mode the project is already in.
    const { setModeCalls } = renderSection();

    await userEvent.click(await screen.findByTestId('settings-sharing-shared'));

    expect(setModeCalls).toEqual([]);
  });
});
