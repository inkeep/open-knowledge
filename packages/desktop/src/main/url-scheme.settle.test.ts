import { describe, expect, test } from 'vitest';
import { resolveBootRestoreDecision } from './boot-restore-decision.ts';
import { registerProtocolHandler } from './url-scheme.ts';

const SHARE_URL = 'openknowledge://share?url=https://github.com/inkeep/not-cloned-repo/tree/main';
const SINGLE_FILE_URL = 'openknowledge://open?file=/Users/me/notes/scratch.md';

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function makeHandler(opts: { platform: NodeJS.Platform }) {
  let openUrlListener: ((event: { preventDefault: () => void }, url: string) => void) | null = null;
  let resolveReady!: () => void;
  const ready = new Promise<void>((res) => {
    resolveReady = res;
  });
  const scheduled: Array<() => void> = [];

  const control = registerProtocolHandler({
    app: {
      // biome-ignore lint/suspicious/noExplicitAny: minimal test double for electron.app.
      on(event: string, cb: any) {
        if (event === 'open-url') openUrlListener = cb;
      },
      whenReady: () => ready,
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
    setTimeout: (cb: () => void, _ms: number) => {
      scheduled.push(cb);
      return scheduled.length;
    },
    platform: opts.platform,
  });

  return {
    control,
    deliver: (url: string) => openUrlListener?.({ preventDefault: () => {} }, url),
    resolveReady,
    scheduled,
    fireScheduled: () => {
      const snapshot = scheduled.splice(0, scheduled.length);
      for (const cb of snapshot) cb();
    },
  };
}

describe('ProtocolHandlerControl.waitForUrlLaunchSettled (cold-start URL settle source)', () => {
  test('(a) a launch-claiming URL flipping the flag early-resolves settle, before the grace window elapses', async () => {
    const h = makeHandler({ platform: 'darwin' });

    let settled = false;
    void h.control.waitForUrlLaunchSettled().then(() => {
      settled = true;
    });

    h.resolveReady();
    await flushMicrotasks();
    expect(settled).toBe(false);
    expect(h.scheduled.length).toBeGreaterThan(0);

    h.deliver(SHARE_URL);
    expect(h.control.urlLaunchOwnsWindow()).toBe(true);
    await flushMicrotasks();

    expect(settled).toBe(true);
  });

  test('(b) with no URL, settle resolves when the grace window elapses (armed at whenReady)', async () => {
    const h = makeHandler({ platform: 'darwin' });

    let settled = false;
    void h.control.waitForUrlLaunchSettled().then(() => {
      settled = true;
    });

    h.resolveReady();
    await flushMicrotasks();
    expect(settled).toBe(false);
    expect(h.control.urlLaunchOwnsWindow()).toBe(false);

    h.fireScheduled();
    await flushMicrotasks();
    expect(settled).toBe(true);
  });

  test('(c) on a non-darwin platform settle resolves immediately (no Apple Event exists)', async () => {
    const h = makeHandler({ platform: 'linux' });

    let settled = false;
    void h.control.waitForUrlLaunchSettled().then(() => {
      settled = true;
    });

    await flushMicrotasks();
    expect(settled).toBe(true);
  });

  test('(d) when the launch is already claimed, settle resolves immediately', async () => {
    const h = makeHandler({ platform: 'darwin' });

    h.deliver(SINGLE_FILE_URL);
    expect(h.control.urlLaunchOwnsWindow()).toBe(true);

    let settled = false;
    void h.control.waitForUrlLaunchSettled().then(() => {
      settled = true;
    });

    await flushMicrotasks();
    expect(settled).toBe(true);
  });

  test('(e) composition: the coordinator wired to the REAL settle source lets a mid-window share win', async () => {
    const h = makeHandler({ platform: 'darwin' });

    const decisionPromise = resolveBootRestoreDecision({
      pendingRestore: null,
      lastOpenedProject: '/projects/last',
      optionHeld: false,
      pathExists: () => true,
      urlLaunchOwnsWindow: h.control.urlLaunchOwnsWindow,
      waitForUrlLaunchSettled: h.control.waitForUrlLaunchSettled,
    });

    h.resolveReady();
    await flushMicrotasks();

    h.deliver(SHARE_URL);
    const decision = await decisionPromise;
    expect(decision).toEqual({ clearSnapshot: false, action: 'none' });
  });
});
