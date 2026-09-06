import { describe, expect, it } from 'vitest';
import type { OkSlidesOpenResult } from '../shared/ipc-channels.ts';
import {
  createSlidesDeckRegistry,
  type RunningSlidesDeck,
  type SlidesDeckWindow,
} from './slides-registry.ts';

function fakeWindow(id: number): SlidesDeckWindow {
  return { id } as unknown as SlidesDeckWindow;
}

function fakeDeck(docPath: string, port: number) {
  const signals: Array<'SIGTERM' | 'SIGKILL'> = [];
  const deck: RunningSlidesDeck = {
    docPath,
    port,
    process: {
      onExit: () => {},
      signal: (sig) => {
        signals.push(sig);
        return Promise.resolve();
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

  it('force-stops every server and empties on reapAll', () => {
    const registry = createSlidesDeckRegistry();
    const a = fakeDeck('/decks/a.md', 3001);
    const b = fakeDeck('/decks/b.md', 3002);
    registry.register(a.deck);
    registry.register(b.deck);
    expect(registry.size()).toBe(2);

    registry.reapAll();

    expect(a.signals()).toEqual(['SIGKILL']);
    expect(b.signals()).toEqual(['SIGKILL']);
    expect(registry.size()).toBe(0);
    expect(registry.get('/decks/a.md')).toBeUndefined();
  });

  it('unregister drops one entry without reaping its process', () => {
    const registry = createSlidesDeckRegistry();
    const a = fakeDeck('/decks/a.md', 3001);
    const b = fakeDeck('/decks/b.md', 3002);
    registry.register(a.deck);
    registry.register(b.deck);

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
    expect(registry.getOpenInFlight('/decks/a.md')).toBe(attempt);
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

    expect(registry.size()).toBe(0);
    expect(registry.getOpenInFlight('/decks/b.md')).toBeUndefined();
  });

  it('clears immediately but waits for every process signal', async () => {
    const registry = createSlidesDeckRegistry();
    let release: (() => void) | undefined;
    const pendingSignal = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deck } = fakeDeck('/decks/a.md', 3001);
    deck.process.signal = () => pendingSignal;
    registry.register(deck);
    let settled = false;

    const drain = registry.reapAll().then(() => {
      settled = true;
    });
    expect(registry.size()).toBe(0);
    await Promise.resolve();
    expect(settled).toBe(false);

    release?.();
    await drain;
    expect(settled).toBe(true);
  });
});

describe('reapAll reaches children that are spawned but not yet registered', () => {
  function fakeProc() {
    const signals: string[] = [];
    const exitHandlers: Array<(code: number | null) => void> = [];
    let alive = true;
    return {
      signals,
      proc: {
        onExit: (handler: (code: number | null) => void) => exitHandlers.push(handler),
        signal: (s: 'SIGTERM' | 'SIGKILL') => {
          signals.push(s);
          return Promise.resolve();
        },
        isAlive: () => alive,
        pid: 1234,
      },
      emitExit: (code: number | null = 0) => {
        alive = false;
        for (const handler of exitHandlers) handler(code);
      },
    };
  }

  it('force-stops a spawned-but-unregistered child', () => {
    const registry = createSlidesDeckRegistry();
    const { signals, proc } = fakeProc();
    registry.trackSpawned('/proj/deck.md', proc);
    expect(registry.size()).toBe(0);

    registry.reapAll();

    expect(signals).toEqual(['SIGKILL']);
  });

  it('retains a handed-off child until exit without double-signalling it', () => {
    const registry = createSlidesDeckRegistry();
    const { signals, proc } = fakeProc();
    registry.trackSpawned('/proj/deck.md', proc);
    registry.register({
      docPath: '/proj/deck.md',
      port: 4300,
      process: proc,
      window: { on: () => {}, focus: () => {}, isDestroyed: () => false } as never,
    });
    registry.unregister('/proj/deck.md');
    registry.reapAll();

    expect(signals).toEqual(['SIGKILL']);
  });

  it('keeps an older failed child when a retry for the same deck is handed off', () => {
    const registry = createSlidesDeckRegistry();
    const failed = fakeProc();
    const opened = fakeProc();
    registry.trackSpawned('/proj/deck.md', failed.proc);
    registry.trackSpawned('/proj/deck.md', opened.proc);
    registry.register({
      docPath: '/proj/deck.md',
      port: 4300,
      process: opened.proc,
      window: { on: () => {}, focus: () => {}, isDestroyed: () => false } as never,
    });
    registry.reapAll();

    expect(failed.signals).toEqual(['SIGKILL']);
    expect(opened.signals).toEqual(['SIGKILL']);
  });

  it('forgets a failed child after the process exits', () => {
    const registry = createSlidesDeckRegistry();
    const failed = fakeProc();
    registry.trackSpawned('/proj/deck.md', failed.proc);

    failed.emitExit(1);
    registry.reapAll();

    expect(failed.signals).toEqual([]);
  });

  it('does not signal a registered process that already exited', () => {
    const registry = createSlidesDeckRegistry();
    const opened = fakeProc();
    registry.register({
      docPath: '/proj/deck.md',
      port: 4300,
      process: opened.proc,
      window: { on: () => {}, focus: () => {}, isDestroyed: () => false } as never,
    });

    opened.emitExit(1);
    registry.reapAll();

    expect(opened.signals).toEqual([]);
  });
});
