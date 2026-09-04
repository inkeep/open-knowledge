import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { type BridgeRaceRig, createBridgeRaceRig } from './bridge-race-rig.test-helper.ts';
import type { LossCaptureEventInput } from './loss-capture.ts';

const GEN1 =
  '## Guide\n\nIntro paragraph.\n\n<Steps>\n\n<Step>\n\nStep one bod\n\n</Step>\n\n</Steps>\n';
const PENDING_LINE = 'Step one body.';
const STALE_LINE = 'Step one bod';

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

      const typed = rig.serializeFragment().replace('Intro paragraph.', 'Intro paragraph typed.');
      expect(typed).toContain(PENDING_LINE);
      rig.editFragment(typed);

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
      rig.editFragment(GEN1);
      rig.settle(2);
      expect(rig.ytext.toString()).toContain(STALE_LINE);
      sourceWrite(rig, 'New source paragraph.');
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
      sourceWrite(rig, 'Divergent source content.');
      expect(rig.serializeFragment()).toContain('Divergent source content.');
      expect(deferCount).toBe(0);
    } finally {
      rig.cleanup();
    }
  });
});
