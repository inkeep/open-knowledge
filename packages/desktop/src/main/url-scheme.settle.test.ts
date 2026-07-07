import { describe, expect, test } from 'bun:test';
// `waitForUrlLaunchSettled` is the REAL settle SOURCE the boot coordinator
// (`resolveBootRestoreDecision`) awaits before reading the launch flag. It lives
// on the `ProtocolHandlerControl` returned by `registerProtocolHandler` — the
// module that owns the flag/queue and the `open-url` listener. On macOS the
// cold-start Apple Event is delivered asynchronously, so the settle promise must
// resolve on WHICHEVER comes first: the flag flipping (a launch-claiming URL
// arrived — early resolve, ~0 wait) OR a bounded grace window elapsing (the
// safety net for a late Apple Event, armed at `whenReady`). Off macOS there is
// no Apple Event, so it resolves immediately; likewise when the launch is
// already claimed before the settle is awaited. These tests pin that timing
// contract at the public control interface. The grace bound is exercised through
// the injectable `deps.setTimeout` seam the module already exposes, so no
// wall-clock is involved and the tests are deterministic.
import { resolveBootRestoreDecision } from './boot-restore-decision.ts';
import { registerProtocolHandler } from './url-scheme.ts';

// A valid share for a repo NOT held locally. Parses to a launch-claiming
// `kind:'ok'` share, so delivering it flips `urlLaunchOwnsWindow` to true.
const SHARE_URL = 'openknowledge://share?url=https://github.com/inkeep/not-cloned-repo/tree/main';
// A single-file deep-link (`ok <file>` -> `openknowledge://open?file=<abs>`).
// The single-file path is the OTHER launch-claiming kind that flips the flag.
const SINGLE_FILE_URL = 'openknowledge://open?file=/Users/me/notes/scratch.md';

// Drain the microtask queue so any settle `.then` callbacks run. Every settle
// resolution in these tests is driven by an explicit event we trigger (deliver /
// resolveReady / fireScheduled); this only lets those resolutions propagate. No
// wall-clock, no fixed-duration waits.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

// Spin a REAL `registerProtocolHandler` with controllable boundary deps:
//   - `whenReady` resolves by hand (`resolveReady`) so the grace timer's
//     arm-at-whenReady moment is deterministic.
//   - `open-url` listener is captured (`deliver`) so a test controls the exact
//     instant the Apple Event "lands" relative to the settle await.
//   - `setTimeout` is captured (`scheduled` / `fireScheduled`) so the bounded
//     grace window elapses on command, never on wall-clock time.
//   - `platform` selects the darwin vs non-darwin gate.
// `getInitialArgv` is empty, so the URL queue starts empty and the auto-flush
// loop drains immediately without scheduling — the only timer that lands in
// `scheduled` is the grace window.
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
    // Injectable darwin gate — the settle source resolves immediately off macOS
    // (no Apple Event to wait for). Optional dep the fix adds.
    platform: opts.platform,
  });

  return {
    control,
    deliver: (url: string) => openUrlListener?.({ preventDefault: () => {} }, url),
    resolveReady,
    scheduled,
    // Elapse every armed timer (the grace window) exactly once.
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

    h.resolveReady(); // arm the bounded grace window at whenReady
    await flushMicrotasks();
    // No URL yet and the grace window has not elapsed -> settle stays pending.
    expect(settled).toBe(false);
    // A bounded grace wait was genuinely armed (via the injectable setTimeout),
    // so resolving now is an EARLY resolve, not an unconditional immediate one.
    expect(h.scheduled.length).toBeGreaterThan(0);

    h.deliver(SHARE_URL); // Apple Event lands mid-window; flips the flag
    expect(h.control.urlLaunchOwnsWindow()).toBe(true);
    await flushMicrotasks();

    // Early-resolved on the flag flip — and we never fired the grace timer,
    // so this cannot be the grace-timeout path.
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
    // Grace armed but not yet elapsed, and no URL arrived -> still pending.
    expect(settled).toBe(false);
    expect(h.control.urlLaunchOwnsWindow()).toBe(false);

    h.fireScheduled(); // the grace window elapses
    await flushMicrotasks();
    expect(settled).toBe(true);
  });

  test('(c) on a non-darwin platform settle resolves immediately (no Apple Event exists)', async () => {
    const h = makeHandler({ platform: 'linux' });

    let settled = false;
    void h.control.waitForUrlLaunchSettled().then(() => {
      settled = true;
    });

    // No whenReady resolution, no URL delivery, no grace timer fired: the only
    // path to resolution is the non-darwin immediate gate.
    await flushMicrotasks();
    expect(settled).toBe(true);
  });

  test('(d) when the launch is already claimed, settle resolves immediately', async () => {
    const h = makeHandler({ platform: 'darwin' });

    // A launch-claiming URL flips the flag BEFORE settle is ever awaited (the
    // Apple Event / cold-start argv beat the boot read).
    h.deliver(SINGLE_FILE_URL);
    expect(h.control.urlLaunchOwnsWindow()).toBe(true);

    let settled = false;
    void h.control.waitForUrlLaunchSettled().then(() => {
      settled = true;
    });

    // No whenReady resolution, no grace timer fired: resolution can only come
    // from the already-claimed fast path.
    await flushMicrotasks();
    expect(settled).toBe(true);
  });

  test('(e) composition: the coordinator wired to the REAL settle source lets a mid-window share win', async () => {
    const h = makeHandler({ platform: 'darwin' });

    // Wire resolveBootRestoreDecision to the real control — no manualSettle
    // override. This is the production wiring shape from the boot path; the
    // coordinator suite covers ordering with an injected barrier, this pins the
    // two halves actually composed.
    const decisionPromise = resolveBootRestoreDecision({
      pendingRestore: null,
      lastOpenedProject: '/projects/last',
      optionHeld: false,
      pathExists: () => true,
      urlLaunchOwnsWindow: h.control.urlLaunchOwnsWindow,
      waitForUrlLaunchSettled: h.control.waitForUrlLaunchSettled,
    });

    h.resolveReady(); // arm the grace window at whenReady
    await flushMicrotasks();

    // The share lands mid-window (grace never fired); early-resolve releases
    // the coordinator, which reads the flipped flag and suppresses the restore.
    h.deliver(SHARE_URL);
    const decision = await decisionPromise;
    expect(decision).toEqual({ clearSnapshot: false, action: 'none' });
  });
});
