import { setTimeout as wait } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { agentUndo, agentWriteMd, createTestServer, type TestServer } from './test-harness';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
}, HARNESS_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await server.cleanup();
});

function findRawMdxFallback(fragment: Y.XmlFragment): Y.XmlElement | null {
  for (let i = 0; i < fragment.length; i++) {
    const child = fragment.get(i);
    if (child instanceof Y.XmlElement && child.nodeName === 'rawMdxFallback') return child;
  }
  return null;
}

function getFirstXmlText(el: Y.XmlElement): Y.XmlText | null {
  for (let i = 0; i < el.length; i++) {
    const child = el.get(i);
    if (child instanceof Y.XmlText) return child;
  }
  return null;
}

function replaceRawBoxContent(
  sess: { dc: { document: Y.Doc } },
  xmlText: Y.XmlText,
  newSource: string,
  origin?: unknown,
): void {
  sess.dc.document.transact(() => {
    xmlText.delete(0, xmlText.length);
    xmlText.insert(0, newSource);
  }, origin);
}

const SEED = '# Heading\n\n<Steps>RAWBOX-SEED-BODY</Stepz>\n\nTrailing paragraph.\n';

describe('FR-M7 — undo of an unregistered raw-box edit at the bridge rung', () => {
  test('a raw-box XmlFragment-first edit propagates to Y.Text but is not captured by the agent undo stack', async () => {
    const docName = `rawbox-undo-boundary-${crypto.randomUUID()}`;
    const agentSuffix = `rb-${crypto.randomUUID().slice(0, 8)}`;
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
      const fragment = sess.dc.document.getXmlFragment('default');

      const rawBox = findRawMdxFallback(fragment);
      expect(rawBox).not.toBeNull();
      // biome-ignore lint/style/noNonNullAssertion: asserted above
      const xmlText = getFirstXmlText(rawBox!);
      expect(xmlText).not.toBeNull();
      expect(ytext.toString()).toContain('RAWBOX-SEED-BODY');

      const stackAfterSeed = sess.um.undoStack.length;
      expect(stackAfterSeed).toBeGreaterThan(0);

      // biome-ignore lint/style/noNonNullAssertion: asserted above
      replaceRawBoxContent(sess, xmlText!, '<Steps>RAWBOX-EDITED-BODY</Stepz>');
      await wait(600);

      expect(ytext.toString()).toContain('RAWBOX-EDITED-BODY');
      expect(ytext.toString()).not.toContain('RAWBOX-SEED-BODY');
      expect(sess.um.undoStack.length).toBe(stackAfterSeed);

      // biome-ignore lint/style/noNonNullAssertion: asserted above
      replaceRawBoxContent(sess, xmlText!, '<Steps>RAWBOX-ORIGIN-B</Stepz>', sess.origin);
      await wait(400);
      expect(sess.um.undoStack.length).toBe(stackAfterSeed);

      sess.dc.document.transact(() => {
        ytext.insert(ytext.length, '\nDIRECT-YTEXT-EDIT\n');
      }, sess.origin);
      await wait(400);
      expect(sess.um.undoStack.length).toBe(stackAfterSeed + 1);
    } finally {
      await sm.closeSession(docName, connectionId).catch(() => {});
    }
  }, 30_000);

  test('agent-undo of a separate agent edit preserves the raw-box edit and round-trips', async () => {
    const docName = `rawbox-undo-preserve-${crypto.randomUUID()}`;
    const agentSuffix = `rb-${crypto.randomUUID().slice(0, 8)}`;
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
      const fragment = sess.dc.document.getXmlFragment('default');
      const rawBox = findRawMdxFallback(fragment);
      expect(rawBox).not.toBeNull();
      // biome-ignore lint/style/noNonNullAssertion: asserted above
      const rawItemBefore = rawBox!._item;
      expect(rawItemBefore).not.toBeNull();
      // biome-ignore lint/style/noNonNullAssertion: asserted above
      const xmlText = getFirstXmlText(rawBox!);
      expect(xmlText).not.toBeNull();

      await agentWriteMd(server.port, '\n\nAGENT-SECOND-EDIT paragraph.\n', {
        docName,
        agentId: agentSuffix,
        agentName: `A-${agentSuffix}`,
        position: 'append',
      });
      await wait(600);
      expect(ytext.toString()).toContain('AGENT-SECOND-EDIT');

      // biome-ignore lint/style/noNonNullAssertion: asserted above
      replaceRawBoxContent(sess, xmlText!, '<Steps>RAWBOX-EDITED-BODY</Stepz>');
      await wait(600);
      expect(ytext.toString()).toContain('RAWBOX-EDITED-BODY');

      await agentUndo(server.port, { docName, connectionId, scope: 'last' });
      await wait(400);

      const afterUndo = ytext.toString();
      expect(afterUndo).not.toContain('AGENT-SECOND-EDIT');
      expect(afterUndo).toContain('RAWBOX-EDITED-BODY');
      expect(afterUndo).toContain('# Heading');
      expect(afterUndo).toContain('Trailing paragraph.');
      expect(afterUndo).not.toContain('RAWBOX-SEED-BODY');

      const rawBoxAfter = findRawMdxFallback(fragment);
      expect(rawBoxAfter).not.toBeNull();
      // biome-ignore lint/style/noNonNullAssertion: asserted above
      expect(rawBoxAfter!._item).toBe(rawItemBefore);
    } finally {
      await sm.closeSession(docName, connectionId).catch(() => {});
    }
  }, 30_000);
});
