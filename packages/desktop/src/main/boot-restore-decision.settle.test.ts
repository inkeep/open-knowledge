import { describe, expect, test } from 'bun:test';
// `resolveBootRestoreDecision` is the boot-orchestration seam: an async
// coordinator that withholds the boot-restore decision until cold-start URL
// delivery has SETTLED, then reads the launch flag, then delegates to the pure
// `bootRestoreDecision`. On macOS the `open-url` Apple Event is delivered
// asynchronously and can land after the synchronous boot read, so the flag must
// not be read until the settle await resolves — otherwise a cold-start share is
// buried by the `lastOpenedProject` restore. These tests pin that contract.
import { resolveBootRestoreDecision } from './boot-restore-decision.ts';
import { registerProtocolHandler } from './url-scheme.ts';

// A valid share for a repo NOT held locally (the reported clone flow). It parses
// to a launch-claiming `kind:'ok'` share, so delivering it flips
// `urlLaunchOwnsWindow` to true.
const SHARE_URL = 'openknowledge://share?url=https://github.com/inkeep/not-cloned-repo/tree/main';
// A single-file deep-link (`ok <file>` → `openknowledge://open?file=<abs>`). The
// single-file path rides the SAME `urlLaunchOwnsWindow` read at the same seam,
// so one settle barrier covers both share and single-file cold-start URLs.
const SINGLE_FILE_URL = 'openknowledge://open?file=/Users/me/notes/scratch.md';

// Spin a REAL `registerProtocolHandler` and capture its `open-url` listener so a
// test controls the exact moment the macOS Apple Event is "delivered" relative
// to the settle await. `whenReady` never resolves, so the handler's internal
// auto-flush loop never runs — the flag is observed purely as a function of
// delivery timing.
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
    // Pin non-darwin so the settle source resolves immediately (non-darwin fast
    // path) rather than hanging on the grace timer that never fires (whenReady =
    // neverReady). The darwin settle path is covered by url-scheme.settle.test.ts.
    platform: 'linux',
  });
  return {
    control,
    deliver: (url: string) => openUrlListener?.({ preventDefault: () => {} }, url),
  };
}

// A settle barrier the test releases by hand, so delivery can be interleaved
// deterministically inside the window (no wall-clock, no sleeps).
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

    // At decision time the Apple Event has not been delivered — the flag is stale.
    expect(control.urlLaunchOwnsWindow()).toBe(false);

    // The cold-start `open-url` Apple Event lands mid-settle; the flag flips.
    deliver(SHARE_URL);
    expect(control.urlLaunchOwnsWindow()).toBe(true);

    // Only now may the coordinator read the flag and decide.
    settle.release();
    const decision = await decisionPromise;

    // The share owns the launch; the previously-opened project must NOT be restored.
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

    // Settle completes with no URL delivered — the flag never flips.
    settle.release();
    const decision = await decisionPromise;

    expect(decision).toEqual({
      clearSnapshot: false,
      action: 'lastOpened',
      project: '/projects/last',
    });
  });

  test('an update-relaunch snapshot still beats a URL delivered during the settle window', async () => {
    const { control, deliver } = makeHandler();
    const settle = manualSettle();

    const decisionPromise = resolveBootRestoreDecision({
      pendingRestore: ['/projects/a'],
      lastOpenedProject: '/projects/last',
      optionHeld: false,
      pathExists: () => true,
      urlLaunchOwnsWindow: control.urlLaunchOwnsWindow,
      waitForUrlLaunchSettled: settle.waitForUrlLaunchSettled,
    });

    // A share lands mid-settle, but the pure ranking is unchanged: the
    // update-relaunch snapshot outranks a URL claim, through the coordinator too.
    deliver(SHARE_URL);
    expect(control.urlLaunchOwnsWindow()).toBe(true);

    settle.release();
    const decision = await decisionPromise;

    expect(decision).toEqual({
      clearSnapshot: true,
      action: 'restore',
      projects: ['/projects/a'],
    });
  });

  test('reads the launch flag STRICTLY AFTER the settle await resolves', async () => {
    const { control } = makeHandler();

    let settleResolved = false;
    // Resolve on a microtask so a coordinator that reads the flag before awaiting
    // settle observes `settleResolved === false` at read time.
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

    // The flag was read only after settling completed.
    expect(flagReadAfterSettle).toBe(true);
  });
});
