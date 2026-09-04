import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { subscribeToMorphClock } from './working-avatar-driver';

function installFakeRaf() {
  let nextId = 1;
  let pending: { id: number; fn: FrameRequestCallback } | null = null;
  let requests = 0;

  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    requests += 1;
    const id = nextId++;
    pending = { id, fn };
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    if (pending?.id === id) pending = null;
  });

  return {
    pump() {
      const current = pending;
      pending = null;
      current?.fn(performance.now());
    },
    get running() {
      return pending !== null;
    },
    get requests() {
      return requests;
    },
  };
}

describe('working avatar morph clock', () => {
  let raf: ReturnType<typeof installFakeRaf>;

  beforeEach(() => {
    vi.useFakeTimers();
    raf = installFakeRaf();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('every subscriber starts its own cycle at zero', () => {
    const first: number[] = [];
    const stopFirst = subscribeToMorphClock((t) => first.push(t));
    raf.pump();
    expect(first[0]).toBeCloseTo(0, 2);

    vi.advanceTimersByTime(5_000);

    const late: number[] = [];
    const stopLate = subscribeToMorphClock((t) => late.push(t));
    raf.pump();
    expect(late[0]).toBeCloseTo(0, 2);
    expect(first.at(-1)).toBeGreaterThan(4.9);

    stopFirst();
    stopLate();
  });

  test('drives any number of subscribers from a single frame request', () => {
    const stops = [
      subscribeToMorphClock(() => {}),
      subscribeToMorphClock(() => {}),
      subscribeToMorphClock(() => {}),
    ];
    const before = raf.requests;
    raf.pump();
    expect(raf.requests - before).toBe(1);
    for (const stop of stops) stop();
  });

  test('stops the loop once the last subscriber leaves, and restarts on the next', () => {
    const stopA = subscribeToMorphClock(() => {});
    const stopB = subscribeToMorphClock(() => {});
    expect(raf.running).toBe(true);

    stopA();
    expect(raf.running).toBe(true);
    stopB();
    expect(raf.running).toBe(false);

    const stopC = subscribeToMorphClock(() => {});
    expect(raf.running).toBe(true);
    stopC();
  });

  test('the last subscriber leaving from inside its own tick stops the loop', () => {
    let ticks = 0;
    let stop = () => {};
    stop = subscribeToMorphClock(() => {
      ticks += 1;
      stop();
    });

    raf.pump();
    expect(ticks).toBe(1);
    expect(raf.running).toBe(false);

    raf.pump();
    expect(ticks).toBe(1);
    expect(raf.running).toBe(false);
  });

  test('an unsubscribed avatar stops receiving ticks', () => {
    let ticks = 0;
    const stop = subscribeToMorphClock(() => {
      ticks += 1;
    });
    raf.pump();
    expect(ticks).toBe(1);

    const keepAlive = subscribeToMorphClock(() => {});
    stop();
    raf.pump();
    expect(ticks).toBe(1);
    keepAlive();
  });
});
