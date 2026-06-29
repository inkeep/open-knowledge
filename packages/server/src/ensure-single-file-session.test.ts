import { afterEach, describe, expect, test } from 'bun:test';
import {
  __resetEnsureSingleFileInflightForTests,
  type EnsureSingleFileDeps,
  ensureSingleFileSession,
} from './ensure-single-file-session.ts';

afterEach(() => __resetEnsureSingleFileInflightForTests());

function makeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function makeDeps(
  isServing: (f: string) => Promise<boolean>,
  spawn: { calls: string[] },
): EnsureSingleFileDeps {
  const clock = makeClock();
  return {
    spawnSession: (f) => spawn.calls.push(f),
    isServing,
    realpath: async (p) => p,
    pollIntervalMs: 100,
    timeoutMs: 1000,
    sleep: clock.sleep,
    now: clock.now,
  };
}

describe('ensureSingleFileSession', () => {
  test('already serving → returns true without spawning', async () => {
    const spawn = { calls: [] as string[] };
    const ok = await ensureSingleFileSession(
      '/loose/a.md',
      makeDeps(async () => true, spawn),
    );
    expect(ok).toBe(true);
    expect(spawn.calls).toEqual([]);
  });

  test('spawns once, returns true when the session registers on a later poll', async () => {
    const spawn = { calls: [] as string[] };
    let checks = 0;
    const deps = makeDeps(async () => {
      checks += 1;
      return checks >= 3;
    }, spawn);
    const ok = await ensureSingleFileSession('/loose/b.md', deps);
    expect(ok).toBe(true);
    expect(spawn.calls).toEqual(['/loose/b.md']);
  });

  test('returns false when the session never registers before the timeout', async () => {
    const spawn = { calls: [] as string[] };
    const ok = await ensureSingleFileSession(
      '/loose/c.md',
      makeDeps(async () => false, spawn),
    );
    expect(ok).toBe(false);
    expect(spawn.calls).toEqual(['/loose/c.md']); // spawned, but never came up
  });

  test('single-flight: concurrent ensures for one file coalesce to a single spawn', async () => {
    const spawn = { calls: [] as string[] };
    let checks = 0;
    const deps = makeDeps(async () => {
      checks += 1;
      return checks >= 3;
    }, spawn);
    const [a, b] = await Promise.all([
      ensureSingleFileSession('/loose/d.md', deps),
      ensureSingleFileSession('/loose/d.md', deps),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(spawn.calls).toEqual(['/loose/d.md']); // exactly one spawn for both callers
  });
  test('different files spawn independently (not coalesced)', async () => {
    const clock = makeClock();
    const spawn = { calls: [] as string[] };
    const served = new Set<string>();
    const deps: EnsureSingleFileDeps = {
      spawnSession: (f) => {
        spawn.calls.push(f);
        served.add(f); // registers immediately so the next poll sees it
      },
      isServing: async (f) => served.has(f),
      realpath: async (p) => p,
      pollIntervalMs: 100,
      timeoutMs: 1000,
      sleep: clock.sleep,
      now: clock.now,
    };
    const [a, b] = await Promise.all([
      ensureSingleFileSession('/loose/p.md', deps),
      ensureSingleFileSession('/loose/q.md', deps),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect([...spawn.calls].sort()).toEqual(['/loose/p.md', '/loose/q.md']);
  });
});
