import { describe, expect, test } from 'bun:test';
import { createSingleFlight } from './single-flight.ts';

describe('createSingleFlight (PRD-6972 FR2)', () => {
  test('N concurrent identical keys run fn exactly once and share one result', async () => {
    const sf = createSingleFlight<number>();
    let calls = 0;
    let resolveWalk: (v: number) => void = () => {};
    const gate = new Promise<number>((r) => {
      resolveWalk = r;
    });
    const fn = () => {
      calls += 1;
      return gate;
    };

    // 5 concurrent runs on the same tick, same key.
    const runs = Array.from({ length: 5 }, () => sf.run('k', fn));
    expect(calls).toBe(1); // exactly one git walk
    expect(runs.filter((r) => r.coalesced)).toHaveLength(4); // N-1 coalesced
    expect(sf.size).toBe(1);

    resolveWalk(42);
    const results = await Promise.all(runs.map((r) => r.promise));
    expect(results).toEqual([42, 42, 42, 42, 42]); // N identical responses
  });

  test('distinct keys run independently', async () => {
    const sf = createSingleFlight<string>();
    let calls = 0;
    const fn = (v: string) => () => {
      calls += 1;
      return Promise.resolve(v);
    };
    const a = sf.run('a', fn('a'));
    const b = sf.run('b', fn('b'));
    expect(calls).toBe(2);
    expect(a.coalesced).toBe(false);
    expect(b.coalesced).toBe(false);
    expect(await a.promise).toBe('a');
    expect(await b.promise).toBe('b');
  });

  test('entry evicts on settle (success) so a later identical key re-runs', async () => {
    const sf = createSingleFlight<number>();
    let calls = 0;
    const fn = () => {
      calls += 1;
      return Promise.resolve(calls);
    };

    const first = sf.run('k', fn);
    await first.promise;
    // Let the finally() eviction microtask run.
    await Promise.resolve();
    expect(sf.size).toBe(0);

    const second = sf.run('k', fn);
    expect(second.coalesced).toBe(false); // fresh run, not a stale shared result
    expect(await second.promise).toBe(2);
  });

  test('entry evicts on settle (error) and does not leak', async () => {
    const sf = createSingleFlight<number>();
    const failing = sf.run('k', () => Promise.reject(new Error('walk failed')));
    await expect(failing.promise).rejects.toThrow('walk failed');
    await Promise.resolve();
    expect(sf.size).toBe(0);
  });
});
