/**
 * Derive-timing defer guard — the stomp suite, on the REAL
 * `setupServerObservers` drain via the shared bridge-race rig.
 *
 * The loss class: a WYSIWYG keystroke advances a component's children past its
 * stamped `sourceRaw`, and a freshness-suppressed Observer A settles that drain
 * with stale witnesses, leaving the fragment holding the keystroke while Y.Text
 * lacks it. A subsequent source-editor / non-paired Y.Text write then triggers
 * an Observer B re-derive that rebuilds the fragment from Y.Text and silently
 * discards the keystroke. The guard checks, before rebuilding, whether the
 * fragment holds a line neither Y.Text nor the last convergence had, and defers
 * the re-derive when it does — so the keystroke survives and converges once
 * freshness quiesces, instead of being stomped.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { type BridgeRaceRig, createBridgeRaceRig } from './bridge-race-rig.test-helper.ts';
import type { LossCaptureEventInput } from './loss-capture.ts';

const GEN1 =
  '## Guide\n\nIntro paragraph.\n\n<Steps>\n\n<Step>\n\nStep one bod\n\n</Step>\n\n</Steps>\n';
const PENDING_LINE = 'Step one body.';
const STALE_LINE = 'Step one bod';

/**
 * Leave the fragment holding the pending `PENDING_LINE` while Y.Text still holds
 * `STALE_LINE`, with the settlement witnesses stale — the un-propagated-keystroke
 * shape a drain-shaped re-derive would stomp.
 */
function stageUnpropagatedKeystroke(rig: BridgeRaceRig): void {
  rig.editFragment(GEN1);
  rig.settle(1);
  // Reset the freshness-quiescence clock so the echo drain runs suppressed.
  rig.externalYtextEdit('poke', (yt) => yt.insert(yt.length, '\nTrailing.\n'));
  rig.echoFragmentEdit(rig.ytext.toString(), STALE_LINE, PENDING_LINE, {
    advanceFreshness: false,
  });
}

/** A source-editor / non-paired Y.Text write that triggers an Observer B re-derive. */
function sourceWrite(rig: BridgeRaceRig, text: string): void {
  rig.externalYtextEdit('source-write', (yt) => yt.insert(yt.length, `\n${text}\n`), {
    advanceFreshness: false,
  });
}

describe('derive-timing defer guard (H2)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('an un-propagated WYSIWYG keystroke survives a drain-shaped re-derive', () => {
    const rig = createBridgeRaceRig({ docName: 'defer-survives.md' });
    try {
      stageUnpropagatedKeystroke(rig);
      expect(rig.serializeFragment()).toContain(PENDING_LINE);

      sourceWrite(rig, 'Another source line.');

      // The re-derive deferred: the keystroke is still in the fragment.
      expect(rig.serializeFragment()).toContain(PENDING_LINE);
    } finally {
      rig.cleanup();
    }
  });

  test('with the guard OFF the same drain stomps the keystroke', () => {
    const rig = createBridgeRaceRig({
      docName: 'defer-off.md',
      setupOverrides: { deferGuardEnabled: false },
    });
    try {
      stageUnpropagatedKeystroke(rig);
      expect(rig.serializeFragment()).toContain(PENDING_LINE);

      sourceWrite(rig, 'Another source line.');

      // No guard: the re-derive rebuilt the fragment from stale Y.Text.
      expect(rig.serializeFragment()).not.toContain(PENDING_LINE);
    } finally {
      rig.cleanup();
    }
  });

  test('the guard is default-ON (no explicit flag)', () => {
    const rig = createBridgeRaceRig({ docName: 'defer-default.md' });
    try {
      stageUnpropagatedKeystroke(rig);
      sourceWrite(rig, 'Another source line.');
      expect(rig.serializeFragment()).toContain(PENDING_LINE);
    } finally {
      rig.cleanup();
    }
  });

  test('continued WYSIWYG typing carries the deferred keystroke into Y.Text', () => {
    const rig = createBridgeRaceRig({ docName: 'defer-converge.md' });
    try {
      stageUnpropagatedKeystroke(rig);
      sourceWrite(rig, 'Another source line.');
      expect(rig.ytext.toString()).not.toContain(PENDING_LINE);

      // The user keeps typing in the WYSIWYG: a real fragment write, in a block
      // away from the deferred keystroke, on a freshness-safe drain. The defer
      // left Y.Text past the raw witness, so Observer A routes this through the
      // Path-B three-way merge — which is what has to carry BOTH sides.
      const typed = rig.serializeFragment().replace('Intro paragraph.', 'Intro paragraph typed.');
      expect(typed).toContain(PENDING_LINE);
      rig.editFragment(typed);

      // The fragment's un-propagated keystroke and the freshly typed text both
      // reached Y.Text, and the merge did not drop the Y.Text-side source line.
      expect(rig.ytext.toString()).toContain(PENDING_LINE);
      expect(rig.ytext.toString()).toContain('Intro paragraph typed.');
      expect(rig.ytext.toString()).toContain('Another source line.');
      expect(rig.serializeFragment()).toContain(PENDING_LINE);
    } finally {
      rig.cleanup();
    }
  });

  test('a pure source-editor write near a component does not defer', () => {
    let deferCount = 0;
    const rig = createBridgeRaceRig({
      docName: 'no-false-defer-source.md',
      setupOverrides: {
        onDeriveTimingDefer: () => {
          deferCount += 1;
        },
      },
    });
    try {
      // Converge GEN1 cleanly (fragment and Y.Text agree, no pending content).
      rig.editFragment(GEN1);
      rig.settle(2);
      expect(rig.ytext.toString()).toContain(STALE_LINE);
      // Pure source edit: no fragment change, no pending content.
      sourceWrite(rig, 'New source paragraph.');
      // The re-derive ran (pulled the edit into the fragment); it did not defer.
      expect(rig.serializeFragment()).toContain('New source paragraph.');
      expect(deferCount).toBe(0);
    } finally {
      rig.cleanup();
    }
  });

  test('a Y.Text-only residual (fragment holds less) does not defer', () => {
    let deferCount = 0;
    const rig = createBridgeRaceRig({
      docName: 'no-false-defer-ytext.md',
      setupOverrides: {
        onDeriveTimingDefer: () => {
          deferCount += 1;
        },
      },
    });
    try {
      rig.seedSource('# Title\n\nAlpha paragraph.\n');
      rig.settle(1);
      // Y.Text gains a line the fragment lacks (fragment holds LESS) — the
      // re-derive must run to absorb it, never defer.
      sourceWrite(rig, 'Beta paragraph.');
      expect(rig.serializeFragment()).toContain('Beta paragraph.');
      expect(deferCount).toBe(0);
    } finally {
      rig.cleanup();
    }
  });

  test('a deferring drain does not move the settlement witnesses', () => {
    const snapshots: Array<{ canonicalWitness: string; rawWitness: string }> = [];
    const rig = createBridgeRaceRig({
      docName: 'defer-atomicity.md',
      setupOverrides: {
        onDeriveTimingDefer: (s) => snapshots.push(s),
      },
    });
    try {
      stageUnpropagatedKeystroke(rig);
      // Two in-window source writes each trigger a defer; the witnesses must be
      // byte-identical across both (a deferring drain is not a settlement).
      sourceWrite(rig, 'First trailing.');
      sourceWrite(rig, 'Second trailing.');
      expect(snapshots.length).toBeGreaterThanOrEqual(2);
      expect(snapshots[1]?.canonicalWitness).toBe(snapshots[0]?.canonicalWitness);
      expect(snapshots[1]?.rawWitness).toBe(snapshots[0]?.rawWitness);
    } finally {
      rig.cleanup();
    }
  });

  test('each defer records a distinguishable guard-defer loss-ring event', () => {
    const recorded: LossCaptureEventInput[] = [];
    const rig = createBridgeRaceRig({
      docName: 'defer-ring.md',
      setupOverrides: {
        lossRing: {
          record: async (input) => {
            recorded.push(input);
          },
        },
      },
    });
    try {
      stageUnpropagatedKeystroke(rig);
      sourceWrite(rig, 'Another source line.');
      expect(recorded.length).toBeGreaterThanOrEqual(1);
      const evt = recorded[0];
      expect(evt?.event).toBe('guard-defer');
      expect(evt?.docName).toBe('defer-ring.md');
      expect(evt?.direction).toBe('b');
      // Content-free: only a byte length is carried, never the bytes.
      expect(typeof evt?.lostLen).toBe('number');
      expect(JSON.stringify(evt)).not.toContain(PENDING_LINE);
    } finally {
      rig.cleanup();
    }
  });

  test('a Y.Text-ahead divergence re-derives (does not defer) — direction-aware', () => {
    let deferCount = 0;
    const rig = createBridgeRaceRig({
      docName: 'direction-aware.md',
      setupOverrides: {
        onDeriveTimingDefer: () => {
          deferCount += 1;
        },
      },
    });
    try {
      rig.editFragment(GEN1);
      rig.settle(2);
      // Y.Text diverges ahead of the fragment (a source-mode edit that adds
      // content the fragment lacks). Observer B must re-derive to pull it in.
      sourceWrite(rig, 'Divergent source content.');
      expect(rig.serializeFragment()).toContain('Divergent source content.');
      expect(deferCount).toBe(0);
    } finally {
      rig.cleanup();
    }
  });
});
