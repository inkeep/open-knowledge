import { gracefulTerminate } from './graceful-terminate.ts';
import type { RunningSlidesDeck, SlidesDeckRegistry, SlidesDeckWindow } from './slides-registry.ts';

function slidesEmbedUrl(port: number): string {
  return `http://localhost:${port}/?embedded=true`;
}

const SLIDES_PARTITION = 'slides';

const SLIDES_WINDOW_TITLE = 'Slidev — OpenKnowledge';

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
  terminateClock?: {
    now(): number;
    sleep(ms: number): Promise<void>;
    graceMs?: number;
    pollMs?: number;
  };
}

export function createSlidesWindow(deps: CreateSlidesWindowDeps): SlidesDeckWindow {
  const { deck } = deps;
  const window = deps.createWindow({ partition: SLIDES_PARTITION, title: SLIDES_WINDOW_TITLE });
  containToDeckOrigin(window, deck.port);
  deps.registry.register({ ...deck, window });

  window.once('ready-to-show', () => window.show?.());

  const clock = deps.terminateClock;
  window.on('closed', () => {
    deps.registry.unregister(deck.docPath);
    void gracefulTerminate({
      sendSignal: (sig) => deck.process.signal(sig),
      isAlive: () => deck.process.isAlive(),
      now: clock?.now ?? Date.now,
      sleep: clock?.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))),
      graceMs: clock?.graceMs,
      pollMs: clock?.pollMs,
    }).catch((err: unknown) => {
      console.warn(
        JSON.stringify({
          event: 'slides-terminate-failed',
          port: deck.port,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    });
  });

  window.loadURL(slidesEmbedUrl(deck.port)).catch((err: unknown) => {
    console.warn(
      JSON.stringify({
        event: 'slides-load-failed',
        windowId: window.id,
        port: deck.port,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    window.close?.();
  });

  return window;
}
