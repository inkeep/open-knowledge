import { setTimeout as wait } from 'node:timers/promises';
import { normalizeBridge } from '@inkeep/open-knowledge-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
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

      await agentWriteMd(server.port, '\n\nREDO-CHAR-EDIT paragraph.\n', {
        docName,
        agentId: agentSuffix,
        agentName: `A-${agentSuffix}`,
        position: 'append',
      });
      await wait(600);
      expect(ytext.toString()).toContain('REDO-CHAR-EDIT');

      await agentUndo(server.port, { docName, connectionId, scope: 'last' });
      await wait(400);
      const afterUndo = ytext.toString();
      expect(afterUndo).not.toContain('REDO-CHAR-EDIT');
      expect(normalizeBridge(afterUndo)).toBe(normalizeBridge(preEdit));

      expect(sess.um.redoStack.length).toBe(0);
      expect(sess.um.undoStack.length).toBeGreaterThan(0);

      sess.dc.document.transact(() => {
        sess.um.redo();
      }, sess.undoOrigin);
      await wait(200);
      const afterRedoAttempt = ytext.toString();
      expect(afterRedoAttempt).not.toContain('REDO-CHAR-EDIT');
      expect(normalizeBridge(afterRedoAttempt)).toBe(normalizeBridge(preEdit));
      assertBridgeInvariant(ytext, sess.dc.document.getXmlFragment('default'));
    } finally {
      await sm.closeSession(docName, connectionId).catch(() => {});
    }
  }, 30_000);
});
