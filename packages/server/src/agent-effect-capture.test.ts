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

    doc.transact(() => ytext.insert(ytext.length, 'user keystroke\n'), FOREIGN_ORIGIN);
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

    const dispose = captureEffect(ytext, 'agent-1', AGENT_ORIGIN, 'seed', 'claude');
    dispose();

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
      rig.stageUnpropagatedKeystroke();
      expect(rig.serializeFragment()).toContain(WIRED_PENDING_LINE);
      expect(rig.ytextString()).toContain(WIRED_STALE_LINE);
      expect(rig.ytextString()).not.toContain(WIRED_PENDING_LINE);

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

      expect(rig.ytextString()).toContain(WIRED_PENDING_LINE);

      const rows = effectRows(rig.doc);
      expect(rows.length).toBe(1);
      const row = rows[0];
      expect(row?.sessionId).toBe(rig.session.agentId);
      const delta = JSON.stringify(row?.delta);
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

      expect(effectRows(rig.doc).length).toBe(1);
    } finally {
      await rig.cleanup();
      vi.useRealTimers();
    }
  });
});
