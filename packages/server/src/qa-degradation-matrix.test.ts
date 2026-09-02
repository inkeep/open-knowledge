import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as Y from 'yjs';
import { createBridgeDeriveLossReporter } from './bridge-loss-detector.ts';
import { type BridgeRaceRig, createBridgeRaceRig } from './bridge-race-rig.test-helper.ts';
import type { LossCaptureEventInput } from './loss-capture.ts';
import {
  createWiredPreDrainRig,
  WIRED_PENDING_LINE,
  type WiredPreDrainRig,
} from './pre-drain-wired.test-helper.ts';
import type { SetupServerObserversOpts } from './server-observers.ts';

const GEN1 =
  '## Guide\n\nIntro paragraph.\n\n<Steps>\n\n<Step>\n\nStep one bod\n\n</Step>\n\n</Steps>\n';
const PENDING_LINE = 'Step one body.';
const STALE_LINE = 'Step one bod';

const APPLY_BASE = '# Title\n\nLine one\n\nLine two\n';
const APPLY_GROWN = '# Title\n\nLine one\n\nLine two\n\nLine three\n';
const APPLY_DROP_TARGET = 'Line two';

const CYCLE_FORM_A = '# Cycle\n\nalpha side of the loop   \n';
const CYCLE_FORM_B = '# Cycle\n\nbravo side of the loop   \n';
const POST_LOOP_SOURCE_EDIT = 'a source edit after the loop';

function stageUnpropagatedKeystroke(rig: BridgeRaceRig): void {
  rig.editFragment(GEN1);
  rig.settle(1);
  rig.externalYtextEdit('poke', (yt) => yt.insert(yt.length, '\nTrailing.\n'));
  rig.echoFragmentEdit(rig.ytext.toString(), STALE_LINE, PENDING_LINE, {
    advanceFreshness: false,
  });
}

function sourceWrite(rig: BridgeRaceRig, text: string): void {
  rig.externalYtextEdit('source-write', (yt) => yt.insert(yt.length, `\n${text}\n`), {
    advanceFreshness: false,
  });
}

function rigWithRing(
  docName: string,
  overrides: Partial<SetupServerObserversOpts>,
): { rig: BridgeRaceRig; recorded: LossCaptureEventInput[] } {
  const recorded: LossCaptureEventInput[] = [];
  const rig = createBridgeRaceRig({
    docName,
    setupOverrides: {
      lossRing: {
        record: async (input) => {
          recorded.push(input);
        },
      },
      ...overrides,
    },
  });
  return { rig, recorded };
}

function makeApplyDropInjector(target: string): {
  inject: (yt: Y.Text) => void;
  fired: () => boolean;
} {
  let fired = false;
  return {
    inject: (yt) => {
      if (fired) return;
      const idx = yt.toString().indexOf(target);
      if (idx < 0) return;
      yt.delete(idx, target.length);
      fired = true;
    },
    fired: () => fired,
  };
}

function driveApplyArmDrop(rig: BridgeRaceRig): void {
  rig.editFragment(APPLY_BASE);
  rig.settle(1);
  rig.editFragment(APPLY_GROWN);
}

function driveOscillation(rig: BridgeRaceRig): void {
  for (let i = 0; i < 24; i++) rig.seedSource(i % 2 === 0 ? CYCLE_FORM_A : CYCLE_FORM_B);
}

async function wiredRigWithFloor(
  docName: string,
  overrides: Partial<SetupServerObserversOpts>,
): Promise<{ rig: WiredPreDrainRig; recorded: LossCaptureEventInput[] }> {
  const recorded: LossCaptureEventInput[] = [];
  const reporter = createBridgeDeriveLossReporter({
    shadow: () => undefined,
    ring: {
      record: async (input) => {
        recorded.push(input);
      },
    },
    getBranch: () => 'main',
    contentRoot: '',
  });
  const rig = await createWiredPreDrainRig({ docName, reporter, setupOverrides: overrides });
  return { rig, recorded };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('single-mechanism-OFF degradation', () => {
  test('defer guard ON: the keystroke is PREVENTED from being lost and the ring says so', () => {
    const { rig, recorded } = rigWithRing('degrade-guard-on', {});
    try {
      stageUnpropagatedKeystroke(rig);
      sourceWrite(rig, 'Another source line.');

      expect(rig.serializeFragment()).toContain(PENDING_LINE);
      expect(recorded.some((e) => e.event === 'guard-defer')).toBe(true);
    } finally {
      rig.cleanup();
    }
  });

  test('defer guard OFF: the stomp reproduces and, on the non-paired path, is NOT observed', () => {
    const { rig, recorded } = rigWithRing('degrade-guard-off', { deferGuardEnabled: false });
    try {
      stageUnpropagatedKeystroke(rig);
      sourceWrite(rig, 'Another source line.');

      expect(rig.serializeFragment()).not.toContain(PENDING_LINE);
      expect(recorded.some((e) => e.event === 'guard-defer')).toBe(false);
      expect(recorded).toEqual([]);
    } finally {
      rig.cleanup();
    }
  });

  test('loss detector ON: an Observer-A apply-arm drop trips it and the ring carries the shape', () => {
    const injector = makeApplyDropInjector(APPLY_DROP_TARGET);
    const { rig, recorded } = rigWithRing('degrade-detector-on', {
      __testApplyLossInjector: injector.inject,
    });
    try {
      driveApplyArmDrop(rig);

      expect(injector.fired()).toBe(true);
      const trip = recorded.find((e) => e.event === 'detector-trip');
      expect(trip?.direction).toBe('a');
      expect(trip?.site).toBe('observer-a-apply');
      expect(trip?.lostLen).toBe(APPLY_DROP_TARGET.length);
      expect(JSON.stringify(trip)).not.toContain(APPLY_DROP_TARGET);
    } finally {
      rig.cleanup();
    }
  });

  test('loss detector OFF: the same apply-arm drop happens and no sibling records it', () => {
    const injector = makeApplyDropInjector(APPLY_DROP_TARGET);
    const { rig, recorded } = rigWithRing('degrade-detector-off', {
      lossDetectorEnabled: false,
      __testApplyLossInjector: injector.inject,
    });
    try {
      driveApplyArmDrop(rig);

      expect(injector.fired()).toBe(true);
      expect(recorded).toEqual([]);
    } finally {
      rig.cleanup();
    }
  });

  test('fixed-point backstop ON: a non-converging loop freezes the B re-derive and the ring says so', () => {
    const { rig, recorded } = rigWithRing('degrade-backstop-on', {});
    try {
      driveOscillation(rig);
      const frozenFragment = rig.serializeFragment();
      rig.seedSource(`# Cycle\n\n${POST_LOOP_SOURCE_EDIT}   \n`);

      const trip = recorded.find((e) => e.event === 'backstop-trip');
      expect(trip?.direction).toBe('b');
      expect(trip?.site).toBe('rederive-backstop');
      expect(rig.serializeFragment()).toBe(frozenFragment);
      expect(rig.ytext.toString()).toContain(POST_LOOP_SOURCE_EDIT);
    } finally {
      rig.cleanup();
    }
  });

  test('fixed-point backstop OFF: the same loop churns unbounded and no sibling records it', () => {
    const { rig, recorded } = rigWithRing('degrade-backstop-off', {
      fixedPointBackstopEnabled: false,
    });
    try {
      driveOscillation(rig);
      rig.seedSource(`# Cycle\n\n${POST_LOOP_SOURCE_EDIT}   \n`);

      expect(rig.serializeFragment()).toContain(POST_LOOP_SOURCE_EDIT);
      expect(recorded).toEqual([]);
    } finally {
      rig.cleanup();
    }
  });

  test('pre-drain ON: the pending keystroke is flushed ahead of the paired write and survives', async () => {
    const { rig, recorded } = await wiredRigWithFloor('degrade-predrain-on', {});
    try {
      rig.stageUnpropagatedKeystroke();
      expect(rig.serializeFragment()).toContain(WIRED_PENDING_LINE);
      expect(rig.ytextString()).not.toContain(WIRED_PENDING_LINE);

      rig.agentWriteWithPreDrain('A fresh agent paragraph.', 'append');

      expect(rig.ytextString()).toContain(WIRED_PENDING_LINE);
      expect(rig.serializeFragment()).toContain(WIRED_PENDING_LINE);
      expect(rig.ytextString()).toContain('A fresh agent paragraph.');
      expect(recorded).toEqual([]);
    } finally {
      await rig.cleanup();
    }
  });

  test('pre-drain OFF: the keystroke is dropped and the paired-intake floor observes it', async () => {
    const { rig, recorded } = await wiredRigWithFloor('degrade-predrain-off', {
      preDrainEnabled: false,
    });
    try {
      rig.stageUnpropagatedKeystroke();
      expect(rig.serializeFragment()).toContain(WIRED_PENDING_LINE);

      rig.agentWriteWithPreDrain('A fresh agent paragraph.', 'append');

      expect(rig.ytextString()).not.toContain(WIRED_PENDING_LINE);
      expect(rig.serializeFragment()).not.toContain(WIRED_PENDING_LINE);
      const trip = recorded.find((e) => e.event === 'detector-trip');
      expect(trip?.direction).toBe('b');
      expect(trip?.site).toBe('agent-write-intake');
      expect(trip?.writerId).toBe('agent-1');
      expect(trip?.lostLen).toBeGreaterThan(0);
      expect(JSON.stringify(trip)).not.toContain(WIRED_PENDING_LINE);
    } finally {
      await rig.cleanup();
    }
  });

  test('loss capture OFF (no ring wired): the guard still acts, only the record is gone', () => {
    const rig = createBridgeRaceRig({ docName: 'degrade-ring-off' });
    try {
      stageUnpropagatedKeystroke(rig);
      sourceWrite(rig, 'Another source line.');

      expect(rig.serializeFragment()).toContain(PENDING_LINE);
    } finally {
      rig.cleanup();
    }
  });
});
