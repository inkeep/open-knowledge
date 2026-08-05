import { describe, expect, it } from 'vitest';
import type { OkSlidesOpenResult } from '../shared/ipc-channels.ts';
import {
  createSlidesDeckRegistry,
  type RunningSlidesDeck,
  type SlidesDeckWindow,
} from './slides-registry.ts';

/** A stand-in for the deck's window — the registry only stores it, so an id
 *  plus a structural cast is enough. */
function fakeWindow(id: number): SlidesDeckWindow {
  return { id } as unknown as SlidesDeckWindow;
}

/** A deck whose process records the signals it was sent. */
function fakeDeck(docPath: string, port: number) {
  const signals: Array<'SIGTERM' | 'SIGKILL'> = [];
  const deck: RunningSlidesDeck = {
    docPath,
    port,
    process: {
      onExit: () => {},
      signal: (sig) => {
        signals.push(sig);
      },
      isAlive: () => true,
      pid: undefined,
    },
    window: fakeWindow(port),
  };
  return { deck, signals: () => signals };
}

describe('createSlidesDeckRegistry', () => {
  it('returns a registered server by its deck path', () => {
    const registry = createSlidesDeckRegistry();
    const { deck } = fakeDeck('/decks/a.md', 3001);
    registry.register(deck);
    expect(registry.get('/decks/a.md')).toBe(deck);
    expect(registry.get('/decks/other.md')).toBeUndefined();
  });

  it('signals every server to stop with SIGTERM and empties on reapAll', () => {
    const registry = createSlidesDeckRegistry();
    const a = fakeDeck('/decks/a.md', 3001);
    const b = fakeDeck('/decks/b.md', 3002);
    registry.register(a.deck);
    registry.register(b.deck);
    expect(registry.size()).toBe(2);

    registry.reapAll();

    // App-quit teardown asks each server to stop cleanly (SIGTERM), never a
    // straight SIGKILL that would deny its Vite server a port release + flush.
    expect(a.signals()).toEqual(['SIGTERM']);
    expect(b.signals()).toEqual(['SIGTERM']);
    expect(registry.size()).toBe(0);
    expect(registry.get('/decks/a.md')).toBeUndefined();
  });

  it('unregister drops one entry without reaping its process', () => {
    const registry = createSlidesDeckRegistry();
    const a = fakeDeck('/decks/a.md', 3001);
    const b = fakeDeck('/decks/b.md', 3002);
    registry.register(a.deck);
    registry.register(b.deck);

    // The window's own close handler already reaped the process; unregister only
    // removes the bookkeeping so a reopen starts fresh — it must not signal again.
    registry.unregister('/decks/a.md');

    expect(a.signals()).toEqual([]);
    expect(registry.get('/decks/a.md')).toBeUndefined();
    expect(registry.get('/decks/b.md')).toBe(b.deck);
    expect(registry.size()).toBe(1);
  });

  it('unregister for an unknown deck is a no-op', () => {
    const registry = createSlidesDeckRegistry();
    registry.register(fakeDeck('/decks/a.md', 3001).deck);
    registry.unregister('/decks/never-opened.md');
    expect(registry.size()).toBe(1);
  });

  it('a fresh registry starts empty', () => {
    expect(createSlidesDeckRegistry().size()).toBe(0);
  });

  it('tracks and clears an in-flight open independently of registered decks', () => {
    const registry = createSlidesDeckRegistry();
    expect(registry.getOpenInFlight('/decks/a.md')).toBeUndefined();

    const attempt: Promise<OkSlidesOpenResult> = Promise.resolve({ kind: 'open', ok: true });
    registry.setOpenInFlight('/decks/a.md', attempt);
    // The marker is the exact promise a joiner awaits, so a second activation
    // shares the first attempt's real verdict instead of spawning a rival.
    expect(registry.getOpenInFlight('/decks/a.md')).toBe(attempt);
    // In-flight tracking is separate from the registered decks (a deck registers
    // only once its server is confirmed serving, seconds after the start begins).
    expect(registry.get('/decks/a.md')).toBeUndefined();

    registry.clearOpenInFlight('/decks/a.md');
    expect(registry.getOpenInFlight('/decks/a.md')).toBeUndefined();
  });

  it('reapAll clears in-flight markers as well as registered decks', () => {
    const registry = createSlidesDeckRegistry();
    const a = fakeDeck('/decks/a.md', 3001);
    registry.register(a.deck);
    const attempt: Promise<OkSlidesOpenResult> = Promise.resolve({ kind: 'open', ok: true });
    registry.setOpenInFlight('/decks/b.md', attempt);

    registry.reapAll();

    // App-quit teardown empties both maps, so nothing survives to be re-entered.
    expect(registry.size()).toBe(0);
    expect(registry.getOpenInFlight('/decks/b.md')).toBeUndefined();
  });
});

describe('reapAll reaches children that are spawned but not yet registered', () => {
  // The leak this guards: `register` only runs once a server is CONFIRMED
  // serving, and a cold Vite start takes seconds. A quit inside that window used
  // to find nothing to signal — `decks` was empty and `opening` held only a
  // promise, which carries no killable handle — so the `detached` child outlived
  // the app holding its port.
  function fakeProc() {
    const signals: string[] = [];
    return {
      signals,
      proc: {
        onExit: () => {},
        signal: (s: 'SIGTERM' | 'SIGKILL') => signals.push(s),
        isAlive: () => true,
        pid: 1234,
      },
    };
  }

  it('SIGTERMs a spawned-but-unregistered child', () => {
    const registry = createSlidesDeckRegistry();
    const { signals, proc } = fakeProc();
    registry.trackSpawned('/proj/deck.md', proc);
    // Never registered — this is the mid-boot state.
    expect(registry.size()).toBe(0);

    registry.reapAll();

    expect(signals).toEqual(['SIGTERM']);
  });

  it('does not double-signal once the child has been handed to decks', () => {
    const registry = createSlidesDeckRegistry();
    const { signals, proc } = fakeProc();
    registry.trackSpawned('/proj/deck.md', proc);
    // Ownership transfers to `decks` when the window opens.
    registry.register({
      docPath: '/proj/deck.md',
      port: 4300,
      process: proc,
      window: { on: () => {}, focus: () => {}, isDestroyed: () => false } as never,
    });
    registry.untrackSpawned('/proj/deck.md');

    registry.reapAll();

    expect(signals).toEqual(['SIGTERM']);
  });
});
