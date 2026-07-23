import * as actualSonner from 'sonner';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

// Capture the plain `toast(...)` call so we can assert the wiring without a DOM.
const toastPlain = vi.fn((_msg: string) => 'toast-id');
vi.doMock('sonner', () => ({
  ...actualSonner,
  toast: Object.assign(toastPlain, {
    warning: vi.fn(() => 'w'),
    success: vi.fn(() => 's'),
    error: vi.fn(() => 'e'),
    dismiss: vi.fn(() => {}),
    custom: vi.fn(() => 'c'),
    loading: vi.fn(() => 'l'),
  }),
}));

// Bind the SUT after the sonner mock is registered so its `toast` import is the
// captured stub (the mock facade only rewrites imports resolved after doMock).
type Mod = typeof import('@/lib/install-recent-removed-listener');
let installRecentRemovedListener: Mod['installRecentRemovedListener'];
let recentRemovedMissingMessage: Mod['recentRemovedMissingMessage'];
beforeAll(async () => {
  ({ installRecentRemovedListener, recentRemovedMissingMessage } = await import(
    '@/lib/install-recent-removed-listener'
  ));
});

beforeEach(() => {
  toastPlain.mockClear();
});

describe('recentRemovedMissingMessage', () => {
  test('names the project that was pruned', () => {
    expect(recentRemovedMissingMessage('Fishing Notes')).toContain('Fishing Notes');
  });
});

describe('installRecentRemovedListener', () => {
  test('no-ops (no throw, no toast) without a desktop bridge', () => {
    expect(installRecentRemovedListener({ bridge: undefined })).toBeUndefined();
    expect(toastPlain).not.toHaveBeenCalled();
  });

  test('subscribes once and toasts the project name when the event fires', () => {
    let captured: ((info: { path: string; projectName: string }) => void) | null = null;
    const unsubscribe = vi.fn(() => {});
    const bridge = {
      onRecentRemovedMissing: vi.fn((cb: (info: { path: string; projectName: string }) => void) => {
        captured = cb;
        return unsubscribe;
      }),
    } as unknown as OkDesktopBridge;

    const dispose = installRecentRemovedListener({ bridge });
    expect(bridge.onRecentRemovedMissing).toHaveBeenCalledTimes(1);
    expect(captured).not.toBeNull();

    captured?.({ path: '/gone', projectName: 'Ghost Project' });
    expect(toastPlain).toHaveBeenCalledTimes(1);
    const msg = toastPlain.mock.calls[0]?.[0];
    expect(typeof msg).toBe('string');
    expect(msg).toContain('Ghost Project');

    dispose?.();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
