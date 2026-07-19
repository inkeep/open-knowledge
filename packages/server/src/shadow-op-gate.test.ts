import { describe, expect, test } from 'bun:test';
import { releaseShadowOpGate, ShadowOpGate, shadowOpGateFor } from './shadow-op-gate.ts';

/** A promise whose settle order we can observe alongside manual triggers. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('ShadowOpGate (forced interleavings, deterministic)', () => {
  test('mutators run concurrently with each other', async () => {
    const gate = new ShadowOpGate();
    const a = deferred();
    const b = deferred();
    let aStarted = false;
    let bStarted = false;
    const pa = gate.withMutator(async () => {
      aStarted = true;
      await a.promise;
    });
    const pb = gate.withMutator(async () => {
      bStarted = true;
      await b.promise;
    });
    await tick();
    expect(aStarted).toBe(true);
    expect(bStarted).toBe(true);
    expect(gate.activeMutators).toBe(2);
    a.resolve();
    b.resolve();
    await Promise.all([pa, pb]);
    expect(gate.activeMutators).toBe(0);
  });

  test('exclusive waits for an in-flight mutator to drain before running', async () => {
    const gate = new ShadowOpGate();
    const hold = deferred();
    let gcRan = false;
    const mutator = gate.withMutator(() => hold.promise);
    await tick();
    const gc = gate.withExclusive(async () => {
      gcRan = true;
    });
    await tick();
    // Mutator still holds — gc must not have started.
    expect(gcRan).toBe(false);
    expect(gate.isExclusiveHeld).toBe(false);
    hold.resolve();
    await gc;
    expect(gcRan).toBe(true);
    await mutator;
  });

  test('mutators queue while exclusive holds, run after release', async () => {
    const gate = new ShadowOpGate();
    const gcHold = deferred();
    let mutatorRan = false;
    const gc = gate.withExclusive(() => gcHold.promise);
    await tick();
    expect(gate.isExclusiveHeld).toBe(true);
    const mutator = gate.withMutator(async () => {
      mutatorRan = true;
    });
    await tick();
    // gc still holds — the mutator must be queued, not running.
    expect(mutatorRan).toBe(false);
    gcHold.resolve();
    await gc;
    await mutator;
    expect(mutatorRan).toBe(true);
  });

  test('new top-level mutator is not blocked by a waiting (not holding) exclusive', async () => {
    const gate = new ShadowOpGate();
    const mutatorHold = deferred();
    const firstMutator = gate.withMutator(() => mutatorHold.promise);
    await tick();
    let gcRan = false;
    const gc = gate.withExclusive(async () => {
      gcRan = true;
    });
    await tick();
    expect(gate.isExclusiveHeld).toBe(false); // gc is waiting, not holding
    let newMutatorRan = false;
    const newMutator = gate.withMutator(async () => {
      newMutatorRan = true;
    });
    await tick();
    // No barging: the new top-level mutator must NOT queue behind the waiting gc.
    expect(newMutatorRan).toBe(true);
    mutatorHold.resolve();
    await Promise.all([firstMutator, newMutator, gc]);
    expect(gcRan).toBe(true);
  });

  test('nested mutator holds never deadlock against a waiting exclusive', async () => {
    const gate = new ShadowOpGate();
    const outerHold = deferred();
    let innerRan = false;
    const outer = gate.withMutator(async () => {
      await outerHold.promise;
      // Nested acquisition while an exclusive is WAITING (not holding): must be
      // granted immediately — a pending exclusive does not block new mutators.
      await gate.withMutator(async () => {
        innerRan = true;
      });
    });
    await tick();
    let gcRan = false;
    const gc = gate.withExclusive(async () => {
      gcRan = true;
    });
    await tick();
    expect(gcRan).toBe(false); // waiting for the outer mutator to drain
    outerHold.resolve();
    await outer;
    expect(innerRan).toBe(true);
    await gc;
    expect(gcRan).toBe(true);
  });

  test('exclusives serialize against each other', async () => {
    const gate = new ShadowOpGate();
    const firstHold = deferred();
    const order: string[] = [];
    const first = gate.withExclusive(async () => {
      order.push('first-start');
      await firstHold.promise;
      order.push('first-end');
    });
    await tick();
    const second = gate.withExclusive(async () => {
      order.push('second-start');
    });
    await tick();
    expect(order).toEqual(['first-start']);
    firstHold.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  test('two exclusives queued behind one mutator still serialize', async () => {
    const gate = new ShadowOpGate();
    const mutatorHold = deferred();
    const firstHold = deferred();
    const order: string[] = [];
    const mutator = gate.withMutator(() => mutatorHold.promise);
    await tick();
    // Both exclusives now wait on the SAME drain event.
    const first = gate.withExclusive(async () => {
      order.push('first-start');
      await firstHold.promise;
      order.push('first-end');
    });
    const second = gate.withExclusive(async () => {
      order.push('second-start');
    });
    await tick();
    expect(order).toEqual([]);
    mutatorHold.resolve();
    await mutator;
    await tick();
    // Exactly one exclusive acquired; the other re-queued behind it.
    expect(order).toEqual(['first-start']);
    firstHold.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  test('mutator errors release the hold (exclusive still proceeds)', async () => {
    const gate = new ShadowOpGate();
    await expect(
      gate.withMutator(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(gate.activeMutators).toBe(0);
    let gcRan = false;
    await gate.withExclusive(async () => {
      gcRan = true;
    });
    expect(gcRan).toBe(true);
  });

  test('exclusive errors release the hold (mutators still proceed)', async () => {
    const gate = new ShadowOpGate();
    await expect(
      gate.withExclusive(async () => {
        throw new Error('gc-boom');
      }),
    ).rejects.toThrow('gc-boom');
    expect(gate.isExclusiveHeld).toBe(false);
    let mutatorRan = false;
    await gate.withMutator(async () => {
      mutatorRan = true;
    });
    expect(mutatorRan).toBe(true);
  });

  test('registry: same gitDir shares one gate; release drops it', () => {
    const a = shadowOpGateFor({ gitDir: '/tmp/gate-test-a' });
    const b = shadowOpGateFor({ gitDir: '/tmp/gate-test-a' });
    const c = shadowOpGateFor({ gitDir: '/tmp/gate-test-c' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    releaseShadowOpGate('/tmp/gate-test-a');
    expect(shadowOpGateFor({ gitDir: '/tmp/gate-test-a' })).not.toBe(a);
    releaseShadowOpGate('/tmp/gate-test-a');
    releaseShadowOpGate('/tmp/gate-test-c');
  });
});
