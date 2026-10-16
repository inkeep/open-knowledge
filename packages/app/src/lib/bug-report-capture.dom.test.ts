import type { OkBugReportScreenshot } from '@inkeep/open-knowledge-core/logger-types';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { collectBlocks, readGlobalsCssRaw } from '@/globals-css.test-helper';
import { installPointerPositionTracker } from '@/lib/pointer-position';
import {
  type BugReportCapture,
  captureBugReport,
  createBugReportController,
} from './bug-report-capture';

const SCREENSHOT: OkBugReportScreenshot = {
  dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  width: 1200,
  height: 800,
};

const LAUNCHER_FREE = { launcherBorne: false } as const;
const LAUNCHER_BORNE = { launcherBorne: true } as const;

function installCapture(capture: () => Promise<OkBugReportScreenshot | null>): { calls: number } {
  const log = { calls: 0 };
  Object.defineProperty(window, 'okDesktop', {
    configurable: true,
    writable: true,
    value: {
      bugReport: {
        captureScreenshot: () => {
          log.calls += 1;
          return capture();
        },
      },
    },
  });
  return log;
}

function installLauncherStylesheet(): HTMLStyleElement {
  const rule = collectBlocks(readGlobalsCssRaw()).find((block) =>
    block.prelude.includes('[data-bug-report-launcher]'),
  );
  expect(rule, 'globals.css declares the launcher-hiding rule').toBeDefined();
  const style = document.createElement('style');
  style.textContent = `${rule?.prelude}{${rule?.declarations}}`;
  document.head.append(style);
  return style;
}

function movePointerTo(x: number, y: number): void {
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
}

async function releaseHeldFrames(queued: FrameRequestCallback[]): Promise<void> {
  vi.mocked(window.requestAnimationFrame).mockRestore();
  for (const cb of queued.splice(0)) cb(performance.now());
  await vi.waitFor(() =>
    expect(document.documentElement.hasAttribute('data-bug-report-capturing')).toBe(false),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('captureBugReport', () => {
  let stopPointerTracking: (() => void) | undefined;

  afterEach(() => {
    stopPointerTracking?.();
    stopPointerTracking = undefined;
    vi.restoreAllMocks();
    Object.defineProperty(window, 'okDesktop', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    document.body.replaceChildren();
    document.head.replaceChildren();
    document.documentElement.removeAttribute('data-bug-report-capturing');
  });

  test('hides launcher-marked elements and nothing else while the bridge shoots, then restores them', async () => {
    installLauncherStylesheet();
    const launcher = document.createElement('div');
    launcher.setAttribute('data-bug-report-launcher', '');
    const overlay = document.createElement('div');
    overlay.setAttribute('data-radix-popper-content-wrapper', '');
    document.body.append(launcher, overlay);

    let visibilityAtCapture: { launcher: string; overlay: string } | null = null;
    installCapture(() => {
      visibilityAtCapture = {
        launcher: getComputedStyle(launcher).visibility,
        overlay: getComputedStyle(overlay).visibility,
      };
      return Promise.resolve(SCREENSHOT);
    });

    const result = await captureBugReport(LAUNCHER_BORNE);

    expect(visibilityAtCapture).toEqual({ launcher: 'hidden', overlay: 'visible' });
    expect(result).toEqual({ screenshot: SCREENSHOT, pointerMarked: false });
    await vi.waitFor(() => expect(getComputedStyle(launcher).visibility).toBe('visible'));
    expect(document.documentElement.hasAttribute('data-bug-report-capturing')).toBe(false);
  });

  test('a launcher-free origin keeps launcher-marked menus in the shot', async () => {
    installLauncherStylesheet();
    const launcher = document.createElement('div');
    launcher.setAttribute('data-bug-report-launcher', '');
    document.body.append(launcher);

    let visibilityAtCapture: string | null = null;
    installCapture(() => {
      visibilityAtCapture = getComputedStyle(launcher).visibility;
      return Promise.resolve(SCREENSHOT);
    });

    await captureBugReport(LAUNCHER_FREE);

    expect(visibilityAtCapture).toBe('visible');
  });

  test('overlapping launcher-borne captures keep launchers hidden until the last one settles', async () => {
    const first = deferred<OkBugReportScreenshot>();
    const second = deferred<OkBugReportScreenshot>();
    const queue = [first.promise, second.promise];
    const log = installCapture(() => queue.shift() ?? Promise.resolve(null));
    const capturing = () => document.documentElement.hasAttribute('data-bug-report-capturing');

    const a = captureBugReport(LAUNCHER_BORNE);
    const b = captureBugReport(LAUNCHER_BORNE);
    await vi.waitFor(() => expect(log.calls).toBe(2));
    first.resolve(SCREENSHOT);
    await a;
    for (let frame = 0; frame < 4; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    expect(capturing()).toBe(true);
    second.resolve(SCREENSHOT);
    await b;
    await vi.waitFor(() => expect(capturing()).toBe(false));
  });

  test('a launcher-free origin puts the pointer marker in the frame and takes it out afterwards', async () => {
    stopPointerTracking = installPointerPositionTracker();
    movePointerTo(420, 260);

    let markerAtCapture: { left: string; top: string } | null = null;
    installCapture(() => {
      const marker = document.querySelector<HTMLElement>('.ok-pointer-marker');
      markerAtCapture = marker && { left: marker.style.left, top: marker.style.top };
      return Promise.resolve(SCREENSHOT);
    });

    const result = await captureBugReport(LAUNCHER_FREE);

    expect(markerAtCapture).toEqual({ left: '420px', top: '260px' });
    expect(document.querySelector('.ok-pointer-marker')).toBeNull();
    expect(result).toEqual({ screenshot: SCREENSHOT, pointerMarked: true });
  });

  test('a launcher-borne origin draws no marker even with the pointer known', async () => {
    stopPointerTracking = installPointerPositionTracker();
    movePointerTo(500, 300);

    let markersAtCapture = -1;
    installCapture(() => {
      markersAtCapture = document.querySelectorAll('.ok-pointer-marker').length;
      return Promise.resolve(SCREENSHOT);
    });

    const result = await captureBugReport(LAUNCHER_BORNE);

    expect(markersAtCapture).toBe(0);
    expect(result.pointerMarked).toBe(false);
  });

  test('with the pointer never seen, a launcher-free capture draws no marker and says so', async () => {
    stopPointerTracking = installPointerPositionTracker();

    let markersAtCapture = -1;
    installCapture(() => {
      markersAtCapture = document.querySelectorAll('.ok-pointer-marker').length;
      return Promise.resolve(SCREENSHOT);
    });

    const result = await captureBugReport(LAUNCHER_FREE);

    expect(markersAtCapture).toBe(0);
    expect(result).toEqual({ screenshot: SCREENSHOT, pointerMarked: false });
  });

  test('a bridge with no capture resolves empty without touching the document', async () => {
    stopPointerTracking = installPointerPositionTracker();
    movePointerTo(10, 10);
    const observed: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) observed.push(record.type);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
    });

    const result = await captureBugReport(LAUNCHER_FREE);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    observer.disconnect();

    expect(result).toEqual({ screenshot: null, pointerMarked: false });
    expect(observed).toEqual([]);
  });

  test('a rejected capture resolves empty and still cleans up', async () => {
    stopPointerTracking = installPointerPositionTracker();
    movePointerTo(80, 90);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let markersAtCapture = -1;
    installCapture(() => {
      markersAtCapture = document.querySelectorAll('.ok-pointer-marker').length;
      return Promise.reject(new Error('capture failed'));
    });

    const result = await captureBugReport(LAUNCHER_FREE);

    expect(markersAtCapture).toBe(1);
    expect(result).toEqual({ screenshot: null, pointerMarked: false });
    expect(document.querySelector('.ok-pointer-marker')).toBeNull();
    expect(document.documentElement.hasAttribute('data-bug-report-capturing')).toBe(false);
    expect(warn).toHaveBeenCalledWith('[bug-report] screenshot capture failed:', expect.any(Error));
  });

  test('a capture that outlives the reveal timeout resolves empty, cleans up, and its late frame is discarded', async () => {
    stopPointerTracking = installPointerPositionTracker();
    movePointerTo(140, 200);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pending = deferred<OkBugReportScreenshot>();
    const log = installCapture(() => pending.promise);

    const result = await captureBugReport(LAUNCHER_FREE);

    expect(result).toEqual({ screenshot: null, pointerMarked: false });
    expect(document.querySelector('.ok-pointer-marker')).toBeNull();
    expect(document.documentElement.hasAttribute('data-bug-report-capturing')).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      '[bug-report] screenshot capture did not settle within 1200ms; revealing without one',
    );
    expect(log.calls).toBe(1);
    pending.resolve(SCREENSHOT);
    await pending.promise;
    expect(document.querySelector('.ok-pointer-marker')).toBeNull();
  });

  test('the bridge is called only after a frame showing the capturing state has painted', async () => {
    const queued: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) =>
      queued.push(cb),
    );
    const log = installCapture(() => Promise.resolve(SCREENSHOT));

    const result = captureBugReport(LAUNCHER_BORNE);
    expect(document.documentElement.hasAttribute('data-bug-report-capturing')).toBe(true);
    for (const cb of queued.splice(0)) cb(performance.now());
    expect(log.calls).toBe(0);
    for (const cb of queued.splice(0)) cb(performance.now());
    expect(log.calls).toBe(1);

    expect(await result).toEqual({ screenshot: SCREENSHOT, pointerMarked: false });
    await releaseHeldFrames(queued);
  });

  test('a frame that never arrives before the timeout never reaches the bridge', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const queued: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) =>
      queued.push(cb),
    );
    const log = installCapture(() => Promise.resolve(SCREENSHOT));

    const result = await captureBugReport(LAUNCHER_BORNE);
    expect(result.screenshot).toBeNull();
    expect(log.calls).toBe(0);

    for (const cb of queued.splice(0)) cb(performance.now());
    await Promise.resolve();
    expect(log.calls).toBe(0);
    await releaseHeldFrames(queued);
  });
});

describe('createBugReportController', () => {
  afterEach(() => {
    Object.defineProperty(window, 'okDesktop', {
      configurable: true,
      writable: true,
      value: undefined,
    });
  });

  function controllerWithLog() {
    const captures: Array<BugReportCapture | null> = [];
    const controller = createBugReportController((capture) => captures.push(capture));
    return { controller, captures };
  }

  test('start captures, runs the dismissal, then opens with the result', async () => {
    const pending = deferred<OkBugReportScreenshot>();
    installCapture(() => pending.promise);
    const { controller, captures } = controllerWithLog();
    const order: string[] = [];

    controller.start(LAUNCHER_BORNE, () => order.push('dismiss'));
    expect(captures).toEqual([]);
    pending.resolve(SCREENSHOT);
    await vi.waitFor(() => expect(captures).toHaveLength(1));

    expect(order).toEqual(['dismiss']);
    expect(captures[0]).toEqual({ screenshot: SCREENSHOT, pointerMarked: false });
  });

  test('a start while capturing or open is ignored, so the first origin wins', async () => {
    const log = installCapture(() => Promise.resolve(SCREENSHOT));
    const { controller, captures } = controllerWithLog();

    controller.start(LAUNCHER_BORNE);
    controller.start(LAUNCHER_FREE);
    await vi.waitFor(() => expect(captures).toHaveLength(1));
    controller.start(LAUNCHER_FREE);
    for (let frame = 0; frame < 2; frame++)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(log.calls).toBe(1);
    expect(captures).toEqual([{ screenshot: SCREENSHOT, pointerMarked: false }]);
  });

  test('close drops a result that lands afterwards and leaves the next start free to run', async () => {
    const first = deferred<OkBugReportScreenshot>();
    const second = deferred<OkBugReportScreenshot>();
    const queue = [first.promise, second.promise];
    installCapture(() => queue.shift() ?? Promise.resolve(null));
    const { controller, captures } = controllerWithLog();
    const dismissals: string[] = [];

    controller.start(LAUNCHER_BORNE, () => dismissals.push('first'));
    controller.close();
    controller.start(LAUNCHER_BORNE, () => dismissals.push('second'));
    first.resolve(SCREENSHOT);
    second.resolve({ ...SCREENSHOT, width: 1 });
    await vi.waitFor(() => expect(captures.filter((c) => c !== null)).toHaveLength(1));

    expect(dismissals).toEqual(['second']);
    expect(captures.at(-1)).toEqual({
      screenshot: { ...SCREENSHOT, width: 1 },
      pointerMarked: false,
    });
  });
});
