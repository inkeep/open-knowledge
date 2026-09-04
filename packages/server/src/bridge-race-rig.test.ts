import {
  MarkdownManager,
  type SerializeCallOptions,
  sharedExtensions,
} from '@inkeep/open-knowledge-core';
import type { JSONContent } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { type BridgeRaceRig, createBridgeRaceRig } from './bridge-race-rig.test-helper.ts';

function makeRecordingManager(): {
  manager: MarkdownManager;
  serializeOpts: Array<SerializeCallOptions | undefined>;
} {
  const real = new MarkdownManager({
    extensions: sharedExtensions,
    deriveStructuralFreshness: true,
  });
  const serializeOpts: Array<SerializeCallOptions | undefined> = [];
  const manager = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'serialize') {
        return (json: JSONContent, opts?: SerializeCallOptions) => {
          serializeOpts.push(opts);
          return target.serialize(json, opts);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { manager, serializeOpts };
}

describe('bridge-race rig — H1 substrate', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function driveScenario(): BridgeRaceRig {
    const rig = createBridgeRaceRig({ docName: 'race-rig-smoke.md' });
    rig.seedSource('# Doc\n\nOriginal body.\n');
    rig.editFragment('# Doc\n\nOriginal body.\n\nWysiwyg paragraph.\n');
    rig.dualMutation('# Doc\n\nOriginal body.\n\nWysiwyg paragraph two.\n', (yt) =>
      yt.insert(yt.length, 'Source tail.\n'),
    );
    rig.churnedFragmentEdit(
      '# Doc\n\nOriginal body.\n\nWysiwyg paragraph two.\n\nSource tail.\n\nExtra.\n',
    );
    rig.settle(3);
    return rig;
  }

  test('drives a scripted interleaving to a byte fixed point on the production drain', () => {
    const rig = driveScenario();
    try {
      const tail = rig.trace.slice(-2);
      expect(tail.every((e) => e.dispatches.join(',') === 'a' && e.byteChanged === false)).toBe(
        true,
      );
      const last = rig.trace.at(-1);
      expect(last?.bytes).toContain('Original body.');
      // Both bridge representations agree at rest (Y.Text-is-truth, precedent #38).
      expect(rig.serializeFragment()).toBe(last?.fragmentMd);
    } finally {
      rig.cleanup();
    }
  });

  test('trace is byte-identical across 3 consecutive runs (determinism contract)', () => {
    const runs: string[][] = [];
    for (let i = 0; i < 3; i++) {
      const rig = driveScenario();
      runs.push(rig.traceLines());
      rig.cleanup();
    }
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
    expect(runs[0].length).toBeGreaterThan(4);
  });

  test('the freshness-suppressed Observer A arm is drivable on the rig (P2-1: DRIVABLE)', () => {
    const { manager, serializeOpts } = makeRecordingManager();
    const rig = createBridgeRaceRig({
      docName: 'race-rig-freshness.md',
      setupOverrides: { mdManager: manager },
    });
    try {
      rig.seedSource('# Doc\n\nBody line.\n');
      rig.settle(1);

      let before = serializeOpts.length;
      rig.forceARound();
      const freshCalls = serializeOpts.slice(before);
      expect(freshCalls.some((o) => o?.skipFreshnessDerive === false)).toBe(true);

      rig.externalYtextEdit('external-hot', (yt) => yt.insert(yt.length, 'Typed tail.\n'), {
        advanceFreshness: false,
      });
      before = serializeOpts.length;
      rig.forceARound({ advanceFreshness: false });
      const hotCalls = serializeOpts.slice(before);
      expect(hotCalls.some((o) => o?.skipFreshnessDerive === true)).toBe(true);
    } finally {
      rig.cleanup();
    }
  });
});
