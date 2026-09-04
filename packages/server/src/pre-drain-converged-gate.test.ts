import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { createBridgeRaceRig } from './bridge-race-rig.test-helper.ts';
import { getPreDrainController } from './server-observers.ts';

const BASE = '# Guide\n\nIntro paragraph.\n\nSecond paragraph.\n';

function localClock(doc: Y.Doc): number {
  return Y.decodeStateVector(Y.encodeStateVector(doc)).get(doc.clientID) ?? 0;
}

describe('pre-drain already-converged gate', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('a stale dirty flag over a converged doc skips instead of splicing identity bytes', () => {
    const rig = createBridgeRaceRig({ docName: 'converged-gate.md' });
    try {
      rig.seedSource(BASE);
      rig.settle(1);

      rig.externalYtextEdit('poke', (yt) => yt.insert(yt.length, '\nTrailing note.\n'));
      rig.forceARound({ advanceFreshness: false });

      const bytesBefore = rig.ytext.toString();
      const clockBefore = localClock(rig.doc);

      const verdict = getPreDrainController(rig.doc)?.preDrain({
        kind: 'agent-write',
        composedBody: `${bytesBefore}\nAgent appended paragraph.\n`,
        writeKind: 'append',
      });

      expect(verdict?.preDrain).toBe(false);
      expect(verdict?.reason).toBe('skip-already-converged');
      expect(rig.ytext.toString()).toBe(bytesBefore);
      expect(localClock(rig.doc)).toBe(clockBefore);
    } finally {
      rig.cleanup();
    }
  });

  test('a genuinely pending keystroke still flushes', () => {
    const rig = createBridgeRaceRig({ docName: 'converged-gate-live.md' });
    try {
      const componentBase =
        '## Guide\n\n<Steps>\n\n<Step>\n\nStep one bod\n\n</Step>\n\n</Steps>\n\nTail paragraph.\n';
      rig.editFragment(componentBase);
      rig.settle(1);

      rig.externalYtextEdit('poke', (yt) => yt.insert(yt.length, '\nTrailing note.\n'));
      rig.echoFragmentEdit(rig.ytext.toString(), 'Step one bod', 'Step one body.', {
        advanceFreshness: false,
      });
      expect(rig.ytext.toString()).not.toContain('Step one body.');

      const verdict = getPreDrainController(rig.doc)?.preDrain({
        kind: 'agent-write',
        composedBody: `${rig.ytext.toString()}\nAgent appended paragraph.\n`,
        writeKind: 'append',
      });

      expect(verdict?.preDrain).toBe(true);
      expect(rig.ytext.toString()).toContain('Step one body.');
    } finally {
      rig.cleanup();
    }
  });
});
