/**
 * RTL mount tests for the useThemeBridge hook — `.finally(...)`
 * chain ordering and cleanup-on-unmount. Exercises the `render` API
 * surface (via `<HookProbe>` wrapper) under the jsdom substrate
 * (precedent #43); invocation via `bun run test:dom`. Pairs with the
 * verbatim user-intent contract documented in precedent #40(a).
 *
 * The DOM Vitest project keeps `isolate: true` so the module mock in the
 * sibling config-provider suite cannot replace this hook's real implementation.
 */

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';
import { useThemeBridge } from './use-theme-bridge';

const ASYNC_EFFECT_TIMEOUT_MS = 1000;

interface StubBridge {
  setThemeSource: (value: string) => Promise<{ ok: true }>;
  signalThemeApplied: (payload: { reducedTransparency: boolean }) => void;
  readonly setThemeSourceCalls: ReadonlyArray<string>;
  readonly signalThemeAppliedCalls: ReadonlyArray<{ reducedTransparency: boolean }>;
}

function makeStubBridge(): StubBridge {
  const setCalls: string[] = [];
  const signalCalls: Array<{ reducedTransparency: boolean }> = [];
  return {
    setThemeSource: (value: string) => {
      setCalls.push(value);
      return Promise.resolve({ ok: true as const });
    },
    signalThemeApplied: (payload: { reducedTransparency: boolean }) => {
      signalCalls.push(payload);
    },
    setThemeSourceCalls: setCalls,
    signalThemeAppliedCalls: signalCalls,
  };
}

function makeRejectingBridge(rejectionError: Error): StubBridge {
  const setCalls: string[] = [];
  const signalCalls: Array<{ reducedTransparency: boolean }> = [];
  return {
    setThemeSource: (value: string) => {
      setCalls.push(value);
      return Promise.reject(rejectionError);
    },
    signalThemeApplied: (payload: { reducedTransparency: boolean }) => {
      signalCalls.push(payload);
    },
    setThemeSourceCalls: setCalls,
    signalThemeAppliedCalls: signalCalls,
  };
}

function HookProbe({
  bridge,
  themeValue,
  colorThemeKey,
}: {
  bridge: OkDesktopBridge | undefined;
  themeValue: string | undefined;
  colorThemeKey?: string;
}) {
  useThemeBridge(bridge, themeValue, colorThemeKey);
  return <div data-testid="theme-bridge-probe" />;
}

function installControllableMatchMedia(initialMatches: boolean) {
  const originalWindowMatchMedia = window.matchMedia;
  const originalGlobalMatchMedia = globalThis.matchMedia;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const queries: string[] = [];
  let matches = initialMatches;
  const mql = {
    get matches() {
      return matches;
    },
    media: '',
    onchange: null,
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type !== 'change') return;
      listeners.add(listener as (event: MediaQueryListEvent) => void);
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type !== 'change') return;
      listeners.delete(listener as (event: MediaQueryListEvent) => void);
    },
    addListener: (listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeListener: (listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
    dispatchEvent: () => false,
  } as unknown as MediaQueryList;
  const matchMedia = (query: string) => {
    queries.push(query);
    (mql as { media: string }).media = query;
    return mql;
  };

  window.matchMedia = matchMedia;
  globalThis.matchMedia = matchMedia;

  return {
    queries,
    get listenerCount() {
      return listeners.size;
    },
    dispatchChange(nextMatches: boolean) {
      matches = nextMatches;
      const event = { matches: nextMatches, media: mql.media } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
    restore() {
      window.matchMedia = originalWindowMatchMedia;
      globalThis.matchMedia = originalGlobalMatchMedia;
    },
  };
}

describe('useThemeBridge (Tier-3 mount)', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  test('exports the hook', async () => {
    const mod = await import('./use-theme-bridge');
    expect(typeof mod.useThemeBridge).toBe('function');
  });

  test('no-ops without a bridge or a valid theme value', async () => {
    const stubBridge = makeStubBridge();
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<HookProbe bridge={undefined} themeValue="system" />);
      await Promise.resolve();
    });

    expect(stubBridge.setThemeSourceCalls).toHaveLength(0);
    expect(stubBridge.signalThemeAppliedCalls).toHaveLength(0);

    await act(async () => {
      view.rerender(
        <HookProbe bridge={stubBridge as unknown as OkDesktopBridge} themeValue="solarized" />,
      );
      await Promise.resolve();
    });

    expect(stubBridge.setThemeSourceCalls).toHaveLength(0);
    expect(stubBridge.signalThemeAppliedCalls).toHaveLength(0);
  });

  test('forwards themeValue verbatim to setThemeSource on mount', async () => {
    const stubBridge = makeStubBridge();
    render(<HookProbe bridge={stubBridge as unknown as OkDesktopBridge} themeValue="system" />);

    await waitFor(
      () => {
        expect(stubBridge.setThemeSourceCalls.length).toBe(1);
      },
      { timeout: ASYNC_EFFECT_TIMEOUT_MS },
    );
    expect(stubBridge.setThemeSourceCalls[0]).toBe('system');
  });

  test('signalThemeApplied fires after the .finally(...) drain with the matchMedia reading', async () => {
    const stubBridge = makeStubBridge();
    render(<HookProbe bridge={stubBridge as unknown as OkDesktopBridge} themeValue="dark" />);

    await waitFor(
      () => {
        expect(stubBridge.signalThemeAppliedCalls.length).toBe(1);
      },
      { timeout: ASYNC_EFFECT_TIMEOUT_MS },
    );
    expect(stubBridge.signalThemeAppliedCalls[0]).toEqual({
      reducedTransparency: false,
    });
  });

  test('cleanup on unmount: signalThemeApplied does NOT fire after unmount, no React warning', async () => {
    const stubBridge = makeStubBridge();
    const { unmount } = render(
      <HookProbe bridge={stubBridge as unknown as OkDesktopBridge} themeValue="light" />,
    );

    unmount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(stubBridge.signalThemeAppliedCalls.length).toBe(0);

    const sawPostUnmountWarning = consoleErrorSpy.mock.calls.some((call: unknown[]) => {
      const message = call[0];
      return typeof message === 'string' && /unmount(ed)? component/i.test(message);
    });
    expect(sawPostUnmountWarning).toBe(false);
  });

  test('rerender with the same themeValue forwards the original verbatim user-intent', async () => {
    const stubBridge = makeStubBridge();
    const { rerender } = render(
      <HookProbe bridge={stubBridge as unknown as OkDesktopBridge} themeValue="system" />,
    );

    await waitFor(
      () => {
        expect(stubBridge.setThemeSourceCalls.length).toBe(1);
      },
      { timeout: ASYNC_EFFECT_TIMEOUT_MS },
    );
    expect(stubBridge.setThemeSourceCalls[0]).toBe('system');

    rerender(<HookProbe bridge={stubBridge as unknown as OkDesktopBridge} themeValue="system" />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(stubBridge.setThemeSourceCalls.length).toBe(1);
    expect(stubBridge.setThemeSourceCalls[0]).toBe('system');
  });

  test('rerender with a changed themeValue re-fires setThemeSource and releases gate', async () => {
    const stubBridge = makeStubBridge();
    const { rerender } = render(
      <HookProbe bridge={stubBridge as unknown as OkDesktopBridge} themeValue="system" />,
    );

    await waitFor(
      () => {
        expect(stubBridge.signalThemeAppliedCalls.length).toBe(1);
      },
      { timeout: ASYNC_EFFECT_TIMEOUT_MS },
    );
    expect(stubBridge.setThemeSourceCalls.length).toBe(1);
    expect(stubBridge.setThemeSourceCalls[0]).toBe('system');

    rerender(<HookProbe bridge={stubBridge as unknown as OkDesktopBridge} themeValue="dark" />);

    await waitFor(
      () => {
        expect(stubBridge.setThemeSourceCalls.length).toBe(2);
      },
      { timeout: ASYNC_EFFECT_TIMEOUT_MS },
    );
    expect(stubBridge.setThemeSourceCalls[1]).toBe('dark');
    expect(stubBridge.signalThemeAppliedCalls.length).toBe(2);
  });

  test('reports chrome as hex even when the token is authored in a syntax Electron cannot parse', async () => {
    document.documentElement.style.setProperty('--sidebar', 'oklch(0.985 0 0)');
    document.documentElement.style.setProperty('--sidebar-foreground', 'oklch(0.145 0 0)');
    const stubBridge = makeStubBridge();
    try {
      render(
        <HookProbe
          bridge={stubBridge as unknown as OkDesktopBridge}
          themeValue="light"
          colorThemeKey="default:"
        />,
      );
      await waitFor(
        () => {
          expect(stubBridge.signalThemeAppliedCalls.length).toBe(1);
        },
        { timeout: ASYNC_EFFECT_TIMEOUT_MS },
      );
      const chrome = stubBridge.signalThemeAppliedCalls[0]?.chrome;
      if (chrome) {
        expect(chrome.bg).toMatch(/^#[0-9a-f]{6}$/);
        expect(chrome.symbol).toMatch(/^#[0-9a-f]{6}$/);
      }
    } finally {
      document.documentElement.style.removeProperty('--sidebar');
      document.documentElement.style.removeProperty('--sidebar-foreground');
    }
  });

  test('a same-mode palette switch re-reports chrome even though themeValue is unchanged', async () => {
    const stubBridge = makeStubBridge();
    const { rerender } = render(
      <HookProbe
        bridge={stubBridge as unknown as OkDesktopBridge}
        themeValue="dark"
        colorThemeKey="dracula:"
      />,
    );

    await waitFor(
      () => {
        expect(stubBridge.signalThemeAppliedCalls.length).toBe(1);
      },
      { timeout: ASYNC_EFFECT_TIMEOUT_MS },
    );

    rerender(
      <HookProbe
        bridge={stubBridge as unknown as OkDesktopBridge}
        themeValue="dark"
        colorThemeKey="monokai:"
      />,
    );

    await waitFor(
      () => {
        expect(stubBridge.signalThemeAppliedCalls.length).toBe(2);
      },
      { timeout: ASYNC_EFFECT_TIMEOUT_MS },
    );
  });

  test('rejection path: signalThemeApplied still fires via .finally so the show-gate releases', async () => {
    const rejectionError = new Error('ipc-teardown: setThemeSource bridge unreachable');
    const stubBridge = makeRejectingBridge(rejectionError);
    render(<HookProbe bridge={stubBridge as unknown as OkDesktopBridge} themeValue="system" />);

    await waitFor(
      () => {
        expect(stubBridge.signalThemeAppliedCalls.length).toBe(1);
      },
      { timeout: ASYNC_EFFECT_TIMEOUT_MS },
    );

    expect(stubBridge.setThemeSourceCalls.length).toBe(1);
    expect(stubBridge.signalThemeAppliedCalls[0]).toEqual({
      reducedTransparency: false,
    });
    const sawStructuredWarn = consoleWarnSpy.mock.calls.some((call: unknown[]) => {
      const message = call[0];
      if (typeof message !== 'string') return false;
      try {
        const parsed = JSON.parse(message) as { event?: string; themeValue?: string };
        return parsed.event === 'theme-source-set-failed' && parsed.themeValue === 'system';
      } catch {
        return false;
      }
    });
    expect(sawStructuredWarn).toBe(true);
  });

  test('reduced-transparency changes signal main and the listener is removed on unmount', async () => {
    const media = installControllableMatchMedia(false);
    try {
      const stubBridge = makeStubBridge();
      const { unmount } = render(
        <HookProbe bridge={stubBridge as unknown as OkDesktopBridge} themeValue="system" />,
      );

      await waitFor(
        () => {
          expect(stubBridge.signalThemeAppliedCalls.length).toBe(1);
        },
        { timeout: ASYNC_EFFECT_TIMEOUT_MS },
      );
      expect(media.queries).toContain('(prefers-reduced-transparency: reduce)');
      expect(media.listenerCount).toBe(1);

      media.dispatchChange(true);
      expect(stubBridge.signalThemeAppliedCalls.at(-1)).toEqual({
        reducedTransparency: true,
      });

      unmount();
      expect(media.listenerCount).toBe(0);
      media.dispatchChange(false);
      expect(stubBridge.signalThemeAppliedCalls).toHaveLength(2);
    } finally {
      media.restore();
    }
  });
});
