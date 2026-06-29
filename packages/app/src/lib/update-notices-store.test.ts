
import { afterAll, describe, expect, mock, test } from 'bun:test';

const store = await import('./update-notices-store');

afterAll(() => {
  store.dismissNotice('schema-incompatibility-99');
  Reflect.deleteProperty(globalThis, 'window');
});

describe('update-notices-store install-time runtime wiring', () => {
  test('installs subscribers once and surfaces boot schema-incompatibility state through the store', async () => {
    const queryMock = mock(() =>
      Promise.resolve({
        channel: 'latest',
        schemaIncompatibility: {
          currentBuild: '1.2.3',
          persistedSchemaVersion: 99,
          supportedSchemaVersion: 1,
        },
      }),
    );
    const downloadedUnsub = mock(() => {});
    const relaunchingUnsub = mock(() => {});
    const relaunchFailedUnsub = mock(() => {});
    const whatsNewUnsub = mock(() => {});
    const whatsNewDismissedUnsub = mock(() => {});
    const stuckHintUnsub = mock(() => {});
    const bridge = {
      onUpdateDownloaded: mock(() => downloadedUnsub),
      onUpdateRelaunching: mock(() => relaunchingUnsub),
      onUpdateRelaunchFailed: mock(() => relaunchFailedUnsub),
      onWhatsNew: mock(() => whatsNewUnsub),
      onWhatsNewDismissed: mock(() => whatsNewDismissedUnsub),
      onUpdateStuckHint: mock(() => stuckHintUnsub),
      update: {
        relaunchNow: mock(() => Promise.resolve(undefined)),
        dismissWhatsNew: mock(() => Promise.resolve(undefined)),
      },
      state: {
        query: queryMock,
        resetIncompatible: mock(() => Promise.resolve(undefined)),
      },
      shell: { openExternal: mock(() => Promise.resolve(undefined)) },
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
