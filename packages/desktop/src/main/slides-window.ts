/**
 * Dedicated OK window showing a deck via its spawned Slidev server.
 *
 * Unlike editor/terminal/navigator windows — which all load OK's own renderer —
 * a slides window points at the out-of-process Slidev server on loopback and
 * loads nothing of OK's over `file://`. Two consequences shape this factory:
 *   - It self-shows on `ready-to-show` rather than routing through the
 *     dual-signal show gate, which also waits for the renderer's
 *     `ok:theme:applied` — an IPC a Slidev page never sends.
 *   - It runs in an isolated, non-persistent session partition with no OK
 *     preload/bridge injected (wired in `main/index.ts`), so the deck renderer
 *     shares no session with the editor and the deck-XSS surface stays
 *     out-of-process, sandboxed, and loopback-only.
 *
 * The window is paired with its server in the deck registry, so re-selecting
 * Slides for an open deck focuses this window instead of spawning again, and
 * closing it reaps the server. The window factory is injected so this unit-tests
 * without an Electron runtime; `main/index.ts` wires the real BrowserWindow.
 */

import { gracefulTerminate } from './graceful-terminate.ts';
import type { RunningSlidesDeck, SlidesDeckRegistry, SlidesDeckWindow } from './slides-registry.ts';

/** Loopback embedded URL for a Slidev server on `port`. Served at the root with
 *  no `--base` (sidestepping the open upstream `--base` embed regressions), so
 *  no path prefix; `?embedded=true` is Slidev's client-side embed flag.
 *
 *  The host is `localhost`, not a pinned `127.0.0.1`: Slidev inherits Vite's
 *  `localhost` bind, which resolves verbatim to `::1` first on macOS, so a real
 *  deck listens on the IPv6 loopback only and an IPv4-pinned URL loads a blank
 *  window. `localhost` lets Chromium fall back across families and still names
 *  only loopback. Keep in sync with `probeSlidevReady`'s host — readiness must
 *  confirm the same origin the window then loads. */
function slidesEmbedUrl(port: number): string {
  return `http://localhost:${port}/?embedded=true`;
}

/** Session partition for slide windows. Non-persistent (no `persist:` prefix),
 *  so it is an in-memory session distinct from the editor's default one. */
const SLIDES_PARTITION = 'slides';

/** Names the renderer AND the app that owns the window. The app half is not
 *  decoration: this title is fixed and deck content cannot change it, so it is
 *  what tells a user a deck window belongs to OpenKnowledge (see the
 *  containment rationale below). */
const SLIDES_WINDOW_TITLE = 'Slidev — OpenKnowledge';

/**
 * Chrome the deck window needs on top of the shared window defaults.
 *
 * Every other OK window loads OK's own renderer, which draws its own title bar
 * and marks the drag strip with `-webkit-app-region: drag`. The shared defaults
 * therefore hide the native title bar on every platform (`hiddenInset` on
 * macOS, `hidden` + a controls overlay elsewhere) and hand that strip to the
 * renderer. A deck window loads the Slidev server's page instead, which has
 * none of that — inheriting the hidden title bar leaves the window with **no
 * draggable region at all**, so it cannot be moved. macOS compounds it by
 * offsetting the traffic lights into the page content and enabling
 * transparency + vibrancy that a foreign page never paints for.
 *
 * A deck is a foreign page, so it gets an ordinary native window: a real title
 * bar (the drag handle, showing the pinned title), default traffic-light
 * placement, and no transparency. Structurally typed rather than importing
 * Electron's option type, keeping this module Electron-free so it unit-tests
 * without a runtime. Spread AFTER the shared defaults.
 */
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

/**
 * Contain the deck window to its own loopback origin. A deck is untrusted
 * content: it renders project markdown, whose raw HTML passes through OK's
 * storage layer unsanitized, and Slidev renders it. Without this a crafted deck
 * could navigate this fixed-title native window to an attacker origin (a clean
 * phishing surface, since the title keeps naming OpenKnowledge) or spawn
 * windows at arbitrary origins. Deny every new-window request and refuse any
 * top-level navigation that leaves the deck's own `http://localhost:<port>` —
 * same-origin navigation (Slidev's in-app routing to /presenter, /overview, …)
 * is left alone, and normal client-side slide navigation never fires
 * `will-navigate` at all. `will-redirect` gets the same refusal: a top-level
 * navigation that STARTS same-origin but a server answers with a cross-origin
 * redirect would otherwise slip past the `will-navigate` check, which only sees
 * the pre-redirect URL. The same deny-by-default posture every other OK window
 * installs (the editor's asset safety net, the uninstall window).
 *
 * Cross-origin SUBFRAMES are deliberately left to the browser's same-origin
 * policy rather than blocked via `will-frame-navigate`: a deck legitimately
 * embeds cross-origin iframes (Slidev's `<Youtube>` and iframe embeds), and
 * blocking them would render decks differently here than under plain Slidev
 * while adding little — a subframe is SOP-sandboxed and cannot navigate the
 * top-level window, which is the phishing surface this guard exists to close.
 */
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
  /** Create the BrowserWindow (with `show: false`). Production wires a window on
   *  the isolated slides session `partition` with no OK preload; the show comes
   *  from `ready-to-show` below. */
  createWindow(opts: { partition: string; title: string }): SlidesDeckWindow;
  /** App-wide deck registry — the factory records the deck and drops it on close. */
  registry: Pick<SlidesDeckRegistry, 'register' | 'unregister'>;
  /** The started deck to show: its confirmed port + the server to reap on close. */
  deck: Omit<RunningSlidesDeck, 'window'>;
  /**
   * Injection seam for the close-time graceful-teardown clock, so the
   * SIGTERM → grace → SIGKILL ladder is unit-testable on a virtual clock with no
   * real timer wait. Production omits it → real `Date.now` + `setTimeout` + the
   * shared default grace.
   */
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
  // Install the navigation guards before the load below so the deck can never
  // navigate this window off its own loopback origin.
  containToDeckOrigin(window, deck.port);
  deps.registry.register({ ...deck, window });

  window.once('ready-to-show', () => window.show?.());

  // Closing the window tears its deck down: drop the registry entry so a reopen
  // starts fresh, then gracefully stop the Slidev process — SIGTERM, a grace
  // window, then SIGKILL only if it is still alive — so its Vite dev server
  // releases its port and flushes its cache rather than being force-killed
  // outright. Fire-and-forget: the window is already gone and there is nothing
  // to await it against. Idempotent after app-quit reapAll cleared the map (a
  // signal to an already-exited group is a no-op; unregister is a no-op delete).
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
      // Fire-and-forget is intended, but silent is not: this ladder is the only
      // thing standing between a closed window and an orphaned Vite server, so a
      // rejection here is the one signal that it did not run.
      console.warn(
        JSON.stringify({
          event: 'slides-terminate-failed',
          // The port is what a "Slidev is still holding port X" report arrives
          // with, so it is the field that makes this breadcrumb correlatable.
          // Bounded cardinality, unlike the deck path, which stays out.
          port: deck.port,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    });
  });

  // Trust boundary: loadURL drives Chromium (separate release cadence,
  // imperative shell) and rejects on a load failure. Surface it as a grep-able
  // structured warn — matching the sibling window factories — rather than an
  // unhandled rejection. docPath is deliberately not logged
  // (cardinality/security); the ephemeral port is a bounded int.
  window.loadURL(slidesEmbedUrl(deck.port)).catch((err: unknown) => {
    console.warn(
      JSON.stringify({
        event: 'slides-load-failed',
        windowId: window.id,
        port: deck.port,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    // Readiness already confirmed the server before this load, so a rejection
    // here is the narrow race where the server died between the probe and the
    // load. The window would otherwise sit on a permanent Chromium error page it
    // can never recover from (the server is gone), so close it rather than leave
    // a broken, fixed-title window onscreen. The `closed` handler drops the
    // registry entry and reaps the (already-dead) process.
    window.close?.();
  });

  return window;
}
