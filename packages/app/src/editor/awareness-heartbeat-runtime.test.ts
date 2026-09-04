import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { AWARENESS_RENEW_INTERVAL_MS } from './awareness-heartbeat';

interface WorkerScopeLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

const constructed: { url: unknown; options: unknown }[] = [];
let terminateCount = 0;
let mainSide: TransportWorker | null = null;
let workerScope: WorkerScopeLike;

class TransportWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(url: unknown, options?: unknown) {
    constructed.push({ url, options });
    mainSide = this;
  }
  postMessage(message: unknown): void {
    workerScope.onmessage?.({ data: message });
  }
  terminate(): void {
    terminateCount += 1;
  }
}

function setLastUpdated(aw: Awareness, t: number): void {
  const meta = aw.meta.get(aw.clientID);
  if (meta) aw.meta.set(aw.clientID, { clock: meta.clock, lastUpdated: t });
}

async function loadRuntime(): Promise<typeof import('./awareness-heartbeat-runtime')> {
  vi.resetModules();
  await import('./awareness-heartbeat.worker');
  return import('./awareness-heartbeat-runtime');
}

let doc: Y.Doc;
let awareness: Awareness;

beforeEach(() => {
  constructed.length = 0;
  terminateCount = 0;
  mainSide = null;
  workerScope = {
    onmessage: null,
    postMessage: (message: unknown) => {
      mainSide?.onmessage?.({ data: message });
    },
  };
  vi.stubGlobal('self', workerScope);
  vi.stubGlobal('Worker', TransportWorker);
  vi.useFakeTimers();
  doc = new Y.Doc();
  awareness = new Awareness(doc);
});

afterEach(() => {
  awareness.destroy();
  doc.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function publish(): void {
  awareness.setLocalState({ user: { name: 'me' } });
  setLastUpdated(awareness, Date.now());
}

describe('awareness heartbeat production wiring', () => {
  it('renews the local entry off the worker clock at the renewal interval', async () => {
    const { getAwarenessHeartbeat } = await loadRuntime();
    const heartbeat = getAwarenessHeartbeat();
    heartbeat.setAwareness(awareness);
    publish();
    const clockAtPublish = awareness.meta.get(awareness.clientID)?.clock ?? -1;

    heartbeat.start();
    vi.advanceTimersByTime(AWARENESS_RENEW_INTERVAL_MS);

    expect(awareness.meta.get(awareness.clientID)?.clock ?? -1).toBeGreaterThan(clockAtPublish);

    heartbeat.stop();
  });

  it('does not tick before the interval elapses', async () => {
    const { getAwarenessHeartbeat } = await loadRuntime();
    const heartbeat = getAwarenessHeartbeat();
    heartbeat.setAwareness(awareness);
    publish();
    let updates = 0;
    awareness.on('update', () => {
      updates += 1;
    });

    heartbeat.start();
    vi.advanceTimersByTime(AWARENESS_RENEW_INTERVAL_MS - 1);

    expect(updates).toBe(0);
  });

  it('keeps renewing every interval for as long as it runs', async () => {
    const { getAwarenessHeartbeat } = await loadRuntime();
    const heartbeat = getAwarenessHeartbeat();
    heartbeat.setAwareness(awareness);
    publish();
    heartbeat.start();

    const renewInstants: number[] = [];
    awareness.on('update', () => renewInstants.push(Date.now()));

    for (let i = 0; i < 4; i += 1) {
      vi.advanceTimersByTime(AWARENESS_RENEW_INTERVAL_MS);
      setLastUpdated(awareness, Date.now());
    }

    expect(renewInstants).toHaveLength(4);
    heartbeat.stop();
  });

  it('constructs the worker as an ES module', async () => {
    const { getAwarenessHeartbeat } = await loadRuntime();
    getAwarenessHeartbeat().start();

    expect(constructed).toHaveLength(1);
    expect(constructed[0]?.options).toMatchObject({ type: 'module' });
    expect(String(constructed[0]?.url)).toContain('awareness-heartbeat.worker');
  });

  it('start() is idempotent — one worker, one clock', async () => {
    const { getAwarenessHeartbeat } = await loadRuntime();
    const heartbeat = getAwarenessHeartbeat();
    heartbeat.setAwareness(awareness);
    publish();
    let updates = 0;
    awareness.on('update', () => {
      updates += 1;
    });

    heartbeat.start();
    heartbeat.start();
    vi.advanceTimersByTime(AWARENESS_RENEW_INTERVAL_MS);

    expect(constructed).toHaveLength(1);
    expect(updates).toBe(1);
    heartbeat.stop();
  });

  it('stop() halts the worker clock and terminates it', async () => {
    const { getAwarenessHeartbeat } = await loadRuntime();
    const heartbeat = getAwarenessHeartbeat();
    heartbeat.setAwareness(awareness);
    publish();
    heartbeat.start();

    heartbeat.stop();
    let updates = 0;
    awareness.on('update', () => {
      updates += 1;
    });
    vi.advanceTimersByTime(AWARENESS_RENEW_INTERVAL_MS * 5);

    expect(terminateCount).toBe(1);
    expect(updates).toBe(0);
  });

  it('ignores worker messages that are not ticks', async () => {
    const { getAwarenessHeartbeat } = await loadRuntime();
    const heartbeat = getAwarenessHeartbeat();
    heartbeat.setAwareness(awareness);
    publish();
    heartbeat.start();
    vi.setSystemTime(Date.now() + AWARENESS_RENEW_INTERVAL_MS * 2);
    let updates = 0;
    awareness.on('update', () => {
      updates += 1;
    });

    workerScope.postMessage('not-a-tick');
    workerScope.postMessage({ type: 'tick' });

    expect(updates).toBe(0);
    heartbeat.stop();
  });

  it('returns a process singleton', async () => {
    const { getAwarenessHeartbeat } = await loadRuntime();
    expect(getAwarenessHeartbeat()).toBe(getAwarenessHeartbeat());
  });

  it('degrades to inert where there is no Worker (SSR, unit rigs)', async () => {
    vi.stubGlobal('Worker', undefined);
    const { getAwarenessHeartbeat } = await loadRuntime();
    const heartbeat = getAwarenessHeartbeat();
    heartbeat.setAwareness(awareness);
    publish();

    expect(() => heartbeat.start()).not.toThrow();
    expect(constructed).toHaveLength(0);
    expect(() => heartbeat.stop()).not.toThrow();
  });
});
