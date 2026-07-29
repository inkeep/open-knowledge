/**
 * The pre-drain flushes CONTENT, never nothing.
 *
 * `fragmentMutatedSinceConverge` says the fragment MOVED since the last
 * convergence — not that anything is still un-propagated. A freshness-suppressed
 * Observer-A drain that nonetheless propagated everything leaves that flag set
 * over a fully-converged document. The splice model then returns the trailing
 * region of two structurally-identical bodies, and applying it is a delete +
 * insert of the bytes already there: byte-neutral, but real CRDT tombstone and
 * struct churn on the user's live document, replicated to every peer, for no
 * content gain.
 *
 * Byte equality cannot see that — the assertion has to be on the CRDT clock.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { createBridgeRaceRig } from './bridge-race-rig.test-helper.ts';
import { getPreDrainController } from './server-observers.ts';

const BASE = '# Guide\n\nIntro paragraph.\n\nSecond paragraph.\n';

/** The local client's Yjs clock — advances on every struct this doc creates. */
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

      // Freshness-hot window + a byte-neutral fragment mutation: Observer A runs
      // freshness-SUPPRESSED, so it does not clear the convergence flag even
      // though nothing is left un-propagated.
      rig.externalYtextEdit('poke', (yt) => yt.insert(yt.length, '\nTrailing note.\n'));
      rig.forceARound({ advanceFreshness: false });

      const bytesBefore = rig.ytext.toString();
      const clockBefore = localClock(rig.doc);

      const verdict = getPreDrainController(rig.doc)?.preDrain({
        kind: 'agent-write',
        composedBody: `${bytesBefore}\nAgent appended paragraph.\n`,
        writeKind: 'append',
      });

      // Nothing to flush: the drain's modelled rewrite replaces the region with
      // the bytes already there.
      expect(verdict?.preDrain).toBe(false);
      expect(verdict?.reason).toBe('skip-already-converged');
      // ...and no struct was created on the user's document.
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

      // The un-propagated-keystroke shape: the fragment advances past its
      // stamped source while a recent external write keeps freshness hot.
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

      // The gate must not swallow a real flush.
      expect(verdict?.preDrain).toBe(true);
      expect(rig.ytext.toString()).toContain('Step one body.');
    } finally {
      rig.cleanup();
    }
  });
});
