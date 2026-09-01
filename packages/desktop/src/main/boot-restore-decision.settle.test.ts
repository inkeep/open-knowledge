import { describe, expect, test } from 'vitest';
import { resolveBootRestoreDecision } from './boot-restore-decision.ts';
import { registerProtocolHandler } from './url-scheme.ts';

const SHARE_URL = 'openknowledge://share?url=https://github.com/inkeep/not-cloned-repo/tree/main';
const SINGLE_FILE_URL = 'openknowledge://open?file=/Users/me/notes/scratch.md';

function makeHandler() {
  let openUrlListener: ((event: { preventDefault: () => void }, url: string) => void) | null = null;
  const neverReady = new Promise<void>(() => {});
  const control = registerProtocolHandler({
    app: {
      // biome-ignore lint/suspicious/noExplicitAny: minimal test double for electron.app.
      on(event: string, cb: any) {
        if (event === 'open-url') openUrlListener = cb;
      },
      whenReady: () => neverReady,
      isPackaged: true,
      setAsDefaultProtocolClient: () => true,
      removeAsDefaultProtocolClient: () => true,
      // biome-ignore lint/suspicious/noExplicitAny: only the listeners above are exercised.
    } as any,
    focusWindowForProject: () => null,
    openProject: async () => null,
    sendDeepLink: () => {},
    getAnyReadyWindow: () => null,
    getInitialArgv: () => [],
    platform: 'linux',
  });
  return {
    control,
    deliver: (url: string) => openUrlListener?.({ preventDefault: () => {} }, url),
  };
}

function manualSettle() {
  let release!: () => void;
  const promise = new Promise<void>((res) => {
    release = res;
  });
  return { waitForUrlLaunchSettled: () => promise, release };
}

describe('resolveBootRestoreDecision (cold-start URL settle barrier)', () => {
  test('a share URL delivered DURING the settle window wins the launch (action none, not lastOpened)', async () => {
    const { control, deliver } = makeHandler();
    const settle = manualSettle();

    const decisionPromise = resolveBootRestoreDecision({
      pendingRestore: null,
      lastOpenedProject: '/projects/last',
      optionHeld: false,
      pathExists: () => true,
      urlLaunchOwnsWindow: control.urlLaunchOwnsWindow,
      waitForUrlLaunchSettled: settle.waitForUrlLaunchSettled,
    });

    expect(control.urlLaunchOwnsWindow()).toBe(false);

    deliver(SHARE_URL);
    expect(control.urlLaunchOwnsWindow()).toBe(true);

    settle.release();
    const decision = await decisionPromise;

    expect(decision).toEqual({ clearSnapshot: false, action: 'none' });
  });

  test('a single-file URL delivered DURING the settle window wins the launch (action none)', async () => {
    const { control, deliver } = makeHandler();
    const settle = manualSettle();

    const decisionPromise = resolveBootRestoreDecision({
      pendingRestore: null,
      lastOpenedProject: '/projects/last',
      optionHeld: false,
      pathExists: () => true,
      urlLaunchOwnsWindow: control.urlLaunchOwnsWindow,
      waitForUrlLaunchSettled: settle.waitForUrlLaunchSettled,
    });

    expect(control.urlLaunchOwnsWindow()).toBe(false);
    deliver(SINGLE_FILE_URL);
    expect(control.urlLaunchOwnsWindow()).toBe(true);

    settle.release();
    const decision = await decisionPromise;

    expect(decision).toEqual({ clearSnapshot: false, action: 'none' });
  });

  test('no URL during the settle window still restores lastOpenedProject (normal restore preserved)', async () => {
    const { control } = makeHandler();
    const settle = manualSettle();

    const decisionPromise = resolveBootRestoreDecision({
      pendingRestore: null,
      lastOpenedProject: '/projects/last',
      optionHeld: false,
      pathExists: () => true,
      urlLaunchOwnsWindow: control.urlLaunchOwnsWindow,
      waitForUrlLaunchSettled: settle.waitForUrlLaunchSettled,
    });

    settle.release();
    const decision = await decisionPromise;

    expect(decision).toEqual({
      clearSnapshot: false,
      action: 'lastOpened',
      project: '/projects/last',
    });
  });

  test('no URL during the settle window still restores a non-empty snapshot', async () => {
    const { control } = makeHandler();
    const settle = manualSettle();

    const decisionPromise = resolveBootRestoreDecision({
      pendingRestore: [{ kind: 'project', projectPath: '/projects/a' }],
      lastOpenedProject: '/projects/last',
      optionHeld: false,
      pathExists: () => true,
      urlLaunchOwnsWindow: control.urlLaunchOwnsWindow,
      waitForUrlLaunchSettled: settle.waitForUrlLaunchSettled,
    });

    settle.release();
    const decision = await decisionPromise;

    expect(decision).toEqual({
      clearSnapshot: true,
      action: 'restore',
      windows: [{ kind: 'project', projectPath: '/projects/a' }],
    });
  });

  test('a share delivered during the settle window suppresses a non-empty restore snapshot (action none)', async () => {
    const { control, deliver } = makeHandler();
    const settle = manualSettle();

    const decisionPromise = resolveBootRestoreDecision({
      pendingRestore: [{ kind: 'project', projectPath: '/projects/a' }],
      lastOpenedProject: '/projects/last',
      optionHeld: false,
      pathExists: () => true,
      urlLaunchOwnsWindow: control.urlLaunchOwnsWindow,
      waitForUrlLaunchSettled: settle.waitForUrlLaunchSettled,
    });

    deliver(SHARE_URL);
    expect(control.urlLaunchOwnsWindow()).toBe(true);

    settle.release();
    const decision = await decisionPromise;

    expect(decision).toEqual({ clearSnapshot: true, action: 'none' });
  });

  test('a single-file URL delivered during the settle window suppresses a non-empty restore snapshot (action none)', async () => {
    const { control, deliver } = makeHandler();
    const settle = manualSettle();

    const decisionPromise = resolveBootRestoreDecision({
      pendingRestore: [{ kind: 'project', projectPath: '/projects/a' }],
      lastOpenedProject: '/projects/last',
      optionHeld: false,
      pathExists: () => true,
      urlLaunchOwnsWindow: control.urlLaunchOwnsWindow,
      waitForUrlLaunchSettled: settle.waitForUrlLaunchSettled,
    });

    deliver(SINGLE_FILE_URL);
    expect(control.urlLaunchOwnsWindow()).toBe(true);

    settle.release();
    const decision = await decisionPromise;

    expect(decision).toEqual({ clearSnapshot: true, action: 'none' });
  });

  test('reads the launch flag STRICTLY AFTER the settle await resolves', async () => {
    const { control } = makeHandler();

    let settleResolved = false;
    const settled = new Promise<void>((res) => {
      queueMicrotask(() => {
        settleResolved = true;
        res();
      });
    });

    let flagReadAfterSettle: boolean | null = null;
    const reader = () => {
      flagReadAfterSettle = settleResolved;
      return control.urlLaunchOwnsWindow();
    };

    await resolveBootRestoreDecision({
      pendingRestore: null,
      lastOpenedProject: '/projects/last',
      optionHeld: false,
      pathExists: () => true,
      urlLaunchOwnsWindow: reader,
      waitForUrlLaunchSettled: () => settled,
    });

    expect(flagReadAfterSettle).toBe(true);
  });
});
