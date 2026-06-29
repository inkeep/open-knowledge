import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  type BundleReplaceDetectorInput,
  detectBundleReplace,
  extractShortVersionFromPlist,
  startBundleReplaceWatcher,
} from '../../src/main/bundle-replace-detector.ts';


afterEach(() => {
  mock.restore();
});

function makeInput(
  overrides: Partial<BundleReplaceDetectorInput> = {},
): BundleReplaceDetectorInput {
  return {
    infoPlistPath: '/Applications/OpenKnowledge.app/Contents/Info.plist',
    processStartTimeMs: 1_000_000,
    currentVersion: '0.4.1',
    statSync: () => ({ mtimeMs: 500_000 }),
    readOnDiskVersion: () => '0.4.1',
    ...overrides,
  };
}

describe('detectBundleReplace', () => {
  test('mtime predates process start → unchanged (no prompt)', () => {
    const state = detectBundleReplace(
      makeInput({
        statSync: () => ({ mtimeMs: 500_000 }),
        processStartTimeMs: 1_000_000,
      }),
    );
    expect(state.kind).toBe('unchanged');
  });

  test('mtime newer, versions match → no-divergence (file touched, no upgrade)', () => {
    const state = detectBundleReplace(
      makeInput({
        statSync: () => ({ mtimeMs: 2_000_000 }),
        processStartTimeMs: 1_000_000,
        currentVersion: '0.4.1',
        readOnDiskVersion: () => '0.4.1',
      }),
    );
    expect(state.kind).toBe('no-divergence');
  });

  test('mtime newer AND versions differ → upgraded (PROMPT)', () => {
    const state = detectBundleReplace(
      makeInput({
        statSync: () => ({ mtimeMs: 2_000_000 }),
        processStartTimeMs: 1_000_000,
        currentVersion: '0.4.1',
        readOnDiskVersion: () => '0.5.0-beta.3',
      }),
    );
    expect(state).toEqual({
      kind: 'upgraded',
      onDiskVersion: '0.5.0-beta.3',
      currentVersion: '0.4.1',
    });
  });

  test('stat returns null (ENOENT) → unreadable (no prompt)', () => {
    const state = detectBundleReplace(
      makeInput({
        statSync: () => null,
      }),
    );
    expect(state.kind).toBe('unreadable');
  });

  test('readOnDiskVersion returns null (corrupt plist) → unreadable (no prompt)', () => {
    const state = detectBundleReplace(
      makeInput({
        statSync: () => ({ mtimeMs: 2_000_000 }),
        processStartTimeMs: 1_000_000,
        readOnDiskVersion: () => null,
      }),
    );
    expect(state.kind).toBe('unreadable');
  });

  test('mtime equal to process start → unchanged (boundary inclusive of start)', () => {
    const state = detectBundleReplace(
      makeInput({
        statSync: () => ({ mtimeMs: 1_000_000 }),
        processStartTimeMs: 1_000_000,
      }),
    );
    expect(state.kind).toBe('unchanged');
  });
});

describe('extractShortVersionFromPlist', () => {
  test('extracts CFBundleShortVersionString from a typical Electron XML plist', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>OpenKnowledge</string>
  <key>CFBundleShortVersionString</key>
  <string>0.5.0-beta.3</string>
  <key>CFBundleVersion</key>
  <string>0.5.0-beta.3</string>
</dict>
</plist>`;
    expect(extractShortVersionFromPlist(xml)).toBe('0.5.0-beta.3');
  });

  test('tolerates whitespace and newlines between key and value tags', () => {
    const xml = `<dict><key>CFBundleShortVersionString</key>

    <string>1.2.3</string></dict>`;
    expect(extractShortVersionFromPlist(xml)).toBe('1.2.3');
  });

  test('returns null when CFBundleShortVersionString is absent', () => {
    const xml = `<dict><key>CFBundleName</key><string>x</string></dict>`;
    expect(extractShortVersionFromPlist(xml)).toBeNull();
  });

  test('returns null on garbage / binary input', () => {
    expect(extractShortVersionFromPlist('bplist00\x00\x01\xff')).toBeNull();
    expect(extractShortVersionFromPlist('')).toBeNull();
  });
});

interface WatcherFixtures {
  showMessageBox: ReturnType<typeof mock>;
  relaunch: ReturnType<typeof mock>;
  quit: ReturnType<typeof mock>;
  setInterval: ReturnType<typeof mock>;
  clearInterval: ReturnType<typeof mock>;
  logger: {
    info: ReturnType<typeof mock>;
    warn: ReturnType<typeof mock>;
  };
  tickCallback: (() => void) | null;
  intervalHandle: unknown;
}

function makeFixtures(): WatcherFixtures {
  const fixtures: WatcherFixtures = {
    showMessageBox: mock(() => Promise.resolve({ response: 0, checkboxChecked: false })),
    relaunch: mock(() => {}),
    quit: mock(() => {}),
    setInterval: mock(() => Symbol('interval')),
    clearInterval: mock(() => {}),
    logger: {
      info: mock(() => {}),
      warn: mock(() => {}),
    },
    tickCallback: null,
    intervalHandle: null,
  };
  fixtures.setInterval = mock((cb: () => void, _ms: number) => {
    fixtures.tickCallback = cb;
    fixtures.intervalHandle = Symbol('interval');
    return fixtures.intervalHandle as unknown as ReturnType<typeof setInterval>;
  });
  return fixtures;
}

describe('startBundleReplaceWatcher', () => {
  test('does NOT fire the prompt when on-disk and running versions match', () => {
    const fx = makeFixtures();
    startBundleReplaceWatcher({
      infoPlistPath: '/x/Info.plist',
      getCurrentVersion: () => '0.5.0',
      dialog: { showMessageBox: fx.showMessageBox as never },
      app: { relaunch: fx.relaunch as never, quit: fx.quit as never },
      setInterval: fx.setInterval as never,
      clearInterval: fx.clearInterval as never,
      intervalMs: 60_000,
      processStartTimeMs: 1_000_000,
      statSync: () => ({ mtimeMs: 2_000_000 }),
      readOnDiskVersion: () => '0.5.0',
      logger: fx.logger,
    });
    fx.tickCallback?.();
    expect(fx.showMessageBox).not.toHaveBeenCalled();
  });

  test('fires the prompt exactly once when an upgrade is detected', async () => {
    const fx = makeFixtures();
    fx.showMessageBox = mock(() => Promise.resolve({ response: 1, checkboxChecked: false })); // user clicks "Later"
    startBundleReplaceWatcher({
      infoPlistPath: '/x/Info.plist',
      getCurrentVersion: () => '0.4.1',
      dialog: { showMessageBox: fx.showMessageBox as never },
      app: { relaunch: fx.relaunch as never, quit: fx.quit as never },
      setInterval: fx.setInterval as never,
      clearInterval: fx.clearInterval as never,
      intervalMs: 60_000,
      processStartTimeMs: 1_000_000,
      statSync: () => ({ mtimeMs: 2_000_000 }),
      readOnDiskVersion: () => '0.5.0-beta.3',
      logger: fx.logger,
    });
    fx.tickCallback?.();
    await new Promise((r) => setImmediate(r));
    expect(fx.showMessageBox).toHaveBeenCalledTimes(1);

    fx.tickCallback?.();
    await new Promise((r) => setImmediate(r));
    expect(fx.showMessageBox).toHaveBeenCalledTimes(1);
  });

  test('second tick while dialog is still pending does NOT fire a second prompt', async () => {
    const fx = makeFixtures();
    let resolveDialog: ((v: { response: number; checkboxChecked: boolean }) => void) | null = null;
    fx.showMessageBox = mock(
      () =>
        new Promise<{ response: number; checkboxChecked: boolean }>((r) => {
          resolveDialog = r;
        }),
    );
    startBundleReplaceWatcher({
      infoPlistPath: '/x/Info.plist',
      getCurrentVersion: () => '0.4.1',
      dialog: { showMessageBox: fx.showMessageBox as never },
      app: { relaunch: fx.relaunch as never, quit: fx.quit as never },
      setInterval: fx.setInterval as never,
      clearInterval: fx.clearInterval as never,
      intervalMs: 60_000,
      processStartTimeMs: 1_000_000,
      statSync: () => ({ mtimeMs: 2_000_000 }),
      readOnDiskVersion: () => '0.5.0-beta.3',
      logger: fx.logger,
    });
    fx.tickCallback?.();
    expect(fx.showMessageBox).toHaveBeenCalledTimes(1);

    fx.tickCallback?.();
    expect(fx.showMessageBox).toHaveBeenCalledTimes(1);

    resolveDialog?.({ response: 1, checkboxChecked: false });
    await new Promise((r) => setImmediate(r));
    expect(fx.showMessageBox).toHaveBeenCalledTimes(1);
  });

  test('dialog rejection is swallowed, re-armed for next tick (no crash, no relaunch)', async () => {
    const fx = makeFixtures();
    fx.showMessageBox = mock(() => Promise.reject(new Error('dialog destroyed')));
    startBundleReplaceWatcher({
      infoPlistPath: '/x/Info.plist',
      getCurrentVersion: () => '0.4.1',
      dialog: { showMessageBox: fx.showMessageBox as never },
      app: { relaunch: fx.relaunch as never, quit: fx.quit as never },
      setInterval: fx.setInterval as never,
      clearInterval: fx.clearInterval as never,
      intervalMs: 60_000,
      processStartTimeMs: 1_000_000,
      statSync: () => ({ mtimeMs: 2_000_000 }),
      readOnDiskVersion: () => '0.5.0-beta.3',
      logger: fx.logger,
    });
    fx.tickCallback?.();
    await new Promise((r) => setImmediate(r));
    expect(fx.showMessageBox).toHaveBeenCalledTimes(1);
    expect(fx.relaunch).not.toHaveBeenCalled();
    expect(fx.quit).not.toHaveBeenCalled();
    expect(fx.logger.warn).toHaveBeenCalled();

    fx.tickCallback?.();
    await new Promise((r) => setImmediate(r));
    expect(fx.showMessageBox).toHaveBeenCalledTimes(2);
  });

  test('stop() while dialog is pending, then dialog rejection: does NOT re-arm', async () => {
    const fx = makeFixtures();
    let rejectDialog: ((err: Error) => void) | null = null;
    fx.showMessageBox = mock(
      () =>
        new Promise<{ response: number; checkboxChecked: boolean }>((_, r) => {
          rejectDialog = r;
        }),
    );
    const handle = startBundleReplaceWatcher({
      infoPlistPath: '/x/Info.plist',
      getCurrentVersion: () => '0.4.1',
      dialog: { showMessageBox: fx.showMessageBox as never },
      app: { relaunch: fx.relaunch as never, quit: fx.quit as never },
      setInterval: fx.setInterval as never,
      clearInterval: fx.clearInterval as never,
      intervalMs: 60_000,
      processStartTimeMs: 1_000_000,
      statSync: () => ({ mtimeMs: 2_000_000 }),
      readOnDiskVersion: () => '0.5.0-beta.3',
      logger: fx.logger,
    });
    fx.tickCallback?.();
    expect(fx.showMessageBox).toHaveBeenCalledTimes(1);

    handle.stop();

    rejectDialog?.(new Error('window destroyed'));
    await new Promise((r) => setImmediate(r));

    fx.tickCallback?.();
    await new Promise((r) => setImmediate(r));
    expect(fx.showMessageBox).toHaveBeenCalledTimes(1);
  });

  test('stop() during a pending dialog suppresses relaunch+quit on user response', async () => {
    const fx = makeFixtures();
    let resolveDialog: ((v: { response: number; checkboxChecked: boolean }) => void) | null = null;
    fx.showMessageBox = mock(
      () =>
        new Promise<{ response: number; checkboxChecked: boolean }>((r) => {
          resolveDialog = r;
        }),
    );
    const handle = startBundleReplaceWatcher({
      infoPlistPath: '/x/Info.plist',
      getCurrentVersion: () => '0.4.1',
      dialog: { showMessageBox: fx.showMessageBox as never },
      app: { relaunch: fx.relaunch as never, quit: fx.quit as never },
      setInterval: fx.setInterval as never,
      clearInterval: fx.clearInterval as never,
      intervalMs: 60_000,
      processStartTimeMs: 1_000_000,
      statSync: () => ({ mtimeMs: 2_000_000 }),
      readOnDiskVersion: () => '0.5.0-beta.3',
      logger: fx.logger,
    });
    fx.tickCallback?.();
    expect(fx.showMessageBox).toHaveBeenCalledTimes(1);

    handle.stop();

    resolveDialog?.({ response: 0, checkboxChecked: false });
    await new Promise((r) => setImmediate(r));
    expect(fx.relaunch).not.toHaveBeenCalled();
    expect(fx.quit).not.toHaveBeenCalled();
  });

  test('"Restart now" (response 0) calls app.relaunch BEFORE app.quit', async () => {
    const fx = makeFixtures();
    fx.showMessageBox = mock(() => Promise.resolve({ response: 0, checkboxChecked: false }));
    const callOrder: string[] = [];
    fx.relaunch = mock(() => {
      callOrder.push('relaunch');
    });
    fx.quit = mock(() => {
      callOrder.push('quit');
    });
    startBundleReplaceWatcher({
      infoPlistPath: '/x/Info.plist',
      getCurrentVersion: () => '0.4.1',
      dialog: { showMessageBox: fx.showMessageBox as never },
      app: { relaunch: fx.relaunch as never, quit: fx.quit as never },
      setInterval: fx.setInterval as never,
      clearInterval: fx.clearInterval as never,
      intervalMs: 60_000,
      processStartTimeMs: 1_000_000,
      statSync: () => ({ mtimeMs: 2_000_000 }),
      readOnDiskVersion: () => '0.5.0-beta.3',
      logger: fx.logger,
    });
    fx.tickCallback?.();
    await new Promise((r) => setImmediate(r));
    expect(fx.relaunch).toHaveBeenCalledTimes(1);
    expect(fx.quit).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['relaunch', 'quit']);
  });

  test('"Later" (response 1) leaves the app running and stops the watcher', async () => {
    const fx = makeFixtures();
    fx.showMessageBox = mock(() => Promise.resolve({ response: 1, checkboxChecked: false }));
    const handle = startBundleReplaceWatcher({
      infoPlistPath: '/x/Info.plist',
      getCurrentVersion: () => '0.4.1',
      dialog: { showMessageBox: fx.showMessageBox as never },
      app: { relaunch: fx.relaunch as never, quit: fx.quit as never },
      setInterval: fx.setInterval as never,
      clearInterval: fx.clearInterval as never,
      intervalMs: 60_000,
      processStartTimeMs: 1_000_000,
      statSync: () => ({ mtimeMs: 2_000_000 }),
      readOnDiskVersion: () => '0.5.0-beta.3',
      logger: fx.logger,
    });
    fx.tickCallback?.();
    await new Promise((r) => setImmediate(r));
    expect(fx.relaunch).not.toHaveBeenCalled();
    expect(fx.quit).not.toHaveBeenCalled();
    handle.stop();
    expect(fx.clearInterval).toHaveBeenCalled();
  });

  test('errors in statSync are swallowed (logged at warn, no crash)', () => {
    const fx = makeFixtures();
    const throwingStat = mock(() => {
      throw new Error('EACCES');
    });
    startBundleReplaceWatcher({
      infoPlistPath: '/x/Info.plist',
      getCurrentVersion: () => '0.4.1',
      dialog: { showMessageBox: fx.showMessageBox as never },
      app: { relaunch: fx.relaunch as never, quit: fx.quit as never },
      setInterval: fx.setInterval as never,
      clearInterval: fx.clearInterval as never,
      intervalMs: 60_000,
      processStartTimeMs: 1_000_000,
      statSync: throwingStat as never,
      readOnDiskVersion: () => '0.5.0',
      logger: fx.logger,
    });
    expect(() => fx.tickCallback?.()).not.toThrow();
    expect(fx.showMessageBox).not.toHaveBeenCalled();
    expect(fx.logger.warn).toHaveBeenCalled();
  });

  test('handle.stop() clears the interval and prevents future ticks', () => {
    const fx = makeFixtures();
    const handle = startBundleReplaceWatcher({
      infoPlistPath: '/x/Info.plist',
      getCurrentVersion: () => '0.4.1',
      dialog: { showMessageBox: fx.showMessageBox as never },
      app: { relaunch: fx.relaunch as never, quit: fx.quit as never },
      setInterval: fx.setInterval as never,
      clearInterval: fx.clearInterval as never,
      intervalMs: 60_000,
      processStartTimeMs: 1_000_000,
      statSync: () => ({ mtimeMs: 500_000 }),
      readOnDiskVersion: () => '0.4.1',
      logger: fx.logger,
    });
    handle.stop();
    expect(fx.clearInterval).toHaveBeenCalledWith(fx.intervalHandle);
  });
});
