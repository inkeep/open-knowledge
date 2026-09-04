import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { type BridgeRaceRig, createBridgeRaceRig } from './bridge-race-rig.test-helper.ts';
import { getMetrics } from './metrics.ts';
import {
  createWiredPreDrainRig,
  WIRED_PENDING_LINE,
  WIRED_STALE_LINE,
} from './pre-drain-wired.test-helper.ts';

function count(hay: string, needle: string): number {
  if (needle === '') return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

const GEN1 =
  '## Guide\n\nIntro paragraph.\n\n<Steps>\n\n<Step>\n\nStep one bod\n\n</Step>\n\n</Steps>\n';
const PENDING_LINE = 'Step one body.';
const STALE_LINE = 'Step one bod';
const MAX_DRAINS = 30;

function stageUnpropagatedKeystroke(rig: BridgeRaceRig): void {
  rig.editFragment(GEN1);
  rig.settle(1);
  rig.externalYtextEdit('poke', (yt) => yt.insert(yt.length, '\nTrailing.\n'));
  rig.echoFragmentEdit(rig.ytext.toString(), STALE_LINE, PENDING_LINE, { advanceFreshness: false });
}
function sourceWrite(rig: BridgeRaceRig, text: string): void {
  rig.externalYtextEdit('source-write', (yt) => yt.insert(yt.length, `\n${text}\n`), {
    advanceFreshness: false,
  });
}

describe('QA-004: D2 force-resolve produces NO duplicated span (occurrence-count oracle)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  test('PENDING_LINE occurrence count is never >=2 at ANY window; dropped-and-checkpointed at force-resolve, never doubled', () => {
    const rig = createBridgeRaceRig({ docName: 'qa004-count.md' });
    const before = getMetrics().deriveTimingDeferForceResolved;
    try {
      stageUnpropagatedKeystroke(rig);

      let forced = false;
      let maxFragCount = 0;
      let maxYtextCount = 0;
      for (let i = 0; i < MAX_DRAINS && !forced; i++) {
        const frag = rig.serializeFragment();
        const yt = rig.ytext.toString();
        const fc = count(frag, PENDING_LINE);
        const yc = count(yt, PENDING_LINE);
        maxFragCount = Math.max(maxFragCount, fc);
        maxYtextCount = Math.max(maxYtextCount, yc);
        expect(fc).toBeLessThanOrEqual(1);
        expect(yc).toBeLessThanOrEqual(1);
        expect(count(frag, 'Intro paragraph.')).toBe(1);
        sourceWrite(rig, `trailing-${i}`);
        forced = getMetrics().deriveTimingDeferForceResolved > before;
      }
      expect(forced).toBe(true);

      const fragAfter = rig.serializeFragment();
      const ytAfter = rig.ytext.toString();
      expect(count(fragAfter, PENDING_LINE)).toBe(0);
      expect(count(ytAfter, PENDING_LINE)).toBe(0);
      expect(count(fragAfter, 'Intro paragraph.')).toBe(1);
      expect(getMetrics().deriveTimingDeferForceResolved).toBe(before + 1);

      console.log(
        `[QA-004] max fragCount=${maxFragCount} max ytextCount=${maxYtextCount} (both must be <=1); post-resolve fragCount=${count(fragAfter, PENDING_LINE)}`,
      );
    } finally {
      rig.cleanup();
    }
  });
});

describe('QA-005: D4 backstop freeze mutates NOTHING system-authored (raw-granularity oracle)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  const tableA = '| a | alpha |\n| - | - |\n| 1 | 2 |   \n';
  const tableB = '| a | bravo |\n| - | - |\n| 1 | 2 |   \n';

  test('across the freeze window with NO input, Y.Text raw bytes AND raw fragment structure are byte-identical (not just canonical md)', () => {
    const trips: number[] = [];
    const rig = createBridgeRaceRig({
      docName: 'qa005-freeze-noinput.md',
      setupOverrides: { onReDeriveBackstop: (r) => trips.push(r) },
    });
    try {
      for (let i = 0; i < 24 && trips.length === 0; i++)
        rig.seedSource(i % 2 === 0 ? tableA : tableB);
      expect(trips.length).toBe(1);

      const ytextRaw0 = rig.ytext.toString();
      const fragRaw0 = rig.xmlFragment.toString();
      const fragMd0 = rig.serializeFragment();

      for (let i = 0; i < 6; i++) {
        rig.forceARound({ advanceFreshness: false });
        expect(rig.ytext.toString()).toBe(ytextRaw0);
        expect(rig.xmlFragment.toString()).toBe(fragRaw0);
        expect(rig.serializeFragment()).toBe(fragMd0);
      }
      console.log('[QA-005] no-input freeze: ytext + RAW fragment byte-stable across 6 rounds');
    } finally {
      rig.cleanup();
    }
  });

  test('typing during the freeze: the ONLY Y.Text delta is the authored keystrokes; raw fragment stays frozen (B not re-derived)', () => {
    const trips: number[] = [];
    const rig = createBridgeRaceRig({
      docName: 'qa005-freeze-typing.md',
      setupOverrides: { onReDeriveBackstop: (r) => trips.push(r) },
    });
    try {
      for (let i = 0; i < 24 && trips.length === 0; i++)
        rig.seedSource(i % 2 === 0 ? tableA : tableB);
      expect(trips.length).toBe(1);

      const ytextRaw0 = rig.ytext.toString();
      const fragRaw0 = rig.xmlFragment.toString();

      const AUTHORED = 'USER_TYPED_DURING_FREEZE';
      rig.externalYtextEdit('type', (yt) => yt.insert(yt.length, `\n${AUTHORED}\n`), {
        advanceFreshness: false,
      });

      const ytextRaw1 = rig.ytext.toString();
      expect(ytextRaw1).toBe(`${ytextRaw0}\n${AUTHORED}\n`);
      expect(count(ytextRaw1, AUTHORED)).toBe(1);
      expect(rig.xmlFragment.toString()).toBe(fragRaw0);
      console.log(
        '[QA-005] typing-during-freeze: only authored delta in Y.Text; raw fragment frozen',
      );
    } finally {
      rig.cleanup();
    }
  });
});

describe('QA-006: D15 pre-drain applies the pending keystroke exactly ONCE (occurrence-count oracle)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  test('CROSS-BLOCK undo: keystroke count===1 in Y.Text AND fragment after the paired op AND after the next natural drain', async () => {
    const rig = await createWiredPreDrainRig({ docName: 'qa006-undo.md' });
    try {
      rig.agentWrite('Agent appended line.', 'append');
      rig.stageUnpropagatedKeystroke();
      expect(count(rig.serializeFragment(), WIRED_PENDING_LINE)).toBe(1);
      expect(count(rig.ytextString(), WIRED_PENDING_LINE)).toBe(0);

      const undone = rig.agentUndo('last');
      expect(undone).toBe(true);

      expect(count(rig.ytextString(), WIRED_PENDING_LINE)).toBe(1);
      expect(count(rig.serializeFragment(), WIRED_PENDING_LINE)).toBe(1);
      expect(count(rig.ytextString(), 'Agent appended line.')).toBe(0);
      expect(count(rig.serializeFragment(), 'Agent appended line.')).toBe(0);

      rig.agentWrite('Second agent line.', 'append');
      expect(count(rig.ytextString(), WIRED_PENDING_LINE)).toBe(1);
      expect(count(rig.serializeFragment(), WIRED_PENDING_LINE)).toBe(1);
      expect(count(rig.ytextString(), WIRED_STALE_LINE)).toBe(1);
      console.log('[QA-006] cross-block undo: keystroke count===1 post-op AND post-natural-drain');
    } finally {
      await rig.cleanup();
    }
  });

  test('CROSS-BLOCK append: keystroke count===1 in Y.Text AND fragment after the paired op AND after a further drain', async () => {
    const rig = await createWiredPreDrainRig({ docName: 'qa006-append.md' });
    try {
      rig.stageUnpropagatedKeystroke();
      expect(count(rig.serializeFragment(), WIRED_PENDING_LINE)).toBe(1);

      rig.agentWriteWithPreDrain('A fresh agent paragraph.', 'append');
      expect(count(rig.ytextString(), WIRED_PENDING_LINE)).toBe(1);
      expect(count(rig.serializeFragment(), WIRED_PENDING_LINE)).toBe(1);
      expect(count(rig.ytextString(), 'A fresh agent paragraph.')).toBe(1);

      rig.agentWrite('Another paragraph.', 'append');
      expect(count(rig.ytextString(), WIRED_PENDING_LINE)).toBe(1);
      expect(count(rig.serializeFragment(), WIRED_PENDING_LINE)).toBe(1);
      console.log(
        '[QA-006] cross-block append: keystroke count===1 post-op AND post-further-drain',
      );
    } finally {
      await rig.cleanup();
    }
  });
});
