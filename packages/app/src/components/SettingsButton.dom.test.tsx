import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderSettingsBody } from '@/test-utils/render-settings-body.test-helper';

const preloadCalls: string[] = [];

import * as actualLinguiMacro from '@lingui/react/macro';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.doMock('@/components/settings/SettingsDialogBodyLazy', () => ({
  preloadSettingsOnIntent: () => {
    preloadCalls.push('preload');
    return Promise.resolve();
  },
}));

async function renderSettingsButton() {
  const { SettingsButton } = await import('./SettingsButton');
  return render(
    <TooltipProvider>
      <SettingsButton />
    </TooltipProvider>,
  );
}

function flushPendingPreloadTimers() {
  act(() => {
    vi.runOnlyPendingTimers();
  });
}

describe('SettingsButton runtime behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    preloadCalls.length = 0;
    window.location.hash = '';
  });

  test('exports the component', async () => {
    const mod = await import('./SettingsButton');
    expect(typeof mod.SettingsButton).toBe('function');
  });

  test('renders the header settings button with an accessible label', async () => {
    await renderSettingsButton();

    const button = screen.getByTestId('header-settings-button');
    expect(button.tagName).toBe('BUTTON');
    expect(button.textContent).toBe('Settings');
    expect(button.querySelector('svg')).not.toBeNull();
  });

  test('click opens the canonical settings hash and cancels a pending preload', async () => {
    await renderSettingsButton();

    const button = screen.getByTestId('header-settings-button');
    act(() => {
      fireEvent.mouseEnter(button);
      fireEvent.click(button);
    });
    flushPendingPreloadTimers();

    expect(window.location.hash).toBe('#settings');
    expect(preloadCalls).toEqual([]);
  });

  test('hover and focus intent preload the lazy settings body after the debounce', async () => {
    await renderSettingsButton();

    const button = screen.getByTestId('header-settings-button');
    act(() => {
      fireEvent.mouseEnter(button);
    });
    flushPendingPreloadTimers();
    expect(preloadCalls).toEqual(['preload']);

    preloadCalls.length = 0;
    act(() => {
      fireEvent.focus(button);
    });
    flushPendingPreloadTimers();
    expect(preloadCalls).toEqual(['preload']);
  });

  test('leave and blur cancel pending intent preloads', async () => {
    await renderSettingsButton();

    const button = screen.getByTestId('header-settings-button');
    act(() => {
      fireEvent.mouseEnter(button);
      fireEvent.mouseLeave(button);
    });
    flushPendingPreloadTimers();
    expect(preloadCalls).toEqual([]);

    act(() => {
      fireEvent.focus(button);
      fireEvent.blur(button);
    });
    flushPendingPreloadTimers();
    expect(preloadCalls).toEqual([]);
  });
});

describe('settings body loading on render and on intent', () => {
  const loads: string[] = [];

  beforeEach(() => {
    vi.resetModules();
    vi.doMock('@/components/settings/SettingsDialogBody', () => {
      loads.push('settings-body');
      return {
        SettingsDialogBody: () => <div data-testid="settings-body-probe" />,
        preloadPreferencesSection: () => {
          loads.push('preferences-section');
          return Promise.resolve();
        },
      };
    });
  });

  afterEach(() => {
    cleanup();
    vi.doUnmock('@/components/settings/SettingsDialogBody');
    loads.length = 0;
  });

  const importSettingsDialogBodyLazy = () =>
    vi.importActual<typeof import('@/components/settings/SettingsDialogBodyLazy')>(
      '@/components/settings/SettingsDialogBodyLazy',
    );

  test('rendering the settings body does not start loading the Preferences section', async () => {
    const { SettingsDialogBodyLazy } = await importSettingsDialogBodyLazy();

    await renderSettingsBody(
      <SettingsDialogBodyLazy
        activeId="okignore"
        userBinding={null}
        okignoreBinding={null}
        okignoreSynced={false}
      />,
    );

    expect(screen.queryByTestId('settings-body-probe')).not.toBeNull();
    expect(loads).toEqual(['settings-body']);
  });

  test('the intent prefetch loads the settings body and the Preferences section without a render', async () => {
    const { preloadSettingsOnIntent } = await importSettingsDialogBodyLazy();

    await preloadSettingsOnIntent();

    expect(loads).toEqual(['settings-body', 'preferences-section']);
  });
});
