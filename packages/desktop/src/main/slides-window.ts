import { gracefulTerminate } from './graceful-terminate.ts';
import type { RunningSlidesDeck, SlidesDeckRegistry, SlidesDeckWindow } from './slides-registry.ts';

function slidesEmbedUrl(port: number): string {
  return `http://localhost:${port}/?embedded=true`;
}

const SLIDES_PARTITION = 'slides';

const SLIDES_WINDOW_TITLE = 'Slidev — OpenKnowledge';

const SLIDEV_RENDER_STABILITY_MS = 500;

export const SLIDEV_RENDERED_CHECK = `(() => {
  const readySinceKey = '__okSlidevReadySince';
  const slide = document.querySelector('#app [data-slidev-no]');
  const ready =
    slide !== null &&
    !slide.matches('.slidev-slide-loading') &&
    slide.querySelector('.slidev-slide-loading') === null;
  if (!ready) {
    delete window[readySinceKey];
    return false;
  }
  const now = performance.now();
  const readySince = window[readySinceKey];
  if (typeof readySince !== 'number') {
    window[readySinceKey] = now;
    return false;
  }
  return now - readySince >= ${SLIDEV_RENDER_STABILITY_MS};
})()`;
const NAVIGATION_TIMEOUT_MS = 30_000;
const RENDERER_TIMEOUT_MS = 30_000;
const RENDERER_POLL_INTERVAL_MS = 100;

export interface SlidesWindowChrome {
  readonly titleBarStyle: 'default';
  readonly titleBarOverlay: false;
  readonly trafficLightPosition: undefined;
  readonly transparent: false;
  readonly vibrancy: undefined;
  readonly visualEffectState: undefined;
}

export function slidesWindowChrome(): SlidesWindowChrome {
  return {
    titleBarStyle: 'default',
    titleBarOverlay: false,
    trafficLightPosition: undefined,
    transparent: false,
    vibrancy: undefined,
    visualEffectState: undefined,
  };
}

function containToDeckOrigin(window: SlidesDeckWindow, port: number): void {
  const deckOrigin = `http://localhost:${port}`;
  const refuseOffOrigin = (event: { preventDefault: () => void }, url: string): void => {
    let origin: string | null;
    try {
      origin = new URL(url).origin;
    } catch {
      origin = null;
    }
    if (origin !== deckOrigin) event.preventDefault();
  };
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', refuseOffOrigin);
  window.webContents.on('will-redirect', refuseOffOrigin);
}

export interface CreateSlidesWindowDeps {
  createWindow(opts: { partition: string; title: string }): SlidesDeckWindow;
  registry: Pick<SlidesDeckRegistry, 'register' | 'unregister'>;
  deck: Omit<RunningSlidesDeck, 'window'>;
  waitForRenderer?(window: SlidesDeckWindow): Promise<SlidevRendererOutcome>;
  navigationTimeoutMs?: number;
  rendererTimeoutMs?: number;
  terminateClock?: {
    now(): number;
    sleep(ms: number): Promise<void>;
    graceMs?: number;
    pollMs?: number;
  };
}

export interface WaitForSlidevRendererDeps {
  probe(): Promise<unknown>;
  isProcessAlive(): boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export type SlidevRendererOutcome =
  | { readonly kind: 'rendered' }
  | { readonly kind: 'process-exited' }
  | { readonly kind: 'timed-out'; readonly lastProbeError?: string };

export type SlidesWindowOutcome =
  | { readonly shown: true }
  | {
      readonly shown: false;
      readonly reason: 'cancelled' | 'exited-early' | 'load-failed' | 'renderer-failed';
    };

type TimeoutOutcome<T> =
  | { readonly timedOut: false; readonly value: T }
  | { readonly timedOut: true };

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<TimeoutOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TimeoutOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  try {
    return await Promise.race([
      work.then((value): TimeoutOutcome<T> => ({ timedOut: false, value })),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function waitForSlidevRenderer(
  deps: WaitForSlidevRendererDeps,
): Promise<SlidevRendererOutcome> {
  const deadline = deps.now() + (deps.timeoutMs ?? RENDERER_TIMEOUT_MS);
  const pollIntervalMs = deps.pollIntervalMs ?? RENDERER_POLL_INTERVAL_MS;
  let stopped = false;
  let lastProbeError: string | undefined;

  const poll = async (): Promise<SlidevRendererOutcome> => {
    while (!stopped && deps.isProcessAlive()) {
      try {
        if ((await deps.probe()) === true) return { kind: 'rendered' };
      } catch (err: unknown) {
        lastProbeError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      }
      if (!deps.isProcessAlive()) return { kind: 'process-exited' };
      if (deps.now() >= deadline) return { kind: 'timed-out', lastProbeError };
      await deps.sleep(pollIntervalMs);
    }
    return deps.isProcessAlive()
      ? { kind: 'timed-out', lastProbeError }
      : { kind: 'process-exited' };
  };

  const bounded = await withTimeout(poll(), deps.timeoutMs ?? RENDERER_TIMEOUT_MS);
  stopped = true;
  if (!bounded.timedOut) return bounded.value;
  return deps.isProcessAlive() ? { kind: 'timed-out', lastProbeError } : { kind: 'process-exited' };
}

export async function createSlidesWindow(
  deps: CreateSlidesWindowDeps,
): Promise<SlidesWindowOutcome> {
  const { deck } = deps;
  const window = deps.createWindow({ partition: SLIDES_PARTITION, title: SLIDES_WINDOW_TITLE });
  containToDeckOrigin(window, deck.port);

  const clock = deps.terminateClock;
  let closed = false;
  let termination: Promise<void> | undefined;

  const gracefullyTerminateDeck = (): Promise<void> => {
    if (termination !== undefined) return termination;
    deps.registry.unregister(deck.docPath);
    const pending = gracefulTerminate({
      sendSignal: (sig) => deck.process.signal(sig),
      isAlive: () => deck.process.isAlive(),
      now: clock?.now ?? Date.now,
      sleep: clock?.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))),
      graceMs: clock?.graceMs,
      pollMs: clock?.pollMs,
    })
      .then(() => undefined)
      .catch((err: unknown) => {
        console.warn(
          JSON.stringify({
            event: 'slides-terminate-failed',
            port: deck.port,
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      });
    termination = pending;
    return pending;
  };

  const rejectWindow = (): void => {
    deps.registry.unregister(deck.docPath);
    if (termination === undefined) {
      if (deck.process.isAlive()) void deck.process.signal('SIGKILL');
      termination = Promise.resolve();
    }
    if (closed) return;
    if (window.destroy !== undefined) window.destroy();
    else window.close?.();
  };

  window.on('closed', () => {
    closed = true;
    void gracefullyTerminateDeck();
  });

  let navigation: TimeoutOutcome<void>;
  try {
    navigation = await withTimeout(
      window.loadURL(slidesEmbedUrl(deck.port)),
      deps.navigationTimeoutMs ?? NAVIGATION_TIMEOUT_MS,
    );
  } catch (err: unknown) {
    console.warn(
      JSON.stringify({
        event: 'slides-load-failed',
        windowId: window.id,
        port: deck.port,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    rejectWindow();
    return { shown: false, reason: 'load-failed' };
  }

  if (navigation.timedOut) {
    console.warn(
      JSON.stringify({
        event: 'slides-load-timed-out',
        windowId: window.id,
        port: deck.port,
      }),
    );
    rejectWindow();
    return { shown: false, reason: 'load-failed' };
  }

  if (closed) {
    await gracefullyTerminateDeck();
    return { shown: false, reason: 'cancelled' };
  }

  let renderer: SlidevRendererOutcome;
  try {
    renderer = await (deps.waitForRenderer?.(window) ??
      waitForSlidevRenderer({
        probe: () => window.webContents.executeJavaScript(SLIDEV_RENDERED_CHECK),
        isProcessAlive: () => deck.process.isAlive(),
        now: Date.now,
        sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
        timeoutMs: deps.rendererTimeoutMs,
      }));
  } catch (err: unknown) {
    console.warn(
      JSON.stringify({
        event: 'slides-renderer-probe-failed',
        windowId: window.id,
        port: deck.port,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    rejectWindow();
    return { shown: false, reason: 'renderer-failed' };
  }

  if (closed) {
    await gracefullyTerminateDeck();
    return { shown: false, reason: 'cancelled' };
  }

  if (renderer.kind !== 'rendered') {
    console.warn(
      JSON.stringify({
        event:
          renderer.kind === 'process-exited'
            ? 'slides-renderer-exited'
            : 'slides-renderer-timed-out',
        windowId: window.id,
        port: deck.port,
        ...(renderer.kind === 'timed-out' && renderer.lastProbeError !== undefined
          ? { probeError: renderer.lastProbeError }
          : {}),
      }),
    );
    rejectWindow();
    return {
      shown: false,
      reason: renderer.kind === 'process-exited' ? 'exited-early' : 'renderer-failed',
    };
  }

  try {
    deps.registry.register({ ...deck, window });
    window.show?.();
    return { shown: true };
  } catch (err: unknown) {
    console.warn(
      JSON.stringify({
        event: 'slides-show-failed',
        windowId: window.id,
        port: deck.port,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    rejectWindow();
    return { shown: false, reason: 'renderer-failed' };
  }
}
