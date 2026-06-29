
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

      await agentWriteMd(server.port, '\n\nO4-UNDOABLE-EDIT paragraph.\n', {
        docName,
        agentId: agentSuffix,
        agentName: `A-${agentSuffix}`,
        position: 'append',
      });
      await wait(600);
      expect(ytext.toString()).toContain('O4-UNDOABLE-EDIT');

      await agentUndo(server.port, { docName, connectionId, scope: 'last' });
      await wait(400);

      const afterUndo = ytext.toString();
      expect(afterUndo).not.toContain('O4-UNDOABLE-EDIT');
      expect(normalizeBridge(afterUndo)).toBe(normalizeBridge(preEdit));
      for (const m of STEP_MARKERS) expect(afterUndo).toContain(m);

      await wait(600);
      expect(ytext.toString()).not.toContain('O4-UNDOABLE-EDIT');
      expect(normalizeBridge(ytext.toString())).toBe(normalizeBridge(preEdit));
      assertBridgeInvariant(ytext, sess.dc.document.getXmlFragment('default'));

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

      await agentWriteMd(server.port, '\n\nO4-AGENT-EDIT paragraph.\n', {
        docName,
        agentId: agentSuffix,
        agentName: `A-${agentSuffix}`,
        position: 'append',
      });
      await wait(400);

      const sess = await sm.getSession(docName, connectionId);
      const ytext = sess.dc.document.getText('source');
      sess.dc.document.transact(() => {
        ytext.insert(ytext.length, '\n\nO4-PEER-KEYSTROKE survives.\n');
      });
      await wait(400);
      expect(ytext.toString()).toContain('O4-AGENT-EDIT');
      expect(ytext.toString()).toContain('O4-PEER-KEYSTROKE');

      await agentUndo(server.port, { docName, connectionId, scope: 'last' });
      await wait(400);

      const finalText = ytext.toString();
      expect(finalText).not.toContain('O4-AGENT-EDIT');
      expect(finalText).toContain('O4-PEER-KEYSTROKE');
      for (const m of STEP_MARKERS) expect(finalText).toContain(m);
    } finally {
      await sm.closeSession(docName, connectionId).catch(() => {});
    }
  }, 30_000);
});
