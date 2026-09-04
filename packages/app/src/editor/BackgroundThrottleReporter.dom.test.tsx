import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

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
    expect(() => render(<BackgroundThrottleReporter />)).not.toThrow();
    expect(pendingListener).toBeNull();
  });

  test('is inert on a bridge whose editor lacks notifyBackgroundThrottle (older shell)', () => {
    (window as unknown as { okDesktop?: OkDesktopBridge }).okDesktop = {
      editor: { notifyActiveTargetChanged: () => {} },
    } as unknown as OkDesktopBridge;
    expect(() => render(<BackgroundThrottleReporter />)).not.toThrow();
    expect(pendingListener).toBeNull();
  });
});
