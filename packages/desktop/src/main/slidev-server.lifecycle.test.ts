import { ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gracefulTerminate } from './graceful-terminate.ts';
import { handleSlidesOpen } from './ipc/slides.ts';
import { createSlidesDeckRegistry, type SlidesDeckWindow } from './slides-registry.ts';
import { createSlidesWindow } from './slides-window.ts';
import { adaptSlidevChild, signalSlidevChild } from './slidev-server.ts';

const sends = vi.hoisted(() => ({
  records: [] as Array<{
    route: string;
    target?: number;
    signal?: number | string;
    command?: string;
    args?: readonly string[];
  }>,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter: Emitter } = await import('node:events');
  return {
    ...original,
    spawn: (command: string, args: readonly string[]) => {
      sends.records.push({ route: 'spawn', command, args });
      const child = Object.assign(new Emitter(), {
        kill: (signal?: string) => {
          sends.records.push({ route: 'utility-handle', signal });
          return true;
        },
      });
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    },
  };
});

const releases: Array<() => Promise<unknown>> = [];

beforeEach(() => {
  sends.records.length = 0;
  vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
    sends.records.push({ route: 'process', target, signal });
    return true;
  });
  vi.spyOn(ChildProcess.prototype, 'kill').mockImplementation(function (
    this: ChildProcess,
    signal,
  ) {
    sends.records.push({ route: 'child-handle', target: this.pid, signal });
    return true;
  });
});

afterEach(async () => {
  await Promise.all(releases.splice(0).map((release) => release()));
  await setImmediate();
  vi.restoreAllMocks();
});

async function ownedSlidevChild() {
  const { spawn } =
    await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume();'], {
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'ignore', 'ignore'],
    env: {},
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  );
  const release = async () => {
    child.stdin.end();
    return closed;
  };
  releases.push(release);
  const adapted = adaptSlidevChild(child);
  await once(child, 'spawn');
  expect(adapted.isAlive()).toBe(true);
  expect(child.pid).toBeGreaterThan(1);
  return { child, adapted, release };
}

function recordingWindow() {
  const events = new EventEmitter();
  const window: SlidesDeckWindow = {
    id: 1,
    focus: () => {},
    show: () => {},
    on: (event, handler) => {
      events.on(event, handler);
    },
    once: (event, handler) => {
      events.once(event, handler);
    },
    webContents: {
      send: () => {},
      once: () => {},
      on: () => {},
      setWindowOpenHandler: () => {},
      executeJavaScript: async () => true,
    },
    loadFile: async () => {},
    loadURL: async () => {},
  };
  return { window, close: () => events.emit('closed') };
}

async function witnessLiveSend(owned: Awaited<ReturnType<typeof ownedSlidevChild>>) {
  await owned.adapted.signal('SIGTERM');
  expect(sends.records).not.toEqual([]);
  expect(owned.adapted.isAlive()).toBe(true);
  sends.records.length = 0;
}

describe('Slidev child lifetime', () => {
  it.each(['darwin', 'win32'] as const)('dispatches a live child stop on %s', async (platform) => {
    const owned = await ownedSlidevChild();
    const killWindowsTree = async (target: number) => {
      sends.records.push({ route: 'tree', target });
    };
    await signalSlidevChild(owned.child, 'SIGTERM', { platform, killWindowsTree });
    expect(sends.records).toEqual([
      platform === 'win32'
        ? { route: 'tree', target: owned.child.pid }
        : { route: 'process', target: -Number(owned.child.pid), signal: 'SIGTERM' },
    ]);
    expect(owned.adapted.isAlive()).toBe(true);
  });

  it.each(['darwin', 'win32'] as const)(
    'leaves an exited child untouched on %s',
    async (platform) => {
      const owned = await ownedSlidevChild();
      const killWindowsTree = async (target: number) => {
        sends.records.push({ route: 'tree', target });
      };
      await signalSlidevChild(owned.child, 'SIGTERM', { platform, killWindowsTree });
      expect(sends.records).not.toEqual([]);
      sends.records.length = 0;
      expect(await owned.release()).toEqual({ code: 0, signal: null });
      expect(owned.adapted.isAlive()).toBe(false);
      await signalSlidevChild(owned.child, 'SIGTERM', { platform, killWindowsTree });
      await signalSlidevChild(owned.child, 'SIGKILL', { platform, killWindowsTree });
      expect(sends.records).toEqual([]);
    },
  );

  it('closes a shown deck after its child exits without another stop', async () => {
    const owned = await ownedSlidevChild();
    const view = recordingWindow();
    const registry = createSlidesDeckRegistry();
    const docPath = '/decks/lifetime.md';
    expect(
      await createSlidesWindow({
        createWindow: () => view.window,
        registry,
        deck: { docPath, port: 3030, process: owned.adapted },
        waitForRenderer: async () => ({ kind: 'rendered' }),
      }),
    ).toEqual({ shown: true });
    expect(registry.get(docPath)?.window).toBe(view.window);
    await witnessLiveSend(owned);
    expect(await owned.release()).toEqual({ code: 0, signal: null });
    expect(owned.adapted.isAlive()).toBe(false);
    view.close();
    await setImmediate();
    expect(registry.get(docPath)).toBeUndefined();
    expect(sends.records).toEqual([]);
  });

  it('preserves a window-open failure after child exit without another stop', async () => {
    const owned = await ownedSlidevChild();
    await witnessLiveSend(owned);
    const failure = new Error('window opening failed');
    const registry = createSlidesDeckRegistry();
    const docPath = '/decks/lifetime.md';
    await expect(
      handleSlidesOpen(docPath, {
        registry,
        startDeps: {
          findFreePort: async () => 3030,
          spawnSlidev: () => owned.adapted,
          probeReady: async () => ({ reachable: true, hasVersionMeta: true }),
          now: () => 0,
          delay: async () => {},
        },
        openWindow: async () => {
          expect(await owned.release()).toEqual({ code: 0, signal: null });
          expect(owned.adapted.isAlive()).toBe(false);
          throw failure;
        },
        focusWindow: () => {},
        recordOpenAttempt: () => {},
      }),
    ).rejects.toBe(failure);
    await setImmediate();
    expect(registry.getOpenInFlight(docPath)).toBeUndefined();
    expect(sends.records).toEqual([]);
  });

  it('leaves the child untouched when it exits during the final grace wait', async () => {
    const owned = await ownedSlidevChild();
    let clock = 0;
    let waited = false;
    await gracefulTerminate({
      sendSignal: (signal) => owned.adapted.signal(signal),
      isAlive: () => owned.adapted.isAlive(),
      now: () => clock,
      sleep: async (ms) => {
        expect(sends.records).not.toEqual([]);
        expect(owned.adapted.isAlive()).toBe(true);
        expect(await owned.release()).toEqual({ code: 0, signal: null });
        expect(owned.adapted.isAlive()).toBe(false);
        sends.records.length = 0;
        clock += ms;
        waited = true;
      },
      graceMs: 1,
      pollMs: 1,
    });
    expect(waited).toBe(true);
    expect(sends.records).toEqual([]);
  });
});
