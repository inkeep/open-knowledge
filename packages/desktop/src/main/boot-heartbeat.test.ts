import { describe, expect, test } from 'vitest';
import {
  BOOT_HEARTBEAT_ABANDONED_SUFFIX,
  BOOT_HEARTBEAT_EVENTS,
  SPAWN_WAIT_HEARTBEAT_MS,
} from '../shared/boot-narration.ts';
import { type BootHeartbeatDeps, startBootHeartbeat } from './boot-heartbeat.ts';

function harness() {
  const intervals: { cb: () => void; ms: number; cleared: boolean; tick: () => void }[] = [];
  const lines: Record<string, unknown>[] = [];
  let flushes = 0;
  const deps: Required<BootHeartbeatDeps> = {
    log: {
      info: (obj: Record<string, unknown>) => {
        lines.push(obj);
      },
    },
    flushLog: () => {
      flushes += 1;
    },
    setInterval: (cb: () => void, ms: number) => {
      const rec = {
        cb,
        ms,
        cleared: false,
        tick: () => {
          if (!rec.cleared) cb();
        },
      };
      intervals.push(rec);
      return rec;
    },
    clearInterval: (handle: unknown) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  };
  return { deps, intervals, lines, flushes: () => flushes };
}

describe('startBootHeartbeat', () => {
  test('beats on the app cadence and stops when told to', () => {
    const h = harness();
    const stop = startBootHeartbeat(h.deps, BOOT_HEARTBEAT_EVENTS.boot, 'probing', () => ({
      phase: 'x',
    }));
    const beat = h.intervals[0];
    expect(beat?.ms).toBe(SPAWN_WAIT_HEARTBEAT_MS);
    beat?.tick();
    beat?.tick();
    expect(h.lines.map((l) => l.event)).toEqual([
      BOOT_HEARTBEAT_EVENTS.boot,
      BOOT_HEARTBEAT_EVENTS.boot,
    ]);
    expect(h.lines[0]).toMatchObject({ phase: 'x' });
    expect(h.flushes()).toBe(2);
    stop();
    expect(h.intervals.every((i) => i.cleared)).toBe(true);
  });

  test('an unbudgeted heartbeat never abandons', () => {
    const h = harness();
    startBootHeartbeat(h.deps, BOOT_HEARTBEAT_EVENTS.boot, 'probing', () => ({}));
    for (let i = 0; i < 50; i += 1) h.intervals[0]?.tick();
    expect(h.lines).toHaveLength(50);
    expect(h.lines.every((l) => l.event === BOOT_HEARTBEAT_EVENTS.boot)).toBe(true);
    expect(h.intervals[0]?.cleared).toBe(false);
  });

  test('a budgeted heartbeat beats exactly its budget, then abandons once', () => {
    const h = harness();
    startBootHeartbeat(h.deps, BOOT_HEARTBEAT_EVENTS.boot, 'probing', () => ({ phase: 'parked' }), {
      maxBeats: 3,
    });
    for (let i = 0; i < 10; i += 1) h.intervals[0]?.tick();
    const normal = h.lines.filter((l) => l.event === BOOT_HEARTBEAT_EVENTS.boot);
    const abandoned = h.lines.filter(
      (l) => l.event === `${BOOT_HEARTBEAT_EVENTS.boot}${BOOT_HEARTBEAT_ABANDONED_SUFFIX}`,
    );
    expect(normal).toHaveLength(3);
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]).toMatchObject({ beats: 3, phase: 'parked' });
    expect(h.intervals[0]?.cleared).toBe(true);
    expect(h.flushes()).toBe(4);
  });

  test('stopping twice clears once, so it composes with a second stop path', () => {
    const h = harness();
    let cleared = 0;
    h.deps.clearInterval = () => {
      cleared += 1;
    };
    const stop = startBootHeartbeat(h.deps, BOOT_HEARTBEAT_EVENTS.boot, 'probing', () => ({}));
    stop();
    stop();
    expect(cleared).toBe(1);
  });
});
