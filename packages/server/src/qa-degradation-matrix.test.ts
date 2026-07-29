/**
 * Cross-mechanism degradation: with one guard switched off, do its siblings
 * still SEE the loss it stopped preventing?
 *
 * The kill-switch suites pin each mechanism's own OFF-inertness — off means the
 * mechanism does nothing. That is a different question from the one an operator
 * asks when they disable a guard in the field: does the loss it was preventing
 * become SILENT, or does a sibling still checkpoint and ring-log it?
 *
 * Each mechanism gets a PAIR of cells over one staging that genuinely reaches
 * it: an ON cell showing the mechanism firing, and an OFF cell showing what an
 * operator is left with. The pair is the binding proof — an OFF cell whose
 * observations match its ON partner would be asserting nothing, so the staging
 * has to put the mechanism on the drain path, not merely set its flag.
 *
 * The matrix answers two different ways, and that asymmetry is the finding:
 * the paired agent-write vector degrades from PREVENTION to OBSERVATION (the
 * paired-intake floor still catches the drop), while the non-paired
 * Observer-B re-derive, the Observer-A apply arm, and the re-derive-loop
 * backstop each degrade to SILENCE — no sibling watches those paths.
 *
 */

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

/** Doc the Observer-A apply arm runs over; `APPLY_DROP_TARGET` is the drop. */
const APPLY_BASE = '# Title\n\nLine one\n\nLine two\n';
const APPLY_GROWN = '# Title\n\nLine one\n\nLine two\n\nLine three\n';
const APPLY_DROP_TARGET = 'Line two';

/**
 * Two non-round-trip source forms that are normalize-EQUAL to their canonical
 * (serialize strips the trailing whitespace, so neither reaches a raw-byte fixed
 * point) yet byte-different from each other. Alternating them revisits a recent
 * state every round without ever converging — a sustained corrective-write loop.
 */
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

/** Build a rig with a recording loss ring plus the caller's overrides. */
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

/**
 * A one-shot Y.Text deletion for the apply-arm seam, plus a `fired` readback.
 * The byte-preserving apply arms never drop content organically, so the drop
 * has to be injected — and the readback is what proves the OFF cell reached the
 * same apply arm the ON cell did, rather than going quiet for some other reason.
 */
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

/** Drive the apply-arm drop: seed, settle, then grow the fragment. */
function driveApplyArmDrop(rig: BridgeRaceRig): void {
  rig.editFragment(APPLY_BASE);
  rig.settle(1);
  rig.editFragment(APPLY_GROWN);
}

/** Drive the non-converging re-derive loop well past the backstop's bound. */
function driveOscillation(rig: BridgeRaceRig): void {
  for (let i = 0; i < 24; i++) rig.seedSource(i % 2 === 0 ? CYCLE_FORM_A : CYCLE_FORM_B);
}

/**
 * Wired pre-drain rig with the paired-intake checkpoint floor attached. The
 * floor is the sibling under test here, so it runs its real detection; passing
 * no shadow keeps it off git and routes its trip straight to the ring.
 */
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

  /**
   * MEASURED, not desired. On a PAIRED vector (agent-write intake) switching the
   * guard off degrades prevention into observation — the paired-intake detector
   * still trips and checkpoints, which `bridge-loss-injection.test.ts` pins with
   * `bridge.deferGuard.enabled: false` in its project config. This is the other
   * half of that matrix, and it does not behave the same way: the stomp here
   * rides a NON-paired Observer-B re-derive (a source-editor Y.Text write), and
   * no sibling mechanism watches that path, so the loss is SILENT — no ring
   * event, no checkpoint.
   *
   * Pinned so the asymmetry is visible: if a future change gives the non-paired
   * path an observer, this expectation must be updated deliberately rather than
   * the gap being rediscovered.
   *
   */
  test('defer guard OFF: the stomp reproduces and, on the non-paired path, is NOT observed', () => {
    const { rig, recorded } = rigWithRing('degrade-guard-off', { deferGuardEnabled: false });
    try {
      stageUnpropagatedKeystroke(rig);
      sourceWrite(rig, 'Another source line.');

      // The loss the guard was preventing now happens.
      expect(rig.serializeFragment()).not.toContain(PENDING_LINE);
      // The guard's own event is necessarily absent — it is switched off.
      expect(recorded.some((e) => e.event === 'guard-defer')).toBe(false);
      // And nothing else picks it up: the degradation is silent here.
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
      // A length and a digest — the ring never carries the dropped bytes.
      expect(trip?.lostLen).toBe(APPLY_DROP_TARGET.length);
      expect(JSON.stringify(trip)).not.toContain(APPLY_DROP_TARGET);
    } finally {
      rig.cleanup();
    }
  });

  /**
   * The apply arm drops the same bytes either way — `fired` is the proof this
   * cell reached the arm rather than going quiet upstream. With the detector
   * off, no sibling covers the Observer-A apply path, so the drop is silent.
   *
   */
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
      // B is frozen: the later source edit does not rebuild the fragment...
      expect(rig.serializeFragment()).toBe(frozenFragment);
      // ...while Y.Text stays authoritative and live.
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

      // Never frozen — the loop the backstop would have bounded keeps
      // re-deriving, and nothing anywhere reports that it ran away.
      expect(rig.serializeFragment()).toContain(POST_LOOP_SOURCE_EDIT);
      expect(recorded).toEqual([]);
    } finally {
      rig.cleanup();
    }
  });

  /**
   * The pre-drain flag is read only inside the controller's `preDrain`, which
   * nothing but `agentWritePreDrain` reaches — so this pair runs the handler
   * shape (pre-drain, then the paired transact) on the wired rig. `append` is
   * used deliberately: `replace` / `patch` are full-body overwrites that decline
   * on position, and a post-defer staging declines on the witness before the
   * position gate, so either would leave the flag inert again.
   *
   */
  test('pre-drain ON: the pending keystroke is flushed ahead of the paired write and survives', async () => {
    const { rig, recorded } = await wiredRigWithFloor('degrade-predrain-on', {});
    try {
      rig.stageUnpropagatedKeystroke();
      expect(rig.serializeFragment()).toContain(WIRED_PENDING_LINE);
      expect(rig.ytextString()).not.toContain(WIRED_PENDING_LINE);

      rig.agentWriteWithPreDrain('A fresh agent paragraph.', 'append');

      // Prevented, not merely observed: the keystroke rode into Y.Text ahead of
      // the paired derive, so the floor had nothing to catch.
      expect(rig.ytextString()).toContain(WIRED_PENDING_LINE);
      expect(rig.serializeFragment()).toContain(WIRED_PENDING_LINE);
      expect(rig.ytextString()).toContain('A fresh agent paragraph.');
      expect(recorded).toEqual([]);
    } finally {
      await rig.cleanup();
    }
  });

  /**
   * The opposite answer from the defer-guard cell above, and the reason this
   * matrix exists: the paired vector degrades from prevention to OBSERVATION.
   * The keystroke is genuinely lost, but the paired-intake floor sees it go and
   * mints a restorable record, so an operator running with pre-drain off is
   * blind to nothing.
   *
   */
  test('pre-drain OFF: the keystroke is dropped and the paired-intake floor observes it', async () => {
    const { rig, recorded } = await wiredRigWithFloor('degrade-predrain-off', {
      preDrainEnabled: false,
    });
    try {
      rig.stageUnpropagatedKeystroke();
      expect(rig.serializeFragment()).toContain(WIRED_PENDING_LINE);

      rig.agentWriteWithPreDrain('A fresh agent paragraph.', 'append');

      // The loss pre-drain was preventing now happens...
      expect(rig.ytextString()).not.toContain(WIRED_PENDING_LINE);
      expect(rig.serializeFragment()).not.toContain(WIRED_PENDING_LINE);
      // ...and a sibling caught it, attributed to the writing agent.
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

  /**
   * Ring absent is the one degradation that IS allowed to be silent — the
   * mechanisms must still act.
   *
   */
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
