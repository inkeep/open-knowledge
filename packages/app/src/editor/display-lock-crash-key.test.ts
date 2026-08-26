/**
 * @covers-unit src/editor/display-lock-crash-key.ts
 *
 * The publish path is the thing under test, not the encoding alone. Three ways
 * this diagnostic could be worse than nothing, each pinned below: it goes quiet
 * under load (silent exactly when it matters), it keeps writing after the
 * editor is gone (a stale reading in a dump gets trusted), or it publishes a
 * value that cannot be dated relative to the crash (residue from a scroll
 * minutes earlier reads identically to a burst in flight).
 */

import { describe, expect, test } from 'vitest';
import {
  type DisplayLockSnapshot,
  encodeDisplayLockState,
  startDisplayLockCrashKeyReporter,
} from './display-lock-crash-key.ts';
import { OK_CHUNK_WRAPPER_CLASS } from './extensions/chunk-wrapper-decoration.ts';

/**
 * Conservative byte ceiling the desktop bridge enforces before handing a value
 * to Crashpad. Asserted as an inequality with real margin rather than pinned to
 * the bridge's exact constant: the app cannot import from the desktop package,
 * and an equality across that boundary would be a drift hazard where a bound
 * with headroom is not.
 */
const BRIDGE_BYTE_CEILING = 127;

/** Minimal stand-in for an element; only `classList.contains` is read. */
function elementWithClass(className: string): { classList: { contains(t: string): boolean } } {
  return { classList: { contains: (token: string) => token === className } };
}

/**
 * Built from the class the decoration extension actually stamps, not a third
 * copy of the literal: the whole diagnostic hinges on the reporter matching
 * that exact string, and a rename there would otherwise leave this test green
 * while the reporter silently matched nothing.
 */
const chunkWrapper = () => elementWithClass(OK_CHUNK_WRAPPER_CLASS);

/** A root that records its listener so tests can dispatch straight into it. */
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

/** Reporter wired to collectors, with frames run manually. */
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
    /** Run the next queued frame callback, if any. */
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
    // Real margin, not a squeak past the ceiling: a value the bridge drops is a
    // diagnostic that silently stops reporting.
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
    // Passing no `publish` drives the module down its real bridge-lookup path,
    // which reads a global. In a node environment that global is absent, and an
    // unguarded read throws `ReferenceError` rather than yielding undefined.
    //
    // `window` is DELETED here rather than left to chance: sibling suites leak a
    // `globalThis.window`, and under that leak this case passes while exercising
    // nothing. That is exactly how the bug escaped once already — the file was
    // green alone and red in the full run.
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
      // Restoring is not optional: a leaked deletion would break every later
      // suite in this process that expects the DOM global to be present.
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
    // This is what makes a reading datable. Without it, a burst from a scroll
    // minutes before the crash is indistinguishable from one in flight during
    // the crashing frame.
    const h = harness();
    h.fire(chunkWrapper(), true);
    h.tick();
    expect(h.published).toEqual(['v1 lock=1 f=1 n=1 s=0']);

    h.tick();
    expect(h.published).toEqual(['v1 lock=1 f=1 n=1 s=0', 'v1 lock=1 f=1 n=1 s=1']);

    // And exactly once — a settled burst must not keep rewriting the key.
    expect(h.frames, 'settling must not re-arm another frame').toHaveLength(0);
  });

  test('a burst that keeps going never publishes a settled reading', () => {
    const h = harness();
    h.fire(chunkWrapper(), true);
    h.tick(); // publishes the first frame, live
    h.fire(chunkWrapper(), false); // arrives during the settle frame
    h.tick(); // must publish the new transitions, not a settled marker

    expect(h.published).toEqual(['v1 lock=1 f=1 n=1 s=0', 'v1 lock=0 f=1 n=2 s=0']);
  });

  test('a new burst after settling publishes live again', () => {
    const h = harness();
    h.fire(chunkWrapper(), true);
    h.tick();
    h.tick(); // settles
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
    // `.ok-mode-hidden` is `content-visibility: hidden`, so it cannot fire this
    // event at all — an earlier draft mapped it anyway, which was dead code that
    // would have made a pane crash look like a chunk-wrapper one. Pinned so the
    // mapping cannot come back by accident.
    const h = harness();
    h.fire(elementWithClass('ok-mode-hidden'), true);
    h.fire(elementWithClass('some-other-class'), true);
    h.fire(null, true);
    expect(h.frames, 'a non-chunk-wrapper target must not even schedule a frame').toHaveLength(0);
    expect(h.published).toEqual([]);
  });

  test('a throwing sink cannot break the frame loop or inflate later counts', () => {
    // `publish` crosses the contextBridge into a native binding, so a throw is
    // a real possibility rather than a hypothetical. Two things must hold: the
    // throw does not escape into the rAF callback (where it would recur every
    // frame for a whole scroll burst), and the frame's bookkeeping still
    // completes, so `f` counts that frame's transitions rather than
    // accumulating every failed frame's into the next reading.
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

    // The settle republish must still happen for a burst whose own publish
    // threw. `s` is the only field that dates a reading, so a refactor that
    // marked a burst live only after a SUCCESSFUL publish — which reads as
    // tightening — would leave one bridge throw permanently suppressing that
    // burst's settled marker, and the dump would carry a stale `s=0` forever.
    frames.shift()?.();
    expect(published).toEqual(['v1 lock=1 f=2 n=2 s=1']);

    // And the next burst reports ONLY its own transitions, not the failed
    // frame's accumulated on top.
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

    // The frame callback was queued before stop and still runs; it must not
    // write a reading for an editor that is gone.
    h.tick();
    expect(h.published).toEqual([]);
  });
});
