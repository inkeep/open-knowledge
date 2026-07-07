/**
 * Undo round-trip oracle on an indented multi-Step MDX-JSX doc.
 *
 * Seeds an indented <Steps>/<Step> doc, makes an undoable agent edit, then runs
 * the REAL applyAgentUndo (via /api/agent-undo). Asserts the source Y.Text
 * returns to the pre-edit state within normalizeBridge tolerance, a subsequent
 * settle does NOT re-dirty the undone region, and a concurrent peer edit
 * survives the undo. Redo is intentionally NOT asserted: the agent API is
 * undo-only and the post-undo settle clears the Y.UndoManager redo stack.
 *
 * Scope note: this is the test-side ORACLE. The production watchers
 * (per-transaction item-preservation + undo post-condition guards) are
 * out of scope; only the round-trip oracle is in scope here.
 *
 * Session lifecycle in try/finally. Y.UndoManager captureTimeout is 500ms,
 * so writes are spaced >500ms apart to land as distinct StackItems.
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

const STEP_MARKERS = ['STEP-ONE-BODY', 'STEP-TWO-BODY', 'STEP-THREE-BODY'];

const MULTI_STEP_SEED = [
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
  '<Step>',
  '',
  'STEP-THREE-BODY third.',
  '',
  '</Step>',
  '',
  '</Steps>',
  '',
].join('\n');

describe('O4 — undo round-trip on an indented multi-Step doc', () => {
  test('undo returns the source within tolerance, with no re-dirty after settle', async () => {
    const docName = `o4-jsx-${crypto.randomUUID()}`;
    const agentSuffix = `o4-${crypto.randomUUID().slice(0, 8)}`;
    const connectionId = `agent-${agentSuffix}`;
    const sm = server.instance.sessionManager;
    try {
      // Seed the indented multi-Step doc (first StackItem).
      await agentWriteMd(server.port, MULTI_STEP_SEED, {
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

      // Undoable edit: append a marked paragraph (a distinct StackItem).
      await agentWriteMd(server.port, '\n\nO4-UNDOABLE-EDIT paragraph.\n', {
        docName,
        agentId: agentSuffix,
        agentName: `A-${agentSuffix}`,
        position: 'append',
      });
      await wait(600);
      expect(ytext.toString()).toContain('O4-UNDOABLE-EDIT');

      // Real applyAgentUndo of the last burst.
      await agentUndo(server.port, { docName, connectionId, scope: 'last' });
      await wait(400);

      const afterUndo = ytext.toString();
      expect(afterUndo).not.toContain('O4-UNDOABLE-EDIT');
      // Within-tolerance round-trip to the pre-edit source, every Step intact.
      expect(normalizeBridge(afterUndo)).toBe(normalizeBridge(preEdit));
      for (const m of STEP_MARKERS) expect(afterUndo).toContain(m);

      // A subsequent settle must NOT re-dirty the undone region (the bridge does
      // not re-derive the undone edit back in — the load-bearing post-fix
      // property: with the indented-JSX within tolerance, no corrective
      // re-derive fires for this class).
      await wait(600);
      expect(ytext.toString()).not.toContain('O4-UNDOABLE-EDIT');
      expect(normalizeBridge(ytext.toString())).toBe(normalizeBridge(preEdit));
      // Full bridge invariant after the settle: the post-undo Y.Text must be
      // within tolerance of the re-derived XmlFragment, proving the bridge
      // SETTLES (no re-derive loop) — the Y.Text-only assertion above cannot see
      // a fragment that drifted out of tolerance. Mirrors the
      // post-convergence assertBridgeInvariant pattern.
      assertBridgeInvariant(ytext, sess.dc.document.getXmlFragment('default'));

      // No redo companion: agents have no redo product surface (/api/agent-undo
      // is undo-only), and the post-undo bridge settle issues a
      // transaction that clears the Y.UndoManager redo stack — so redo-after-
      // settle is not reliably available. The undo round-trip + no-re-dirty +
      // concurrent-peer-survives assertions are O4's load-bearing oracle.
    } finally {
      await sm.closeSession(docName, connectionId).catch(() => {});
    }
  }, 30_000);

  test('a concurrent peer edit survives the agent undo', async () => {
    const docName = `o4-peer-${crypto.randomUUID()}`;
    const agentSuffix = `o4p-${crypto.randomUUID().slice(0, 8)}`;
    const connectionId = `agent-${agentSuffix}`;
    const sm = server.instance.sessionManager;
    try {
      await agentWriteMd(server.port, MULTI_STEP_SEED, {
        docName,
        agentId: agentSuffix,
        agentName: `A-${agentSuffix}`,
        position: 'replace',
      });
      await wait(600);

      // Agent's undoable edit.
      await agentWriteMd(server.port, '\n\nO4-AGENT-EDIT paragraph.\n', {
        docName,
        agentId: agentSuffix,
        agentName: `A-${agentSuffix}`,
        position: 'append',
      });
      await wait(400);

      // Concurrent peer (human) edit: a no-origin transact on the source Y.Text
      // (simulates a WYSIWYG/source keystroke not owned by the agent's UndoManager).
      const sess = await sm.getSession(docName, connectionId);
      const ytext = sess.dc.document.getText('source');
      sess.dc.document.transact(() => {
        ytext.insert(ytext.length, '\n\nO4-PEER-KEYSTROKE survives.\n');
      });
      await wait(400);
      expect(ytext.toString()).toContain('O4-AGENT-EDIT');
      expect(ytext.toString()).toContain('O4-PEER-KEYSTROKE');

      // Undo only the agent's edit.
      await agentUndo(server.port, { docName, connectionId, scope: 'last' });
      await wait(400);

      const finalText = ytext.toString();
      // Agent's edit gone; the concurrent peer keystroke MUST survive.
      expect(finalText).not.toContain('O4-AGENT-EDIT');
      expect(finalText).toContain('O4-PEER-KEYSTROKE');
      for (const m of STEP_MARKERS) expect(finalText).toContain(m);
    } finally {
      await sm.closeSession(docName, connectionId).catch(() => {});
    }
  }, 30_000);
});
