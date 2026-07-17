import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';

const preloadCalls: string[] = [];

import * as actualLinguiMacro from '@lingui/react/macro';

mock.module('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

mock.module('@/components/settings/SettingsDialogBodyLazy', () => ({
  SettingsDialogBodyLazy: {
    preload: () => {
      preloadCalls.push('preload');
      return Promise.resolve();
    },
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
    jest.runOnlyPendingTimers();
  });
}

describe('SettingsButton runtime behavior', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
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
