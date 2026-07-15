import { describe, expect, mock, test } from 'bun:test';

import type { OkBugReportCrashDetectedEvent } from '@inkeep/open-knowledge-core';

import type { OkDesktopBridge } from '@/lib/desktop-bridge-types';

import { createCrashInviteStore } from './crash-invite-store';

function fakeBridge(): {
  bridge: OkDesktopBridge;
  emit: (event: OkBugReportCrashDetectedEvent) => void;
  subscribers: () => number;
} {
  const subs: ((event: OkBugReportCrashDetectedEvent) => void)[] = [];
  const bridge = {
    bugReport: {
      onCrashDetected: (cb: (event: OkBugReportCrashDetectedEvent) => void) => {
        subs.push(cb);
        return () => {
          const idx = subs.indexOf(cb);
          if (idx >= 0) subs.splice(idx, 1);
        };
      },
    },
  } as unknown as OkDesktopBridge;
  return {
    bridge,
    emit: (event) => {
      for (const s of subs) s(event);
    },
    subscribers: () => subs.length,
  };
}

const crashEvent: OkBugReportCrashDetectedEvent = {
  eventId: 'crash:render:1751871600000:0',
  kind: 'render-process-gone',
  context: { reason: 'crashed', exitCode: 5 },
};

describe('createCrashInviteStore — install', () => {
  test('returns undefined and is a no-op when no bridge is supplied', () => {
    const store = createCrashInviteStore();
    expect(store.install({ bridge: undefined })).toBeUndefined();
    expect(store.getSnapshot()).toBeNull();
  });

  test('no-ops without throwing when the bridge omits the bugReport surface', () => {
    const store = createCrashInviteStore();
    // A partial bridge (test/preview mock, or a renderer paired with a main
    // process predating the bug-report IPC) has no `bugReport` — install runs
    // at module-init outside any error boundary, so it must no-op, not throw.
    const partialBridge = {} as unknown as OkDesktopBridge;
    let result: (() => void) | undefined;
    expect(() => {
      result = store.install({ bridge: partialBridge });
    }).not.toThrow();
    expect(result).toBeUndefined();
    expect(store.getSnapshot()).toBeNull();
  });

  test('subscribes once + idempotent on a second install call', () => {
    const fb = fakeBridge();
    const store = createCrashInviteStore();
    const teardown1 = store.install({ bridge: fb.bridge });
    const teardown2 = store.install({ bridge: fb.bridge });
    expect(typeof teardown1).toBe('function');
    expect(typeof teardown2).toBe('function');
    expect(fb.subscribers()).toBe(1);
  });
});

describe('createCrashInviteStore — invitation delivery', () => {
  test('buffers an event that arrives before any component subscribes', () => {
    const fb = fakeBridge();
    const store = createCrashInviteStore();
    store.install({ bridge: fb.bridge });

    fb.emit(crashEvent);

    expect(store.getSnapshot()).toEqual(crashEvent);
  });

  test('notifies subscribers when an event lands', () => {
    const fb = fakeBridge();
    const store = createCrashInviteStore();
    store.install({ bridge: fb.bridge });
    const listener = mock(() => {});
    store.subscribe(listener);

    fb.emit(crashEvent);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('dismiss clears the invitation and notifies once', () => {
    const fb = fakeBridge();
    const store = createCrashInviteStore();
    store.install({ bridge: fb.bridge });
    fb.emit(crashEvent);
    const listener = mock(() => {});
    store.subscribe(listener);

    store.dismiss();
    store.dismiss();

    expect(store.getSnapshot()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('uninstall detaches from the bridge and drops the buffered invitation', () => {
    const fb = fakeBridge();
    const store = createCrashInviteStore();
    const teardown = store.install({ bridge: fb.bridge });
    fb.emit(crashEvent);

    teardown?.();

    expect(fb.subscribers()).toBe(0);
    expect(store.getSnapshot()).toBeNull();
  });
});
