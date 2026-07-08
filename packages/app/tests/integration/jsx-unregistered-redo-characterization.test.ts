/**
 * Redo reachability at the bridge rung, on an unregistered-component doc.
 *
 * The agent API is undo-only; there is no redo product surface. This test
 * executes the real `applyAgentUndo` and then characterizes what the underlying
 * Y.UndoManager redo stack looks like — a gap the existing undo round-trip test
 * leaves open (it asserts undo, never touches redo).
 *
 * Observed and PINNED here: after a real agent-undo the redo stack is EMPTY, so
 * redo is structurally unreachable at this rung. The reason is architectural,
 * not a settle race: `applyAgentUndo` wraps `um.undo()` in an outer
 * `document.transact(fn, session.undoOrigin)` so Observer A/B short-circuit on
 * the paired write. Y.js merges the UndoManager's own nested undo transaction
 * into that outer one, so the inverse fires under `undoOrigin` instead of the
 * UndoManager instance — and the UndoManager only captures a redo entry when the
 * transaction origin is itself. The paired-write wrapping that undo needs is
 * exactly what prevents redo capture.
 *
 * This is a characterization of current reality, not a bug fix — no redo surface
 * exists to regress. If a redo product surface is ever added it cannot naively
 * call `um.redo()`; that is the finding this test records.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import { normalizeBridge } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import {
  agentUndo,
  agentWriteMd,
  assertBridgeInvariant,
  createTestServer,
  type TestServer,
} from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

// <Steps>/<Step> are unregistered component names (registry.has() is false), so
// this doc exercises the wildcard/unregistered class through the undo bridge.
const SEED = [
  '<Steps>',
  '',
  '<Step>',
  '',
  'STEP-ONE-BODY first.',
  '',
  '</Step>',
  '',
  '<Step>',
  '',
  'STEP-TWO-BODY second.',
  '',
  '</Step>',
  '',
  '</Steps>',
  '',
].join('\n');

const STEP_MARKERS = ['STEP-ONE-BODY', 'STEP-TWO-BODY'];

describe('redo at the bridge rung on an unregistered-component doc', () => {
  test('after a real agent-undo the redo stack is empty and redo does not restore the edit', async () => {
    const docName = `redo-jsx-${crypto.randomUUID()}`;
    const agentSuffix = `redo-${crypto.randomUUID().slice(0, 8)}`;
    const connectionId = `agent-${agentSuffix}`;
    const sm = server.instance.sessionManager;
    try {
      await agentWriteMd(server.port, SEED, {
        docName,
        agentId: agentSuffix,
        agentName: `A-${agentSuffix}`,
        position: 'replace',
      });
      await wait(600);

      const sess = await sm.getSession(docName, connectionId);
      const ytext = sess.dc.document.getText('source');
      const preEdit = ytext.toString();
      for (const m of STEP_MARKERS) expect(preEdit).toContain(m);

      // Undoable edit as a distinct StackItem (spaced past the 500ms capture window).
      await agentWriteMd(server.port, '\n\nREDO-CHAR-EDIT paragraph.\n', {
        docName,
        agentId: agentSuffix,
        agentName: `A-${agentSuffix}`,
        position: 'append',
      });
      await wait(600);
      expect(ytext.toString()).toContain('REDO-CHAR-EDIT');

      // Real undo of the last burst — round-trips the source to the pre-edit state.
      await agentUndo(server.port, { docName, connectionId, scope: 'last' });
      await wait(400);
      const afterUndo = ytext.toString();
      expect(afterUndo).not.toContain('REDO-CHAR-EDIT');
      expect(normalizeBridge(afterUndo)).toBe(normalizeBridge(preEdit));

      // Characterization: the paired-write undo leaves NO redo entry, so redo is
      // structurally unreachable — an undo remains on the stack, but nothing to redo.
      expect(sess.um.redoStack.length).toBe(0);
      expect(sess.um.undoStack.length).toBeGreaterThan(0);

      // A faithful bridge-rung redo (redo wrapped in the same paired transact the
      // undo path uses) is a no-op: the empty redo stack means the edit does not
      // come back and the source stays at the pre-edit state.
      sess.dc.document.transact(() => {
        sess.um.redo();
      }, sess.undoOrigin);
      await wait(200);
      const afterRedoAttempt = ytext.toString();
      expect(afterRedoAttempt).not.toContain('REDO-CHAR-EDIT');
      expect(normalizeBridge(afterRedoAttempt)).toBe(normalizeBridge(preEdit));
      // The bridge stays settled — Y.Text is within tolerance of the re-derived fragment.
      assertBridgeInvariant(ytext, sess.dc.document.getXmlFragment('default'));
    } finally {
      await sm.closeSession(docName, connectionId).catch(() => {});
    }
  }, 30_000);
});
