import { describe, expect, test, vi } from 'vitest';
import {
  createSlidesDeckRegistry,
  type RunningSlidesDeck,
  type SlidesDeckWindow,
} from './slides-registry.ts';
import { createSlidesWindow, slidesWindowChrome } from './slides-window.ts';

describe('slidesWindowChrome', () => {
  test('gives the deck an ordinary native title bar to drag by', () => {
    const chrome = slidesWindowChrome();
    expect(chrome.titleBarStyle).toBe('default');
    expect(chrome.titleBarOverlay).toBe(false);
  });

  test('clears the macOS chrome the shared defaults set for OK-rendered windows', () => {
    const chrome = slidesWindowChrome();
    expect(chrome.transparent).toBe(false);
    expect(chrome.trafficLightPosition).toBeUndefined();
    expect(chrome.vibrancy).toBeUndefined();
    expect(chrome.visualEffectState).toBeUndefined();
    expect(Object.keys(chrome).sort()).toEqual([
      'titleBarOverlay',
      'titleBarStyle',
      'trafficLightPosition',
      'transparent',
      'vibrancy',
      'visualEffectState',
    ]);
  });
});

function makeFakeWindow(id: number) {
  const closedHandlers: Array<() => void> = [];
  const readyHandlers: Array<() => void> = [];
  let windowOpenHandler: ((details: { url: string }) => { action: 'allow' | 'deny' }) | undefined;
  let willNavigateHandler:
    | ((event: { preventDefault: () => void }, url: string) => void)
    | undefined;
  let willRedirectHandler:
    | ((event: { preventDefault: () => void }, url: string) => void)
    | undefined;
  const show = vi.fn(() => {});
  const close = vi.fn(() => {
    for (const cb of closedHandlers) cb();
  });
  const window = {
    id,
    show,
    close,
    once: (event: string, cb: () => void) => {
      if (event === 'ready-to-show') readyHandlers.push(cb);
    },
    on: (event: string, cb: () => void) => {
      if (event === 'closed') closedHandlers.push(cb);
    },
    webContents: {
      setWindowOpenHandler: (
        handler: (details: { url: string }) => { action: 'allow' | 'deny' },
      ) => {
        windowOpenHandler = handler;
      },
      on: (
        event: string,
        handler: (event: { preventDefault: () => void }, url: string) => void,
      ) => {
        if (event === 'will-navigate') willNavigateHandler = handler;
        if (event === 'will-redirect') willRedirectHandler = handler;
      },
    },
    loadFile: vi.fn(async () => {}),
    loadURL: vi.fn(async () => {}),
  } as unknown as SlidesDeckWindow;
  return {
    window,
    show,
    close,
    fireReadyToShow: () => {
      for (const cb of readyHandlers) cb();
    },
    fireClosed: () => {
      for (const cb of closedHandlers) cb();
    },
    requestNewWindow: (url: string) => windowOpenHandler?.({ url }),
    navigateTo: (url: string) => {
      let prevented = false;
      willNavigateHandler?.({ preventDefault: () => (prevented = true) }, url);
      return prevented;
    },
    redirectTo: (url: string) => {
      let prevented = false;
      willRedirectHandler?.({ preventDefault: () => (prevented = true) }, url);
      return prevented;
    },
  };
}

function fakeProcess(opts: { alive?: boolean } = {}) {
  const signals: Array<'SIGTERM' | 'SIGKILL'> = [];
  return {
    process: {
      onExit: () => {},
      signal: (sig: 'SIGTERM' | 'SIGKILL') => {
        signals.push(sig);
      },
      isAlive: () => opts.alive ?? false,
      pid: 4321,
    },
    signals: () => signals,
  };
}

function makeDeck(
  docPath: string,
  port: number,
  opts: { alive?: boolean } = {},
): Omit<RunningSlidesDeck, 'window'> & {
  signals: () => Array<'SIGTERM' | 'SIGKILL'>;
} {
  const { process, signals } = fakeProcess(opts);
  return { docPath, port, process, signals };
}

function virtualTerminateClock() {
  let clock = 0;
  return {
    now: () => clock,
    sleep: (ms: number) => {
      clock += ms;
      return Promise.resolve();
    },
    graceMs: 1,
    pollMs: 1,
  };
}

async function flushTeardown() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('createSlidesWindow', () => {
  test('loads the embedded loopback URL — never OK content over file://', () => {
    const fake = makeFakeWindow(80_001);
    const registry = createSlidesDeckRegistry();
    createSlidesWindow({
      createWindow: () => fake.window,
      registry,
      deck: makeDeck('/decks/talk.md', 4300),
    });

    expect(fake.window.loadURL).toHaveBeenCalledWith('http://localhost:4300/?embedded=true');
    expect(fake.window.loadFile).not.toHaveBeenCalled();
  });

  test('denies every new-window request the deck makes — no window.open to any origin', () => {
    const fake = makeFakeWindow(80_001);
    createSlidesWindow({
      createWindow: () => fake.window,
      registry: createSlidesDeckRegistry(),
      deck: makeDeck('/decks/talk.md', 4300),
    });

    expect(fake.requestNewWindow('https://evil.example/phish')).toEqual({ action: 'deny' });
    expect(fake.requestNewWindow('http://localhost:4300/presenter')).toEqual({ action: 'deny' });
  });

  test('blocks a top-level navigation off the deck origin but allows in-deck routing', () => {
    const fake = makeFakeWindow(80_001);
    createSlidesWindow({
      createWindow: () => fake.window,
      registry: createSlidesDeckRegistry(),
      deck: makeDeck('/decks/talk.md', 4300),
    });

    expect(fake.navigateTo('https://evil.example/phish')).toBe(true);
    expect(fake.navigateTo('http://localhost:4300/presenter')).toBe(false);
    expect(fake.navigateTo('not a url')).toBe(true);
  });

  test('refuses a cross-origin redirect that a same-origin navigation lands on', () => {
    const fake = makeFakeWindow(80_001);
    createSlidesWindow({
      createWindow: () => fake.window,
      registry: createSlidesDeckRegistry(),
      deck: makeDeck('/decks/talk.md', 4300),
    });

    expect(fake.redirectTo('https://evil.example/phish')).toBe(true);
    expect(fake.redirectTo('http://localhost:4300/1')).toBe(false);
  });

  test('creates the window on an isolated, non-persistent session partition', () => {
    const fake = makeFakeWindow(80_001);
    const createWindow = vi.fn((_o: { partition: string; title: string }) => fake.window);
    createSlidesWindow({
      createWindow,
      registry: createSlidesDeckRegistry(),
      deck: makeDeck('/decks/talk.md', 4300),
    });

    const opts = createWindow.mock.calls[0]?.[0];
    expect(opts?.partition).toBeTruthy();
    expect(opts?.partition.startsWith('persist:')).toBe(false);
  });

  test('records the deck (with its window) in the registry', () => {
    const fake = makeFakeWindow(80_001);
    const registry = createSlidesDeckRegistry();
    const deck = makeDeck('/decks/talk.md', 4300);
    createSlidesWindow({ createWindow: () => fake.window, registry, deck });

    const entry = registry.get('/decks/talk.md');
    expect(entry?.port).toBe(4300);
    expect(entry?.process).toBe(deck.process);
    expect(entry?.window).toBe(fake.window);
  });

  test('shows the window on first paint', () => {
    const fake = makeFakeWindow(80_001);
    createSlidesWindow({
      createWindow: () => fake.window,
      registry: createSlidesDeckRegistry(),
      deck: makeDeck('/decks/talk.md', 4300),
    });

    expect(fake.show).not.toHaveBeenCalled();
    fake.fireReadyToShow();
    expect(fake.show).toHaveBeenCalledTimes(1);
  });

  test('closing the window gracefully stops the deck: SIGTERM, then SIGKILL when it stays alive', async () => {
    const fake = makeFakeWindow(80_001);
    const registry = createSlidesDeckRegistry();
    const deck = makeDeck('/decks/talk.md', 4300, { alive: true });
    createSlidesWindow({
      createWindow: () => fake.window,
      registry,
      deck,
      terminateClock: virtualTerminateClock(),
    });
    expect(registry.get('/decks/talk.md')).not.toBeUndefined();

    fake.fireClosed();
    await flushTeardown();

    expect(deck.signals()).toEqual(['SIGTERM', 'SIGKILL']);
    expect(registry.get('/decks/talk.md')).toBeUndefined();
    expect(registry.size()).toBe(0);
  });

  test('closing the window stops the deck with SIGTERM alone when it exits during grace', async () => {
    const fake = makeFakeWindow(80_001);
    const registry = createSlidesDeckRegistry();
    const deck = makeDeck('/decks/talk.md', 4300);
    createSlidesWindow({
      createWindow: () => fake.window,
      registry,
      deck,
      terminateClock: virtualTerminateClock(),
    });

    fake.fireClosed();
    await flushTeardown();

    expect(deck.signals()).toEqual(['SIGTERM']);
    expect(registry.get('/decks/talk.md')).toBeUndefined();
  });

  test('two decks open independent windows on their own ports', () => {
    const registry = createSlidesDeckRegistry();
    const a = makeFakeWindow(80_001);
    const b = makeFakeWindow(80_002);
    createSlidesWindow({
      createWindow: () => a.window,
      registry,
      deck: makeDeck('/decks/a.md', 4300),
    });
    createSlidesWindow({
      createWindow: () => b.window,
      registry,
      deck: makeDeck('/decks/b.md', 4301),
    });

    expect(a.window.loadURL).toHaveBeenCalledWith('http://localhost:4300/?embedded=true');
    expect(b.window.loadURL).toHaveBeenCalledWith('http://localhost:4301/?embedded=true');
    expect(registry.size()).toBe(2);
    expect(registry.get('/decks/a.md')?.window).toBe(a.window);
    expect(registry.get('/decks/b.md')?.window).toBe(b.window);
  });

  test('a renderer load rejection warns, closes the broken window, and drops the deck', async () => {
    const fake = makeFakeWindow(80_001);
    const failing = vi.fn(async () => {
      throw new Error('slidev boom');
    });
    (fake.window as unknown as { loadURL: typeof failing }).loadURL = failing;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = createSlidesDeckRegistry();

    createSlidesWindow({
      createWindow: () => fake.window,
      registry,
      deck: makeDeck('/decks/talk.md', 4300),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(warnSpy.mock.calls[0]?.[0] as string);
    expect(payload).toMatchObject({
      event: 'slides-load-failed',
      windowId: 80_001,
      port: 4300,
      message: 'slidev boom',
    });
    expect(JSON.stringify(payload)).not.toContain('/decks/talk.md');
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(registry.get('/decks/talk.md')).toBeUndefined();

    warnSpy.mockRestore();
  });
});
