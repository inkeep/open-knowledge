import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

/**
 * Composition test for the app-side wiring: config kill-switch + pool signal +
 * `window.okDesktop` bridge. Verifies the component gates on the Electron host,
 * reads `bridge.backgroundThrottle.enabled`, and pushes through
 * `editor.notifyBackgroundThrottle` — the glue the install-helper unit test
 * (over a fake pool) cannot see. The real main→Chromium effect is the
 * packaged-app desktop-smoke rung (carried as a coverage gap).
 */

let pendingListener: (() => void) | null = null;
let poolPending = false;
const fakePool = {
  hasAnyUnsyncedWork: () => poolPending,
  addUnsyncedWorkListener: (cb: () => void) => {
    pendingListener = cb;
    return () => {
      pendingListener = null;
    };
  },
};

vi.doMock('./DocumentContext', () => ({
  getPool: () => fakePool,
  useDocumentContext: () => ({ collabUrl: 'ws://localhost:1/collab' }),
}));

let projectConfig: unknown = { bridge: { backgroundThrottle: { enabled: true } } };
vi.doMock('@/lib/config-context', () => ({
  useConfigContext: () => ({ projectConfig }),
}));

const { BackgroundThrottleReporter } = await import('./BackgroundThrottleReporter');

function installFakeBridge(): ReturnType<typeof vi.fn> {
  const notifyBackgroundThrottle = vi.fn();
  (window as unknown as { okDesktop?: OkDesktopBridge }).okDesktop = {
    editor: { notifyBackgroundThrottle },
  } as unknown as OkDesktopBridge;
  return notifyBackgroundThrottle;
}

describe('BackgroundThrottleReporter', () => {
  afterEach(() => {
    cleanup();
    pendingListener = null;
    poolPending = false;
    projectConfig = { bridge: { backgroundThrottle: { enabled: true } } };
    (window as unknown as { okDesktop?: OkDesktopBridge }).okDesktop = undefined;
  });

  test('seeds main with the current state and reports the pending-work edge', () => {
    const notify = installFakeBridge();
    render(<BackgroundThrottleReporter />);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith({ hasPendingWork: false, enabled: true });

    poolPending = true;
    pendingListener?.();
    expect(notify).toHaveBeenLastCalledWith({ hasPendingWork: true, enabled: true });
  });

  test('carries a disabled kill-switch so main resolves the OS default', () => {
    projectConfig = { bridge: { backgroundThrottle: { enabled: false } } };
    const notify = installFakeBridge();
    render(<BackgroundThrottleReporter />);
    expect(notify).toHaveBeenLastCalledWith({ hasPendingWork: false, enabled: false });
  });

  test('is inert outside the Electron host (no window.okDesktop)', () => {
    // No bridge installed — the component must not touch the pool or throw.
    expect(() => render(<BackgroundThrottleReporter />)).not.toThrow();
    expect(pendingListener).toBeNull();
  });

  test('is inert on a bridge whose editor lacks notifyBackgroundThrottle (older shell)', () => {
    // The preload bridge is a cross-process contract the renderer cannot
    // enforce: a shell built before this channel exposes `editor` without the
    // method. Throttling is an optimization; its absence must not crash the
    // app shell (an unguarded call here took down the whole tree through the
    // nearest error boundary, caught by the desktop-emulating e2e).
    (window as unknown as { okDesktop?: OkDesktopBridge }).okDesktop = {
      editor: { notifyActiveTargetChanged: () => {} },
    } as unknown as OkDesktopBridge;
    expect(() => render(<BackgroundThrottleReporter />)).not.toThrow();
    expect(pendingListener).toBeNull();
  });
});
