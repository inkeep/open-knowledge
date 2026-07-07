/**
 * Regression guard for the multi-window light/dark flicker storm — see
 * `useApplyConfigTheme`'s STORM GUARD JSDoc for the full mechanism. In brief: a
 * non-primary window receives another window's theme flip via a cross-window
 * `storage` event while its own merged config is still stale; depending on
 * `[themeValue]` only (not the churning `setTheme`) keeps that flip from being
 * reverted and re-broadcast.
 *
 * Runs under `bun run test:dom` (jsdom preload). next-themes reads/writes BARE
 * `localStorage`; the preload only puts it on `window`, so each test exposes it
 * globally to exercise the cross-window channel faithfully.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, cleanup, render } from '@testing-library/react';
import { ThemeProvider } from 'next-themes';
import type { ReactElement } from 'react';
import { useApplyConfigTheme } from './use-apply-config-theme';

function ConfigThemeHarness({ themeValue }: { themeValue: string | undefined }) {
  useApplyConfigTheme(themeValue);
  return null;
}

// Mirror the production provider in main.tsx (including disableTransitionOnChange)
// so the harness exercises the same next-themes configuration the app ships.
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

// The jsdom preload does not install `StorageEvent` on `globalThis`, so bare
// `new StorageEvent(...)` is unavailable here. A plain `Event` with `.key` /
// `.newValue` faithfully drives next-themes' storage handler, which reads only
// those fields.
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

    // Another window flips to 'dark' -> shared-localStorage storage event here,
    // while this harness's themeValue (merged config) is still the stale 'light'.
    await act(async () => {
      dispatchCrossWindowStorage('dark');
      await Promise.resolve();
    });

    // The window stays 'dark' (no revert) and does NOT rewrite the shared
    // localStorage back to the stale value (the storm seed). Re-adding
    // `setTheme` to the effect deps reverts both and re-reds this test.
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

    // This window's own config round-trip lands 'dark'.
    await act(async () => {
      rerender(themeTree('dark'));
      await Promise.resolve();
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  test("'system' is applied, pinning the third guard branch", async () => {
    // The hook guard accepts light | dark | system; 'system' is the default
    // appearance.theme. Under the jsdom matchMedia stub (matches:false) it
    // resolves to light.
    await act(async () => {
      render(themeTree('system'));
      await Promise.resolve();
    });
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  test('no-ops while themeValue is undefined (cold start), then applies once it lands', async () => {
    // themeValue is undefined until the first config sync — the path every
    // launch takes. The effect must not force a value while undefined, then
    // apply once a real value arrives.
    const { rerender } = render(themeTree(undefined));
    await act(async () => {
      await Promise.resolve();
    });
    // Nothing forced beyond next-themes' own default ('system' -> light here).
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    await act(async () => {
      rerender(themeTree('dark'));
      await Promise.resolve();
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
