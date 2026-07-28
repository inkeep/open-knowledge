/**
 * Runtime guards for `update-notices-store.ts`. The store is a module-level
 * singleton, so this file owns one fake `window.okDesktop` bridge and avoids
 * module mocking entirely.
 */

import { afterAll, describe, expect, test, vi } from 'vitest';

const store = await import('./update-notices-store');

afterAll(() => {
  store.dismissNotice('schema-incompatibility-99');
  Reflect.deleteProperty(globalThis, 'window');
});

describe('update-notices-store install-time runtime wiring', () => {
  test('installs subscribers once and surfaces boot schema-incompatibility state through the store', async () => {
    const queryMock = vi.fn(() =>
      Promise.resolve({
        channel: 'latest',
        schemaIncompatibility: {
          currentBuild: '1.2.3',
          persistedSchemaVersion: 99,
          supportedSchemaVersion: 1,
        },
      }),
    );
    const downloadedUnsub = vi.fn(() => {});
    const relaunchingUnsub = vi.fn(() => {});
    const relaunchFailedUnsub = vi.fn(() => {});
    const whatsNewUnsub = vi.fn(() => {});
    const whatsNewDismissedUnsub = vi.fn(() => {});
    const stuckHintUnsub = vi.fn(() => {});
    const bridge = {
      onUpdateDownloaded: vi.fn(() => downloadedUnsub),
      onUpdateRelaunching: vi.fn(() => relaunchingUnsub),
      onUpdateRelaunchFailed: vi.fn(() => relaunchFailedUnsub),
      onWhatsNew: vi.fn(() => whatsNewUnsub),
      onWhatsNewDismissed: vi.fn(() => whatsNewDismissedUnsub),
      onUpdateStuckHint: vi.fn(() => stuckHintUnsub),
      update: {
        relaunchNow: vi.fn(() => Promise.resolve(undefined)),
        dismissWhatsNew: vi.fn(() => Promise.resolve(undefined)),
      },
      state: {
        query: queryMock,
        resetIncompatible: vi.fn(() => Promise.resolve(undefined)),
      },
      shell: { openExternal: vi.fn(() => Promise.resolve(undefined)) },
    };
    const testWindow = {} as Window & typeof globalThis;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: testWindow,
    });
    Object.defineProperty(testWindow, 'okDesktop', {
      configurable: true,
      value: bridge,
    });

    store.installUpdateNoticesBridge();

    expect(bridge.onUpdateDownloaded).toHaveBeenCalledWith(expect.any(Function));
    expect(bridge.onUpdateRelaunching).toHaveBeenCalledWith(expect.any(Function));
    expect(bridge.onUpdateRelaunchFailed).toHaveBeenCalledWith(expect.any(Function));
    expect(bridge.onWhatsNew).toHaveBeenCalledWith(expect.any(Function));
    expect(bridge.onWhatsNewDismissed).toHaveBeenCalledWith(expect.any(Function));
    expect(bridge.onUpdateStuckHint).toHaveBeenCalledWith(expect.any(Function));
    expect(queryMock).toHaveBeenCalledTimes(1);

    await Promise.resolve();

    const [notice] = store.getNoticesSnapshot();
    expect(notice?.id).toBe('schema-incompatibility-99');
    expect(notice?.body).toBe(
      'Your settings and recent projects were saved by a newer build than this one (v1.2.3). Reset to defaults to continue.',
    );
    expect(notice?.priority).toBe(0);
    expect(notice?.action?.label).toBe('Reset to defaults');
    expect(typeof notice?.action?.onClick).toBe('function');

    store.installUpdateNoticesBridge();

    expect(bridge.onUpdateDownloaded).toHaveBeenCalledTimes(1);
    expect(bridge.onUpdateRelaunching).toHaveBeenCalledTimes(1);
    expect(bridge.onUpdateRelaunchFailed).toHaveBeenCalledTimes(1);
    expect(bridge.onWhatsNew).toHaveBeenCalledTimes(1);
    expect(bridge.onWhatsNewDismissed).toHaveBeenCalledTimes(1);
    expect(bridge.onUpdateStuckHint).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});
