import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OkSlidesOpenResult } from '../../shared/ipc-channels.ts';
import { createSlidesDeckRegistry, type SlidesDeckWindow } from '../slides-registry.ts';
import type { SlidevResolveProbes } from '../slidev-resolve.ts';
import type { SlidevProcess, StartSlidevDeps } from '../slidev-server.ts';
import { handleSlidesOpen, handleSlidesStatus, shouldLogSlidesOpenError } from './slides.ts';

const PROJECT = '/tmp/deck-project';
const LOCAL_BIN = join(PROJECT, 'node_modules', '.bin', 'slidev');

function fakeProbes(state: { executablePaths?: string[]; onLoginPath?: string[] }) {
  const executable = new Set(state.executablePaths ?? []);
  const onPath = new Set(state.onLoginPath ?? []);
  const execQueries: string[] = [];
  const pathQueries: string[] = [];
  const probes: SlidevResolveProbes = {
    isExecutableFile: async (p) => {
      execQueries.push(p);
      return executable.has(p);
    },
    isOnLoginPath: async (bin) => {
      pathQueries.push(bin);
      return onPath.has(bin);
    },
  };
  return { probes, execQueries, pathQueries };
}

describe('handleSlidesStatus', () => {
  it('reports project-local when the project has its own slidev', async () => {
    const { probes, execQueries } = fakeProbes({ executablePaths: [LOCAL_BIN] });
    const result = await handleSlidesStatus(PROJECT, probes);
    expect(result).toEqual({ kind: 'status', available: true, source: 'project-local' });
    expect(execQueries).toContain(LOCAL_BIN);
  });

  it('falls back to a global slidev when the project has none', async () => {
    const { probes } = fakeProbes({ onLoginPath: ['slidev'] });
    const result = await handleSlidesStatus(PROJECT, probes);
    expect(result).toEqual({ kind: 'status', available: true, source: 'global' });
  });

  it('prefers the project-local slidev over a global one', async () => {
    const { probes, pathQueries } = fakeProbes({
      executablePaths: [LOCAL_BIN],
      onLoginPath: ['slidev'],
    });
    const result = await handleSlidesStatus(PROJECT, probes);
    expect(result).toEqual({ kind: 'status', available: true, source: 'project-local' });
    expect(pathQueries).toEqual([]);
  });

  it('reports unavailable when neither a project-local nor a global slidev resolves', async () => {
    const { probes } = fakeProbes({});
    const result = await handleSlidesStatus(PROJECT, probes);
    expect(result).toEqual({ kind: 'status', available: false });
  });

  it('resolves a global slidev for a window with no project, without touching the filesystem', async () => {
    const { probes, execQueries } = fakeProbes({ onLoginPath: ['slidev'] });
    const result = await handleSlidesStatus(undefined, probes);
    expect(result).toEqual({ kind: 'status', available: true, source: 'global' });
    expect(execQueries).toEqual([]);
  });

  it('reports unavailable for a window with no project and no global slidev', async () => {
    const { probes } = fakeProbes({});
    const result = await handleSlidesStatus(undefined, probes);
    expect(result).toEqual({ kind: 'status', available: false });
  });
});

const DECK = '/decks/talk/slides.md';

function fakeSlidevProcess(signals?: Array<'SIGTERM' | 'SIGKILL'>): SlidevProcess {
  return {
    onExit: () => {},
    signal: (signal) => {
      signals?.push(signal);
      return Promise.resolve();
    },
    isAlive: () => true,
    pid: 7,
  };
}

function fakeWindow(id: number): SlidesDeckWindow {
  return { id } as unknown as SlidesDeckWindow;
}

function readyStartDeps(port: number): {
  deps: StartSlidevDeps;
  process: SlidevProcess;
  signals: Array<'SIGTERM' | 'SIGKILL'>;
} {
  const signals: Array<'SIGTERM' | 'SIGKILL'> = [];
  const process = fakeSlidevProcess(signals);
  return {
    process,
    signals,
    deps: {
      findFreePort: () => Promise.resolve(port),
      spawnSlidev: () => process,
      probeReady: () => Promise.resolve({ reachable: true, hasVersionMeta: true }),
      now: () => 0,
      delay: () => Promise.resolve(),
    },
  };
}

function timingOutStartDeps(): { deps: StartSlidevDeps; spawned: () => boolean } {
  let spawned = false;
  let clock = 0;
  return {
    spawned: () => spawned,
    deps: {
      findFreePort: () => Promise.resolve(4100),
      spawnSlidev: () => {
        spawned = true;
        return fakeSlidevProcess();
      },
      probeReady: () => Promise.resolve({ reachable: false }),
      now: () => clock,
      delay: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      timeoutMs: 500,
      pollIntervalMs: 250,
    },
  };
}

describe('handleSlidesOpen', () => {
  it('starts a server and opens the ready deck in a window', async () => {
    const registry = createSlidesDeckRegistry();
    const { deps: startDeps, process } = readyStartDeps(5200);
    const opened: Array<{ docPath: string; port: number; process: SlidevProcess }> = [];
    const result = await handleSlidesOpen(DECK, {
      registry,
      startDeps,
      openWindow: async (deck) => {
        opened.push(deck);
        return { shown: true };
      },
      focusWindow: () => {
        throw new Error('a fresh open must not focus an existing window');
      },
      recordOpenAttempt: () => {},
    });
    expect(result).toEqual({ kind: 'open', ok: true });
    expect(opened).toEqual([{ docPath: DECK, port: 5200, process }]);
  });

  it('joins an in-flight open instead of spawning a rival server for the same deck', async () => {
    const registry = createSlidesDeckRegistry();
    let spawns = 0;
    let releaseProbe: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const startDeps: StartSlidevDeps = {
      findFreePort: () => Promise.resolve(5300),
      spawnSlidev: () => {
        spawns += 1;
        return fakeSlidevProcess();
      },
      probeReady: async () => {
        await gate;
        return { reachable: true, hasVersionMeta: true };
      },
      now: () => 0,
      delay: () => Promise.resolve(),
    };
    const opened: Array<{ docPath: string; port: number }> = [];
    const deps = {
      registry,
      startDeps,
      openWindow: async (deck: { docPath: string; port: number; process: SlidevProcess }) => {
        opened.push({ docPath: deck.docPath, port: deck.port });
        registry.register({ ...deck, window: fakeWindow(opened.length) });
        return { shown: true };
      },
      focusWindow: () => {},
      recordOpenAttempt: () => {},
    };

    const first = handleSlidesOpen(DECK, deps);
    const second = handleSlidesOpen(DECK, deps);
    releaseProbe?.();
    const results = await Promise.all([first, second]);

    expect(results).toEqual([
      { kind: 'open', ok: true },
      { kind: 'open', ok: true },
    ]);
    expect(spawns).toBe(1);
    expect(opened).toEqual([{ docPath: DECK, port: 5300 }]);
    expect(registry.size()).toBe(1);
  });

  it('gives a joined activation the real verdict when the in-flight open fails', async () => {
    const registry = createSlidesDeckRegistry();
    const { deps: startDeps } = timingOutStartDeps();
    const deps = {
      registry,
      startDeps,
      openWindow: () => {
        throw new Error('a timed-out start must not open a window');
      },
      focusWindow: () => {},
      recordOpenAttempt: () => {},
    };
    const results = await Promise.all([handleSlidesOpen(DECK, deps), handleSlidesOpen(DECK, deps)]);
    expect(results).toEqual([
      { kind: 'open', ok: false, reason: 'timeout' },
      { kind: 'open', ok: false, reason: 'timeout' },
    ]);
    expect(registry.getOpenInFlight(DECK)).toBeUndefined();
  });

  it('focuses an already-open deck instead of spawning a second server', async () => {
    const registry = createSlidesDeckRegistry();
    const window = fakeWindow(1);
    registry.register({ docPath: DECK, port: 5200, process: fakeSlidevProcess(), window });

    let secondSpawned = false;
    const focused: SlidesDeckWindow[] = [];
    const result = await handleSlidesOpen(DECK, {
      registry,
      startDeps: {
        findFreePort: () => Promise.resolve(5300),
        spawnSlidev: () => {
          secondSpawned = true;
          return fakeSlidevProcess();
        },
        probeReady: () => Promise.resolve({ reachable: true, hasVersionMeta: true }),
        now: () => 0,
        delay: () => Promise.resolve(),
      },
      openWindow: () => {
        throw new Error('an already-open deck must not open a second window');
      },
      focusWindow: (w) => focused.push(w),
      recordOpenAttempt: () => {},
    });
    expect(result).toEqual({ kind: 'open', ok: true });
    expect(secondSpawned).toBe(false);
    expect(focused).toEqual([window]);
  });

  it('reports the start failure and opens nothing when readiness never lands', async () => {
    const registry = createSlidesDeckRegistry();
    const { deps: startDeps, spawned } = timingOutStartDeps();
    let openedCount = 0;
    const result = await handleSlidesOpen(DECK, {
      registry,
      startDeps,
      openWindow: async () => {
        openedCount += 1;
        return { shown: true };
      },
      focusWindow: () => {},
      recordOpenAttempt: () => {},
    });
    expect(result).toEqual({ kind: 'open', ok: false, reason: 'timeout' });
    expect(spawned()).toBe(true);
    expect(openedCount).toBe(0);
  });

  it('reports renderer-failed when the server shell loads but the deck never mounts', async () => {
    const registry = createSlidesDeckRegistry();
    const attempts: OkSlidesOpenResult[] = [];
    const started = readyStartDeps(5200);
    const result = await handleSlidesOpen(DECK, {
      registry,
      startDeps: started.deps,
      openWindow: async () => ({ shown: false, reason: 'renderer-failed' }),
      focusWindow: () => {},
      recordOpenAttempt: (attempt) => attempts.push(attempt),
    });

    expect(result).toEqual({ kind: 'open', ok: false, reason: 'renderer-failed' });
    expect(attempts).toEqual([{ kind: 'open', ok: false, reason: 'renderer-failed' }]);
    await registry.reapAll();
    expect(started.signals).toEqual(['SIGKILL']);
  });

  it('preserves a navigation failure from the hidden window lifecycle', async () => {
    const registry = createSlidesDeckRegistry();
    const attempts: OkSlidesOpenResult[] = [];
    const result = await handleSlidesOpen(DECK, {
      registry,
      startDeps: readyStartDeps(5200).deps,
      openWindow: async () => ({ shown: false, reason: 'load-failed' }),
      focusWindow: () => {},
      recordOpenAttempt: (attempt) => attempts.push(attempt),
    });

    expect(result).toEqual({ kind: 'open', ok: false, reason: 'load-failed' });
    expect(attempts).toEqual([{ kind: 'open', ok: false, reason: 'load-failed' }]);
  });

  it('does not record a user-cancelled hidden window as a failed open', async () => {
    const registry = createSlidesDeckRegistry();
    const attempts: OkSlidesOpenResult[] = [];
    const result = await handleSlidesOpen(DECK, {
      registry,
      startDeps: readyStartDeps(5200).deps,
      openWindow: async () => ({ shown: false, reason: 'cancelled' }),
      focusWindow: () => {},
      recordOpenAttempt: (attempt) => attempts.push(attempt),
    });

    expect(result).toEqual({ kind: 'open', ok: false, reason: 'cancelled' });
    expect(attempts).toEqual([]);
  });

  it('records exactly one open attempt for a fresh spawn', async () => {
    const registry = createSlidesDeckRegistry();
    const attempts: OkSlidesOpenResult[] = [];
    await handleSlidesOpen(DECK, {
      registry,
      startDeps: readyStartDeps(5200).deps,
      openWindow: async (deck) => {
        registry.register({ ...deck, window: fakeWindow(1) });
        return { shown: true };
      },
      focusWindow: () => {},
      recordOpenAttempt: (r) => attempts.push(r),
    });
    expect(attempts).toEqual([{ kind: 'open', ok: true }]);
  });

  it('records no open attempt when focusing an already-open deck (no spawn happened)', async () => {
    const registry = createSlidesDeckRegistry();
    registry.register({
      docPath: DECK,
      port: 5200,
      process: fakeSlidevProcess(),
      window: fakeWindow(1),
    });
    const attempts: OkSlidesOpenResult[] = [];
    await handleSlidesOpen(DECK, {
      registry,
      startDeps: readyStartDeps(5300).deps,
      openWindow: () => {
        throw new Error('an already-open deck must not open a second window');
      },
      focusWindow: () => {},
      recordOpenAttempt: (r) => attempts.push(r),
    });
    expect(attempts).toEqual([]);
  });

  it('records one open attempt — not two — when a second activation joins the in-flight open', async () => {
    const registry = createSlidesDeckRegistry();
    let releaseProbe: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const startDeps: StartSlidevDeps = {
      findFreePort: () => Promise.resolve(5300),
      spawnSlidev: () => fakeSlidevProcess(),
      probeReady: async () => {
        await gate;
        return { reachable: true, hasVersionMeta: true };
      },
      now: () => 0,
      delay: () => Promise.resolve(),
    };
    const attempts: OkSlidesOpenResult[] = [];
    const deps = {
      registry,
      startDeps,
      openWindow: async (deck: { docPath: string; port: number; process: SlidevProcess }) => {
        registry.register({ ...deck, window: fakeWindow(1) });
        return { shown: true };
      },
      focusWindow: () => {},
      recordOpenAttempt: (r: OkSlidesOpenResult) => attempts.push(r),
    };

    const first = handleSlidesOpen(DECK, deps);
    const second = handleSlidesOpen(DECK, deps);
    releaseProbe?.();
    await Promise.all([first, second]);

    expect(attempts).toEqual([{ kind: 'open', ok: true }]);
  });

  it('opens two different decks in their own windows on their own ports', async () => {
    const registry = createSlidesDeckRegistry();
    const opened: Array<{ docPath: string; port: number }> = [];
    const openDeck = (docPath: string, port: number) =>
      handleSlidesOpen(docPath, {
        registry,
        startDeps: readyStartDeps(port).deps,
        openWindow: async (deck) => {
          opened.push({ docPath: deck.docPath, port: deck.port });
          return { shown: true };
        },
        focusWindow: () => {
          throw new Error('distinct decks never focus');
        },
        recordOpenAttempt: () => {},
      });

    await openDeck('/decks/a.md', 5200);
    await openDeck('/decks/b.md', 5300);

    expect(opened).toEqual([
      { docPath: '/decks/a.md', port: 5200 },
      { docPath: '/decks/b.md', port: 5300 },
    ]);
  });
});

describe('shouldLogSlidesOpenError', () => {
  it('does not classify user cancellation as an IPC error', () => {
    expect(shouldLogSlidesOpenError({ kind: 'open', ok: false, reason: 'cancelled' })).toBe(false);
  });

  it('keeps operational failures observable', () => {
    expect(shouldLogSlidesOpenError({ kind: 'open', ok: false, reason: 'renderer-failed' })).toBe(
      true,
    );
    expect(shouldLogSlidesOpenError({ kind: 'open', ok: true })).toBe(false);
  });
});
