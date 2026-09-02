import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createBridgeRaceRig } from './bridge-race-rig.test-helper.ts';

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

      rig.dualMutation('# Cycle\n\ngamma side of the loop\n', (yt) => {
        yt.insert(yt.length, 'concurrent tail   \n');
      });
      expect(rig.ytext.toString()).not.toBe(rig.serializeFragment());

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

      rig.editFragment('# Recovered\n\nwysiwyg edit converges the doc\n');
      expect(rig.ytext.toString()).toContain('wysiwyg edit converges the doc');

      rig.seedSource('# After\n\nsource edit re-derives after the unfreeze\n');
      expect(rig.serializeFragment()).toContain('source edit re-derives after the unfreeze');
    } finally {
      rig.cleanup();
    }
  });
});
