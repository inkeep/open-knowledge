import { act, cleanup, render } from '@testing-library/react';
import { ThemeProvider } from 'next-themes';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { useApplyConfigTheme } from './use-apply-config-theme';

function ConfigThemeHarness({ themeValue }: { themeValue: string | undefined }) {
  useApplyConfigTheme(themeValue);
  return null;
}

function themeTree(themeValue: string | undefined): ReactElement {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      storageKey="ok-theme-v1"
    >
      <ConfigThemeHarness themeValue={themeValue} />
    </ThemeProvider>
  );
}

function dispatchCrossWindowStorage(newValue: string) {
  window.localStorage.setItem('ok-theme-v1', newValue);
  const ev = new Event('storage');
  Object.assign(ev, { key: 'ok-theme-v1', newValue, oldValue: null });
  window.dispatchEvent(ev);
}

describe('useApplyConfigTheme — cross-window flicker guard', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = window.localStorage;
    window.localStorage.clear();
    document.documentElement.className = '';
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    document.documentElement.className = '';
  });

  test('a cross-window storage flip is NOT reverted while this window config is stale', async () => {
    await act(async () => {
      render(themeTree('light'));
      await Promise.resolve();
    });
    expect(document.documentElement.classList.contains('light')).toBe(true);

    await act(async () => {
      dispatchCrossWindowStorage('dark');
      await Promise.resolve();
    });

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('light')).toBe(false);
    expect(window.localStorage.getItem('ok-theme-v1')).toBe('dark');
  });

  test('a genuine config-theme change still applies (the effect is not dead)', async () => {
    const { rerender } = render(themeTree('light'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.documentElement.classList.contains('light')).toBe(true);

    await act(async () => {
      rerender(themeTree('dark'));
      await Promise.resolve();
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  test("'system' is applied, pinning the third guard branch", async () => {
    await act(async () => {
      render(themeTree('system'));
      await Promise.resolve();
    });
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  test('no-ops while themeValue is undefined (cold start), then applies once it lands', async () => {
    const { rerender } = render(themeTree(undefined));
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    await act(async () => {
      rerender(themeTree('dark'));
      await Promise.resolve();
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
