import { describe, expect, test, vi } from 'vitest';

import type { OkDesktopBridge, OkShareReceivedPayload } from '@/lib/desktop-bridge-types';

import { createShareReceiveStore } from './receive-store';

function fakeBridge(): {
  bridge: OkDesktopBridge;
  emit: (payload: OkShareReceivedPayload) => void;
  unsubscribed: () => boolean;
  subscribers: () => number;
} {
  const subs: ((p: OkShareReceivedPayload) => void)[] = [];
  let isUnsubscribed = false;
  const bridge = {
    onShareReceived: (cb: (p: OkShareReceivedPayload) => void) => {
      subs.push(cb);
      return () => {
        isUnsubscribed = true;
        const idx = subs.indexOf(cb);
        if (idx >= 0) subs.splice(idx, 1);
      };
    },
  } as unknown as OkDesktopBridge;
  return {
    bridge,
    emit: (payload) => {
      for (const s of subs) s(payload);
    },
    unsubscribed: () => isUnsubscribed,
    subscribers: () => subs.length,
  };
}

const sharePayload: OkShareReceivedPayload = {
  kind: 'launcher-miss',
  share: {
    owner: 'a',
    repo: 'b',
    branch: 'main',
    sharedUrl: 'https://github.com/a/b/blob/main/README.md',
    target: { kind: 'doc', docPath: 'README.md' },
  },
};

describe('createShareReceiveStore — install', () => {
  test('returns undefined and is a no-op when no bridge is supplied', () => {
    const store = createShareReceiveStore();
    expect(store.install({ bridge: undefined })).toBeUndefined();
    expect(store.getSnapshot()).toBeNull();
  });

  test('subscribes once + idempotent on a second install call', () => {
    const fb = fakeBridge();
    const store = createShareReceiveStore();
    const teardown1 = store.install({ bridge: fb.bridge });
    const teardown2 = store.install({ bridge: fb.bridge });
    expect(typeof teardown1).toBe('function');
    expect(typeof teardown2).toBe('function');
    expect(fb.subscribers()).toBe(1);
  });
});

describe('createShareReceiveStore — payload delivery', () => {
  test('stores the latest payload and notifies subscribers', () => {
    const fb = fakeBridge();
    const store = createShareReceiveStore();
    store.install({ bridge: fb.bridge });
    const listener = vi.fn(() => {});
    store.subscribe(listener);
    fb.emit(sharePayload);
    expect(store.getSnapshot()).toEqual(sharePayload);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('overwrites the prior payload when a new one arrives', () => {
    const fb = fakeBridge();
    const store = createShareReceiveStore();
    store.install({ bridge: fb.bridge });
    fb.emit(sharePayload);
    fb.emit({ kind: 'invalid' });
    expect(store.getSnapshot()).toEqual({ kind: 'invalid' });
  });

  test('all subscribers are notified on each payload', () => {
    const fb = fakeBridge();
    const store = createShareReceiveStore();
    store.install({ bridge: fb.bridge });
    const a = vi.fn(() => {});
    const b = vi.fn(() => {});
    store.subscribe(a);
    store.subscribe(b);
    fb.emit(sharePayload);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  test('unsubscribed listeners do not fire', () => {
    const fb = fakeBridge();
    const store = createShareReceiveStore();
    store.install({ bridge: fb.bridge });
    const a = vi.fn(() => {});
    const unsub = store.subscribe(a);
    unsub();
    fb.emit(sharePayload);
    expect(a).toHaveBeenCalledTimes(0);
  });
});

describe('createShareReceiveStore — dismiss', () => {
  test('clears the payload and notifies subscribers', () => {
    const fb = fakeBridge();
    const store = createShareReceiveStore();
    store.install({ bridge: fb.bridge });
    fb.emit(sharePayload);
    const listener = vi.fn(() => {});
    store.subscribe(listener);
    store.dismiss();
    expect(store.getSnapshot()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('dismiss with no current payload is a no-op (no notify)', () => {
    const fb = fakeBridge();
    const store = createShareReceiveStore();
    store.install({ bridge: fb.bridge });
    const listener = vi.fn(() => {});
    store.subscribe(listener);
    store.dismiss();
    expect(listener).toHaveBeenCalledTimes(0);
  });
});

describe('createShareReceiveStore — teardown', () => {
  test('teardown unsubscribes from the bridge and clears state', () => {
    const fb = fakeBridge();
    const store = createShareReceiveStore();
    const teardown = store.install({ bridge: fb.bridge });
    fb.emit(sharePayload);
    expect(store.getSnapshot()).toEqual(sharePayload);
    teardown?.();
    expect(fb.unsubscribed()).toBe(true);
    expect(store.getSnapshot()).toBeNull();
  });

  test('after teardown, a re-install attaches a fresh bridge subscription', () => {
    const fb = fakeBridge();
    const store = createShareReceiveStore();
    const teardown = store.install({ bridge: fb.bridge });
    teardown?.();
    expect(fb.subscribers()).toBe(0);
    const teardown2 = store.install({ bridge: fb.bridge });
    expect(typeof teardown2).toBe('function');
    expect(fb.subscribers()).toBe(1);
  });
});
