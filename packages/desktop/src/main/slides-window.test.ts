import { describe, expect, test, vi } from 'vitest';
import {
  createSlidesDeckRegistry,
  type RunningSlidesDeck,
  type SlidesDeckWindow,
} from './slides-registry.ts';
import { createSlidesWindow, slidesWindowChrome } from './slides-window.ts';

describe('slidesWindowChrome', () => {
  test('gives the deck an ordinary native title bar to drag by', () => {
    // The shared window defaults hide the title bar because OK's renderer draws
    // its own and marks a `-webkit-app-region: drag` strip. Slidev's page marks
    // none, so a deck inheriting those defaults has no draggable region and the
    // window cannot be moved at all.
    const chrome = slidesWindowChrome();
    expect(chrome.titleBarStyle).toBe('default');
    expect(chrome.titleBarOverlay).toBe(false);
  });

  test('clears the macOS chrome the shared defaults set for OK-rendered windows', () => {
    // Spread over DEFAULT_WIN_OPTS, so every key the darwin branch sets must be
    // present here to override it — an absent key would silently inherit.
    const chrome = slidesWindowChrome();
    expect(chrome.transparent).toBe(false);
    expect(chrome.trafficLightPosition).toBeUndefined();
    expect(chrome.vibrancy).toBeUndefined();
    expect(chrome.visualEffectState).toBeUndefined();
    // Every darwin-branch chrome key is accounted for; a new one added to
    // DEFAULT_WIN_OPTS without a matching override here would leak into the
    // deck window.
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

/** A fake window exposing only what the factory touches. The `ready-to-show` and
 *  `closed` handlers are captured so a test can fire the lifecycle events; the
 *  `webContents` captures the navigation guards so a test can drive them. */
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
  // Mirror Electron: close() eventually fires the 'closed' event, which the
  // factory listens on to reap + unregister.
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
    /** Drive the new-window handler the factory registered. */
    requestNewWindow: (url: string) => windowOpenHandler?.({ url }),
    /** Drive the top-level navigation guard; returns whether it was prevented. */
    navigateTo: (url: string) => {
      let prevented = false;
      willNavigateHandler?.({ preventDefault: () => (prevented = true) }, url);
      return prevented;
    },
    /** Drive the redirect guard (a navigation answered by a server redirect);
     *  returns whether it was prevented. */
    redirectTo: (url: string) => {
      let prevented = false;
      willRedirectHandler?.({ preventDefault: () => (prevented = true) }, url);
      return prevented;
    },
  };
}

/** A Slidev server whose signals are observable and whose liveness is scripted:
 *  `alive: true` never exits (forcing SIGKILL escalation), the default reports
 *  gone on the first liveness poll (the clean SIGTERM-only path). */
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

/** A virtual clock for the close-time teardown ladder — `sleep` advances it and
 *  resolves synchronously, so the grace + escalation run in microtasks with no
 *  real timer. Tiny grace/poll keep the loop to a single iteration. */
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

/** Let the fire-and-forget teardown ladder settle its microtask chain. */
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

    // `localhost`, not a pinned `127.0.0.1`: Slidev inherits Vite's `localhost`
    // bind, which Node resolves verbatim to `::1` first on macOS, so a real deck
    // listens on the IPv6 loopback only and an IPv4-pinned URL loads a blank
    // window. Verified against a live Slidev, whose listen socket is
    // `IPv6 [::1]:<port>` with nothing on IPv4.
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

    // A crafted deck's `window.open(...)`, same-origin or not, is denied — the
    // deck can never spawn a native window at an arbitrary origin.
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

    // A crafted deck doing `location = 'https://evil…'` is refused, so the
    // fixed-title window can never be repointed at attacker content (phishing).
    expect(fake.navigateTo('https://evil.example/phish')).toBe(true);
    // Slidev's own in-app routes are same-origin — those stay allowed.
    expect(fake.navigateTo('http://localhost:4300/presenter')).toBe(false);
    // A malformed URL is treated as off-origin and refused.
    expect(fake.navigateTo('not a url')).toBe(true);
  });

  test('refuses a cross-origin redirect that a same-origin navigation lands on', () => {
    const fake = makeFakeWindow(80_001);
    createSlidesWindow({
      createWindow: () => fake.window,
      registry: createSlidesDeckRegistry(),
      deck: makeDeck('/decks/talk.md', 4300),
    });

    // `will-navigate` only sees the pre-redirect URL, so a same-origin start
    // that a server bounces cross-origin would slip past it — `will-redirect`
    // catches the landing origin and refuses it.
    expect(fake.redirectTo('https://evil.example/phish')).toBe(true);
    // A same-origin redirect (Slidev bouncing `/` to a first slide) is allowed.
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
    // A partition string that does not start with `persist:` is an in-memory
    // session Electron keeps distinct from the editor's default one.
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
    const deck = makeDeck('/decks/talk.md', 4300, { alive: true }); // never exits
    createSlidesWindow({
      createWindow: () => fake.window,
      registry,
      deck,
      terminateClock: virtualTerminateClock(),
    });
    expect(registry.get('/decks/talk.md')).not.toBeUndefined();

    fake.fireClosed();
    await flushTeardown();

    // SIGTERM first, SIGKILL only after the grace expired with it still alive —
    // never a straight kill.
    expect(deck.signals()).toEqual(['SIGTERM', 'SIGKILL']);
    // The registry entry drops synchronously on close so a reopen is clean.
    expect(registry.get('/decks/talk.md')).toBeUndefined();
    expect(registry.size()).toBe(0);
  });

  test('closing the window stops the deck with SIGTERM alone when it exits during grace', async () => {
    const fake = makeFakeWindow(80_001);
    const registry = createSlidesDeckRegistry();
    const deck = makeDeck('/decks/talk.md', 4300); // exits on the first liveness poll
    createSlidesWindow({
      createWindow: () => fake.window,
      registry,
      deck,
      terminateClock: virtualTerminateClock(),
    });

    fake.fireClosed();
    await flushTeardown();

    // Gone within the grace window — no escalation to SIGKILL.
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
    // The factory attaches its `.catch` synchronously; flush the microtask queue
    // so the handler has run before asserting — deterministic, no timer wait.
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
    // The deck path must not leak into diagnostics.
    expect(JSON.stringify(payload)).not.toContain('/decks/talk.md');
    // The window doesn't linger on a permanent Chromium error page — it closes,
    // and its `closed` handler drops the registry entry.
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(registry.get('/decks/talk.md')).toBeUndefined();

    warnSpy.mockRestore();
  });
});
