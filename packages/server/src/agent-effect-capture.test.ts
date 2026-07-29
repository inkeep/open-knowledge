/**
 * Effect-capture attribution: the agent-effects row an agent write produces must
 * carry THAT WRITE's delta, under THAT agent's identity.
 *
 * `captureEffect` is armed before the write transact, and the write spine
 * legitimately makes a foreign-origin Y.Text write in between: the pre-drain
 * flush (`agentWritePreDrain`) lands the user's un-propagated keystroke under
 * `OBSERVER_SYNC_ORIGIN` so the compose rides it into the body. An origin-blind
 * one-shot consumes that flush instead — filing the USER's bytes as an agent
 * effect and leaving the agent's real write with no row at all. The observer is
 * therefore keyed on the write's own origin (object identity), and the arming is
 * disposed with the operation so a delta-free write cannot capture a later one.
 */

import { describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { captureEffect, type EffectValue } from './activity-log.ts';
import { applyAgentMarkdownWrite } from './agent-sessions.ts';
import {
  createWiredPreDrainRig,
  WIRED_PENDING_LINE,
  WIRED_STALE_LINE,
} from './pre-drain-wired.test-helper.ts';

const AGENT_ORIGIN = Object.freeze({ source: 'local', context: { origin: 'agent-write' } });
const FOREIGN_ORIGIN = Object.freeze({ source: 'local', context: { origin: 'observer-sync' } });

function effectRows(doc: Y.Doc): EffectValue[] {
  return [...doc.getMap<EffectValue>('agent-effects').values()];
}

describe('captureEffect origin keying', () => {
  test('a foreign-origin write landing between arming and the agent transact is not captured', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('source');
    doc.transact(() => ytext.insert(0, 'seed body\n'), 'setup');

    captureEffect(ytext, 'agent-1', AGENT_ORIGIN, 'seed', 'claude');

    // The pre-drain flush shape: a real Y.Text delete+insert of the USER's
    // un-propagated bytes, under the observer self-origin.
    doc.transact(() => ytext.insert(ytext.length, 'user keystroke\n'), FOREIGN_ORIGIN);
    // The agent's own write.
    doc.transact(() => ytext.insert(ytext.length, 'agent bytes\n'), AGENT_ORIGIN);

    const rows = effectRows(doc);
    expect(rows.length).toBe(1);
    const delta = JSON.stringify(rows[0]?.delta);
    expect(delta).toContain('agent bytes');
    expect(delta).not.toContain('user keystroke');
  });

  test('the disposer disarms a write that produced no delta, so it cannot capture a later one', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText('source');

    // Operation 1: armed, but `composeAgentWrite` declined — no Y.Text delta.
    const dispose = captureEffect(ytext, 'agent-1', AGENT_ORIGIN, 'seed', 'claude');
    dispose();

    // Operation 2 must produce exactly one row, keyed to its OWN arming.
    const dispose2 = captureEffect(ytext, 'agent-1', AGENT_ORIGIN, 'seed', 'claude');
    doc.transact(() => ytext.insert(0, 'second write\n'), AGENT_ORIGIN);
    dispose2();

    const rows = effectRows(doc);
    expect(rows.length).toBe(1);
    expect(JSON.stringify(rows[0]?.delta)).toContain('second write');
  });
});

describe('effect capture across a real pre-drain flush', () => {
  test('the agent-effects row carries the AGENT delta, not the pre-drained user keystroke', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const rig = await createWiredPreDrainRig({ docName: 'effect-attribution.md' });
    try {
      // A pending WYSIWYG keystroke sitting only in the fragment, cross-block
      // from the append seam — the case the pre-drain exists to flush.
      rig.stageUnpropagatedKeystroke();
      expect(rig.serializeFragment()).toContain(WIRED_PENDING_LINE);
      expect(rig.ytextString()).toContain(WIRED_STALE_LINE);
      expect(rig.ytextString()).not.toContain(WIRED_PENDING_LINE);

      // The handler ordering: arm, pre-drain, write, dispose.
      const document = rig.session.dc.document;
      const dispose = captureEffect(
        document.getText('source'),
        rig.session.agentId,
        rig.session.origin,
        'seed',
        'claude',
      );
      try {
        rig.agentWriteWithPreDrain('A fresh agent paragraph.', 'append');
      } finally {
        dispose();
      }

      // The flush happened (the keystroke reached Y.Text) — so the one-shot had a
      // foreign-origin event available to consume.
      expect(rig.ytextString()).toContain(WIRED_PENDING_LINE);

      const rows = effectRows(rig.doc);
      expect(rows.length).toBe(1);
      const row = rows[0];
      expect(row?.sessionId).toBe(rig.session.agentId);
      const delta = JSON.stringify(row?.delta);
      // The agent's own bytes are the effect; the user's flushed keystroke is not.
      expect(delta).toContain('A fresh agent paragraph.');
      expect(delta).not.toContain(WIRED_PENDING_LINE);
    } finally {
      await rig.cleanup();
      vi.useRealTimers();
    }
  });

  test('a declined write leaves no armed observer for the next write on the same session', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const rig = await createWiredPreDrainRig({ docName: 'effect-noop.md' });
    try {
      const document = rig.session.dc.document;
      // An empty append: `composeAgentWrite` declines, so no Y.Text delta lands.
      const disposeNoop = captureEffect(
        document.getText('source'),
        rig.session.agentId,
        rig.session.origin,
      );
      document.transact(() => {
        applyAgentMarkdownWrite(document, '', 'append');
      }, rig.session.origin);
      disposeNoop();
      expect(effectRows(rig.doc).length).toBe(0);

      const dispose = captureEffect(
        document.getText('source'),
        rig.session.agentId,
        rig.session.origin,
      );
      rig.agentWrite('Real content.', 'append');
      dispose();

      // Exactly one row — the stale arming did not double-file the real write.
      expect(effectRows(rig.doc).length).toBe(1);
    } finally {
      await rig.cleanup();
      vi.useRealTimers();
    }
  });
});
