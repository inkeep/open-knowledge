/**
 * Registry of the Slidev decks OK has open, keyed by the deck's absolute path.
 *
 * Deck path is the identity because re-selecting Slides for a deck already open
 * must focus its existing window rather than spawn a second server + window —
 * one deck, one server, one window. Each entry pairs the spawned server with the
 * OK window showing it, so a reopen can raise that window and app quit can reap
 * every server, guaranteeing no Slidev process outlives the app.
 *
 * A plain factory (not a module-level singleton) so tests get a fresh instance
 * with no cross-test state; `main/index.ts` holds the single app-wide instance.
 */

import type { OkSlidesOpenResult } from '../shared/ipc-channels.ts';
import type { SlidevProcess } from './slidev-server.ts';
import type { BrowserWindowLike } from './window-manager.ts';

/** The OK window showing a deck. `id` is carried for structured load-failure
 *  logging (a bounded int); the registry keys on docPath, not id. */
export type SlidesDeckWindow = BrowserWindowLike & { readonly id: number };

export interface RunningSlidesDeck {
  /** Absolute path of the deck being served — the registry key. */
  readonly docPath: string;
  /** Loopback port the Slidev server is serving on. */
  readonly port: number;
  /** The spawned server: `signal()` delivers SIGTERM/SIGKILL to it and its child
   *  tree, `isAlive()` reports whether it is still running. */
  readonly process: SlidevProcess;
  /** The dedicated OK window showing the deck — raised on reopen, reaped
   *  alongside its process when closed. */
  readonly window: SlidesDeckWindow;
}

export interface SlidesDeckRegistry {
  /** The running deck for `docPath`, or undefined if none is open for it. */
  get(docPath: string): RunningSlidesDeck | undefined;
  /** Record a newly-opened deck. */
  register(deck: RunningSlidesDeck): void;
  /** Drop a deck's entry without reaping it — the window's close handler owns
   *  the reap, and calls this so a subsequent reopen starts fresh. */
  unregister(docPath: string): void;
  /** Signal every registered server to stop and empty the registry (app-quit
   *  teardown — best-effort SIGTERM, since quit cannot await a grace poll). */
  reapAll(): void;
  /** How many decks are currently registered. */
  size(): number;
  /** The in-flight open for `docPath`, if one is already running.
   *
   *  A deck only enters `decks` once its server is confirmed serving, and a
   *  cold Slidev start takes seconds — so registry lookup alone cannot dedup
   *  two activations issued inside that window (a double-click on the toolbar
   *  action). Without this, both see an empty registry, both spawn, and the
   *  user gets two servers and two windows for one deck while the registry —
   *  what app-quit `reapAll` iterates — records only the last. Callers join the
   *  returned promise instead of starting a second attempt, so they share the
   *  first attempt's real verdict rather than assuming it succeeds. */
  getOpenInFlight(docPath: string): Promise<OkSlidesOpenResult> | undefined;
  /** Record the in-flight open for `docPath`. */
  setOpenInFlight(docPath: string, attempt: Promise<OkSlidesOpenResult>): void;
  /** Drop the in-flight marker once the attempt settles (success or failure). */
  clearOpenInFlight(docPath: string): void;
  /** Record a child that has been spawned but is not yet a registered deck.
   *
   *  `setOpenInFlight` stores a promise, which carries no killable handle, so
   *  it cannot serve app-quit teardown. This does: `reapAll` signals these
   *  alongside `decks`, closing the window between spawn and confirmed-serving
   *  in which a quit would otherwise leave a `detached` process holding its
   *  port with nothing left referencing it. */
  trackSpawned(docPath: string, process: SlidevProcess): void;
  /** Drop a spawned-but-unregistered child once it is registered or reaped. */
  untrackSpawned(docPath: string): void;
}

export function createSlidesDeckRegistry(): SlidesDeckRegistry {
  const decks = new Map<string, RunningSlidesDeck>();
  const opening = new Map<string, Promise<OkSlidesOpenResult>>();
  const spawned = new Map<string, SlidevProcess>();
  return {
    get: (docPath) => decks.get(docPath),
    register: (deck) => {
      decks.set(deck.docPath, deck);
    },
    unregister: (docPath) => {
      decks.delete(docPath);
    },
    reapAll: () => {
      // App quit cannot hold itself open for the per-deck grace poll the
      // window-close path runs, so this only asks each server to stop: a SIGTERM
      // (to the whole group) lets its Vite dev server release its port and flush
      // its cache, and a detached server that outlives our exit finishes
      // shutting down on its own. Mirrors the desktop's synchronous
      // `signalStopAllOwnedServers` server teardown.
      for (const deck of decks.values()) deck.process.signal('SIGTERM');
      // Children spawned but not yet confirmed serving are NOT in `decks`, and
      // `opening` holds only promises. Signal them here or they outlive the app.
      for (const proc of spawned.values()) proc.signal('SIGTERM');
      decks.clear();
      spawned.clear();
      opening.clear();
    },
    size: () => decks.size,
    getOpenInFlight: (docPath) => opening.get(docPath),
    setOpenInFlight: (docPath, attempt) => {
      opening.set(docPath, attempt);
    },
    clearOpenInFlight: (docPath) => {
      opening.delete(docPath);
    },
    trackSpawned: (docPath, process) => {
      spawned.set(docPath, process);
    },
    untrackSpawned: (docPath) => {
      spawned.delete(docPath);
    },
  };
}
