/**
 * The raw-byte fixed-point comparand, pinned on the arm the pure-B suites
 * cannot reach: a drain where Observer A runs BEFORE Observer B.
 *
 * The fixed point is defined as "the settled Y.Text raw-equals the fragment's
 * canonical serialization" — the termination signal that resets the oscillation
 * run and releases a backstop freeze — and the release is owed to the next
 * fixed-point-REACHING drain. Observer A refreshes the RAW witness from `ytext`
 * at every settlement and then enqueues a same-drain Observer B when the
 * settlement is split-brain, so on that arm the raw witness and Observer B's
 * `ytext.toString()` are the same string by construction. Testing the fixed
 * point against the raw witness there is a tautology: the non-converged drain
 * declares convergence, clears the oscillation ring, and unfreezes a live
 * backstop — which lets the very loop the backstop just froze start over.
 *
 * The dual-CRDT drain below is the reachable shape: one external transaction
 * mutates both CRDTs, Observer A routes the Path-B merge and settles
 * residual-bearing, and its split-brain check enqueues Observer B into the same
 * drain.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createBridgeRaceRig } from './bridge-race-rig.test-helper.ts';

// Two normalize-EQUAL, byte-different forms (the trailing whitespace is
// tolerated but stripped by serialize, so neither reaches a raw-byte fixed
// point). Alternating them is the oscillation the backstop bounds.
const CYCLE_FORM_A = '# Cycle\n\nalpha side of the loop   \n';
const CYCLE_FORM_B = '# Cycle\n\nbravo side of the loop   \n';

function driveCycle(
  rig: ReturnType<typeof createBridgeRaceRig>,
  trips: number[],
  untilTripCount: number,
): void {
  for (let i = 0; i < 40 && trips.length < untilTripCount; i++) {
    rig.seedSource(i % 2 === 0 ? CYCLE_FORM_A : CYCLE_FORM_B);
  }
}

describe('raw-byte fixed point on an A-then-B drain', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('a dual-CRDT drain that settles residual-bearing does NOT release a live backstop freeze', () => {
    const trips: number[] = [];
    const rig = createBridgeRaceRig({
      docName: 'ab-comparand.md',
      setupOverrides: { onReDeriveBackstop: (r) => trips.push(r) },
    });
    try {
      driveCycle(rig, trips, 1);
      expect(trips.length).toBe(1);

      // One transaction mutates BOTH CRDTs: Observer A merges (Path B), settles,
      // and its split-brain check enqueues Observer B into the same drain — where
      // the raw witness Observer A just refreshed equals this very `ytext`.
      rig.dualMutation('# Cycle\n\ngamma side of the loop\n', (yt) => {
        yt.insert(yt.length, 'concurrent tail   \n');
      });
      // The drain settled NON-converged: the authoritative bytes and the
      // fragment's canonical form disagree, so this was not a fixed point.
      expect(rig.ytext.toString()).not.toBe(rig.serializeFragment());

      // The freeze must survive it. If the drain had (wrongly) been read as a
      // fixed point, the oscillation ring would be cleared and the B-direction
      // unfrozen — letting the same loop run to a SECOND trip.
      driveCycle(rig, trips, 2);
      expect(trips.length).toBe(1);
    } finally {
      rig.cleanup();
    }
  });

  test('a genuinely converged drain still unfreezes', () => {
    const trips: number[] = [];
    const rig = createBridgeRaceRig({
      docName: 'ab-comparand-converge.md',
      setupOverrides: { onReDeriveBackstop: (r) => trips.push(r) },
    });
    try {
      driveCycle(rig, trips, 1);
      expect(trips.length).toBe(1);

      // A clean WYSIWYG edit: Observer A's Path-A write lands the canonical
      // serialization into Y.Text, so the drain reaches a true raw-byte fixed
      // point and the freeze lifts — the stricter comparand must not block
      // legitimate recovery.
      rig.editFragment('# Recovered\n\nwysiwyg edit converges the doc\n');
      expect(rig.ytext.toString()).toContain('wysiwyg edit converges the doc');

      rig.seedSource('# After\n\nsource edit re-derives after the unfreeze\n');
      expect(rig.serializeFragment()).toContain('source edit re-derives after the unfreeze');
    } finally {
      rig.cleanup();
    }
  });
});
