import { describe, expect, test } from 'vitest';
import {
  type DisplayLockSnapshot,
  encodeDisplayLockState,
  startDisplayLockCrashKeyReporter,
} from './display-lock-crash-key.ts';
import { OK_CHUNK_WRAPPER_CLASS } from './extensions/chunk-wrapper-decoration.ts';

const BRIDGE_BYTE_CEILING = 127;

function elementWithClass(className: string): { classList: { contains(t: string): boolean } } {
  return { classList: { contains: (token: string) => token === className } };
}

const chunkWrapper = () => elementWithClass(OK_CHUNK_WRAPPER_CLASS);

function fakeRoot() {
  let handler: ((event: Event) => void) | null = null;
  return {
    root: {
      addEventListener(_type: string, listener: (event: Event) => void) {
        handler = listener;
      },
      removeEventListener() {
        handler = null;
      },
    },
    attached: () => handler !== null,
    fire(target: unknown, skipped: boolean) {
      handler?.({ target, skipped } as unknown as Event);
    },
  };
}

function harness() {
  const published: string[] = [];
  const frames: Array<() => void> = [];
  const root = fakeRoot();
  const stop = startDisplayLockCrashKeyReporter({
    root: root.root,
    publish: (s) => published.push(s),
    schedule: (run) => frames.push(run),
  });
  return {
    published,
    frames,
    stop,
    fire: root.fire,
    attached: root.attached,
    tick: () => frames.shift()?.(),
  };
}

describe('encodeDisplayLockState', () => {
  test('names the lock direction and whether the burst had settled', () => {
    expect(encodeDisplayLockState({ locked: true, inFrame: 3, total: 12, settled: false })).toBe(
      'v1 lock=1 f=3 n=12 s=0',
    );
    expect(encodeDisplayLockState({ locked: false, inFrame: 1, total: 4, settled: true })).toBe(
      'v1 lock=0 f=1 n=4 s=1',
    );
  });

  test('counters saturate rather than grow, keeping the value bounded', () => {
    const huge: DisplayLockSnapshot = {
      locked: true,
      inFrame: Number.MAX_SAFE_INTEGER,
      total: Number.MAX_SAFE_INTEGER,
      settled: false,
    };
    expect(encodeDisplayLockState(huge)).toBe('v1 lock=1 f=99999 n=99999 s=0');
    expect(encodeDisplayLockState(huge).length).toBeLessThan(BRIDGE_BYTE_CEILING);
    expect(encodeDisplayLockState(huge).length).toBeLessThan(60);
  });

  test('nonsense counters degrade to zero instead of into the encoding', () => {
    expect(
      encodeDisplayLockState({ locked: true, inFrame: Number.NaN, total: -5, settled: false }),
    ).toBe('v1 lock=1 f=0 n=0 s=0');
  });
});

describe('startDisplayLockCrashKeyReporter', () => {
  test('declines without throwing when there is no window to read a bridge from', () => {
    const hadWindow = 'window' in globalThis;
    const saved = (globalThis as { window?: unknown }).window;
    delete (globalThis as { window?: unknown }).window;
    try {
      const root = fakeRoot();
      let stop: (() => void) | undefined;
      expect(() => {
        stop = startDisplayLockCrashKeyReporter({ root: root.root });
      }).not.toThrow();
      expect(root.attached(), 'with no sink, no listener may be attached at all').toBe(false);
      expect(() => stop?.()).not.toThrow();
    } finally {
      if (hadWindow) (globalThis as { window?: unknown }).window = saved;
    }
  });

  test('coalesces a burst of transitions into one publish per frame', () => {
    const h = harness();
    for (let i = 0; i < 40; i += 1) h.fire(chunkWrapper(), true);
    expect(h.published, 'nothing may publish before the frame runs').toEqual([]);
    expect(h.frames, 'a burst must schedule exactly one flush').toHaveLength(1);

    h.tick();
    expect(h.published).toEqual(['v1 lock=1 f=40 n=40 s=0']);
  });

  test('republishes once, marked settled, on the first frame with no transitions', () => {
    const h = harness();
    h.fire(chunkWrapper(), true);
    h.tick();
    expect(h.published).toEqual(['v1 lock=1 f=1 n=1 s=0']);

    h.tick();
    expect(h.published).toEqual(['v1 lock=1 f=1 n=1 s=0', 'v1 lock=1 f=1 n=1 s=1']);

    expect(h.frames, 'settling must not re-arm another frame').toHaveLength(0);
  });

  test('a burst that keeps going never publishes a settled reading', () => {
    const h = harness();
    h.fire(chunkWrapper(), true);
    h.tick();
    h.fire(chunkWrapper(), false);
    h.tick();

    expect(h.published).toEqual(['v1 lock=1 f=1 n=1 s=0', 'v1 lock=0 f=1 n=2 s=0']);
  });

  test('a new burst after settling publishes live again', () => {
    const h = harness();
    h.fire(chunkWrapper(), true);
    h.tick();
    h.tick();
    h.fire(chunkWrapper(), true);
    h.tick();

    expect(h.published).toEqual([
      'v1 lock=1 f=1 n=1 s=0',
      'v1 lock=1 f=1 n=1 s=1',
      'v1 lock=1 f=1 n=2 s=0',
    ]);
  });

  test('counts each frame separately while accumulating the running total', () => {
    const h = harness();
    h.fire(chunkWrapper(), true);
    h.fire(chunkWrapper(), true);
    h.tick();
    h.fire(chunkWrapper(), false);
    h.tick();

    expect(h.published).toEqual(['v1 lock=1 f=2 n=2 s=0', 'v1 lock=0 f=1 n=3 s=0']);
  });

  test('ignores elements that are not chunk wrappers, including the pane site', () => {
    const h = harness();
    h.fire(elementWithClass('ok-mode-hidden'), true);
    h.fire(elementWithClass('some-other-class'), true);
    h.fire(null, true);
    expect(h.frames, 'a non-chunk-wrapper target must not even schedule a frame').toHaveLength(0);
    expect(h.published).toEqual([]);
  });

  test('a throwing sink cannot break the frame loop or inflate later counts', () => {
    const published: string[] = [];
    const frames: Array<() => void> = [];
    let failNext = true;
    const root = fakeRoot();
    startDisplayLockCrashKeyReporter({
      root: root.root,
      publish: (s) => {
        if (failNext) {
          failNext = false;
          throw new Error('bridge exploded');
        }
        published.push(s);
      },
      schedule: (run) => frames.push(run),
    });

    root.fire(chunkWrapper(), true);
    root.fire(chunkWrapper(), true);
    expect(() => frames.shift()?.()).not.toThrow();
    expect(published, 'the failed publish produced no reading').toEqual([]);

    frames.shift()?.();
    expect(published).toEqual(['v1 lock=1 f=2 n=2 s=1']);

    root.fire(chunkWrapper(), true);
    frames.shift()?.();
    expect(published).toEqual(['v1 lock=1 f=2 n=2 s=1', 'v1 lock=1 f=1 n=3 s=0']);
  });

  test('stop detaches the listener and neuters a frame already in flight', () => {
    const h = harness();
    h.fire(chunkWrapper(), true);
    expect(h.frames).toHaveLength(1);

    h.stop();
    expect(h.attached(), 'stop must remove the listener').toBe(false);

    h.tick();
    expect(h.published).toEqual([]);
  });
});
