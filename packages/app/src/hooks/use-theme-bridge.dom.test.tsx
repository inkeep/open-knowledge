/**
 * RTL mount tests for the useThemeBridge hook — `.finally(...)`
 * chain ordering and cleanup-on-unmount. Exercises the `render` API
 * surface (via `<HookProbe>` wrapper) under the jsdom substrate
 * (precedent #43); invocation via `bun run test:dom`. Pairs with the
 * verbatim user-intent contract documented in precedent #40(a).
 *
 * # Root cause of the prior Linux-CI failure (resolved)
 *
 * Bun's `mock.module(...)` patches a module in-place for the lifetime of
 * the `bun test` invocation — the mock persists across sibling test files
 * (oven-sh/bun#12823). Sibling `src/lib/config-provider.dom.test.tsx`
 * declares `mock.module('@/hooks/use-theme-bridge', () => ({
 * useThemeBridge: () => {} }))` at module level. On Linux CI, filesystem
 * iteration ordered `src/lib/...` before `src/hooks/...`, so by the time
 * this file ran the hook had already been replaced with a no-op; the
 * `<HookProbe>` rendered, the (no-op) effect "fired", but nothing pushed
 * onto `setThemeSourceCalls` — exactly the `Received: 0` mode. On macOS
 * inode iteration happened to order this file before `config-provider`,
 * so the leak couldn't surface locally.
 *
 * The fix is one line in `scripts/run-test-dom.sh`: pass `--isolate` so
 * each test file gets a fresh global object and `mock.module` patches
 * don't bleed across files. Documented in the script's preamble.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { act, cleanup, render, waitFor } from '@testing-library/react';
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

// Probe component for hook testing. Renders a real DOM node so React's
// commit phase has something to attach against — null-returning probes
// have shown commit-scheduler divergence on Bun's Linux test runner that
// suppressed the hook's useEffect from firing observably. The probe div
// also gives `cleanup()` an unambiguous unmount target.
function HookProbe({
  bridge,
  themeValue,
}: {
  bridge: OkDesktopBridge | undefined;
  themeValue: string | undefined;
}) {
  useThemeBridge(bridge, themeValue);
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
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
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

    // Unmount IMMEDIATELY (before effect fires) — the cancelled flag in
    // the cleanup must suppress the still-pending .finally's
    // signalThemeApplied call.
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

    // Idempotency: same-value rerender does NOT re-fire setThemeSource.
    await act(async () => {
      await Promise.resolve();
    });

    expect(stubBridge.setThemeSourceCalls.length).toBe(1);
    expect(stubBridge.setThemeSourceCalls[0]).toBe('system');
  });

  test('rerender with a changed themeValue re-fires setThemeSource and releases gate', async () => {
    // Tests the deps array + cancellation flag transition that the
    // idempotency test alone cannot reach. The hook's useEffect deps are
    // `[bridge, themeValue]`; when `themeValue` changes from `'system'` to
    // `'dark'`, the previous effect's cleanup sets its `cancelled = true`
    // (suppressing the stale .finally signal) AND the new effect fires
    // setThemeSource('dark') + signalThemeApplied. Without this test, a
    // dropped dep or a broken cancellation flag would compile and pass
    // every other test in this file.
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

  test('rejection path: signalThemeApplied still fires via .finally so the show-gate releases', async () => {
    // The gate-release contract: when the
    // IPC roundtrip rejects (channel teardown race, bootstrap ordering
    // regression), `.finally(...)` MUST still fire signalThemeApplied or
    // the cold-launch gate stalls blank for the full 5 s safety timeout.
    // The structured warn in `.catch(...)` keeps the failure observable.
    const rejectionError = new Error('ipc-teardown: setThemeSource bridge unreachable');
    const stubBridge = makeRejectingBridge(rejectionError);
    render(<HookProbe bridge={stubBridge as unknown as OkDesktopBridge} themeValue="system" />);

    // Gate-release contract: signal fires even on the rejection path.
    // waitFor polls the whole rejection → .catch → .finally chain until
    // signalThemeApplied lands.
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
    // Observable-failure contract: structured warn emitted from .catch.
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
