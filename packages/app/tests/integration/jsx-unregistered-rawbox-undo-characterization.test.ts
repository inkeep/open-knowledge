/**
 * Undo of an unregistered raw-box (rawMdxFallback) edit at the bridge rung.
 *
 * The predecessor undo test (jsx-undo-roundtrip) drives edits through the agent
 * Y.Text write path (agentWriteMd) — a Y.Text-FIRST transaction. A raw-box edit
 * is XmlFragment-FIRST: forwardUpdate dispatches tr.replaceWith / tr.delete on the
 * rawMdxFallback's content range (RawMdxFallbackCMView), which the server's
 * Observer A re-derives into Y.Text. This test reproduces that XmlFragment-first
 * edit at the Y.XmlFragment layer — the layer y-prosemirror writes to when that PM
 * transaction dispatches — because the nested CodeMirror NodeView is browser-tier
 * and does not mount in-process. The edit is a wholesale content replace, matching
 * forwardUpdate's replaceWith shape. The seam under test (Observer A → Y.Text →
 * session UndoManager → applyAgentUndo) runs with real production components.
 *
 * An in-harness rawMdxFallback is reached via invalid MDX; the valid-unregistered
 * rAF-conversion box is a client browser NodeView, unreachable in-process. Both are
 * the same PM node with the same forwardUpdate edit path, so the undo seam is
 * identical for either origin of the box.
 *
 * Observed and PINNED (the reachability/loss record for the product triage):
 *  1. A raw-box (XmlFragment-first) edit propagates to Y.Text but is NOT captured by
 *     the agent session UndoManager — structurally, because Observer A re-origins
 *     every XmlFragment→Y.Text write to OBSERVER_SYNC_ORIGIN, which the UM does not
 *     track. Not agent-origin-dependent: even an XmlFragment edit made under
 *     session.origin lands in Y.Text under OBSERVER_SYNC_ORIGIN and is not captured.
 *     A direct Y.Text edit under session.origin IS captured (the control).
 *  2. When the agent undoes its own SEPARATE edit, the raw-box edit SURVIVES and the
 *     Y.Text round-trips (heading + raw-box-edited body + trailing intact; the agent
 *     edit cleanly removed), with the rawMdxFallback Y.XmlElement identity preserved.
 *     Item-preservation holds — no content or attribution loss (not a corruption finding).
 *
 * Consequence for any future undo surface: a raw-box (WYSIWYG-class) edit is the
 * human client's to undo (editor.commands.undo), not the agent Y.Text undo's — the
 * agent undo neither reverts it nor corrupts it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
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

/** First rawMdxFallback element in the fragment (mirrors raw-mdx-fallback-multi-client). */
function findRawMdxFallback(fragment: Y.XmlFragment): Y.XmlElement | null {
  for (let i = 0; i < fragment.length; i++) {
    const child = fragment.get(i);
    if (child instanceof Y.XmlElement && child.nodeName === 'rawMdxFallback') return child;
  }
  return null;
}

/** First Y.XmlText child inside a Y.XmlElement (the raw box's editable content). */
function getFirstXmlText(el: Y.XmlElement): Y.XmlText | null {
  for (let i = 0; i < el.length; i++) {
    const child = el.get(i);
    if (child instanceof Y.XmlText) return child;
  }
  return null;
}

/** Reproduce forwardUpdate's wholesale replace of the raw box content at the Y layer. */
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

// <Steps> is an unregistered component name; the mismatched close makes the block
// invalid MDX so parseWithFallback yields a rawMdxFallback raw box.
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

      // The raw-box edit (undefined origin — a local WYSIWYG/CM dispatch).
      // biome-ignore lint/style/noNonNullAssertion: asserted above
      replaceRawBoxContent(sess, xmlText!, '<Steps>RAWBOX-EDITED-BODY</Stepz>');
      await wait(600);

      // Observer A propagated the XmlFragment edit into Y.Text …
      expect(ytext.toString()).toContain('RAWBOX-EDITED-BODY');
      expect(ytext.toString()).not.toContain('RAWBOX-SEED-BODY');
      // … but the agent UndoManager did NOT capture it (Observer A re-origins the
      // Y.Text write to OBSERVER_SYNC_ORIGIN, which the UM does not track).
      expect(sess.um.undoStack.length).toBe(stackAfterSeed);

      // Control (b): the boundary is structural, not origin-dependent — an
      // XmlFragment edit made under session.origin still lands in Y.Text under
      // OBSERVER_SYNC_ORIGIN, so it is still not captured.
      // biome-ignore lint/style/noNonNullAssertion: asserted above
      replaceRawBoxContent(sess, xmlText!, '<Steps>RAWBOX-ORIGIN-B</Stepz>', sess.origin);
      await wait(400);
      expect(sess.um.undoStack.length).toBe(stackAfterSeed);

      // Control (c): a DIRECT Y.Text edit under session.origin IS captured — proving
      // the stack is live, so the raw-box non-capture above is meaningful, not frozen.
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
      // StackItem 1: seed the raw-box doc.
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
      // An integrated Y.XmlElement has a non-null `_item`; assert it so the
      // identity check below is a real comparison, not a vacuous null === null.
      expect(rawItemBefore).not.toBeNull();
      // biome-ignore lint/style/noNonNullAssertion: asserted above
      const xmlText = getFirstXmlText(rawBox!);
      expect(xmlText).not.toBeNull();

      // StackItem 2: the agent's own edit — the burst the undo will revert.
      await agentWriteMd(server.port, '\n\nAGENT-SECOND-EDIT paragraph.\n', {
        docName,
        agentId: agentSuffix,
        agentName: `A-${agentSuffix}`,
        position: 'append',
      });
      await wait(600);
      expect(ytext.toString()).toContain('AGENT-SECOND-EDIT');

      // Concurrent raw-box edit (WYSIWYG-class, XmlFragment-first).
      // biome-ignore lint/style/noNonNullAssertion: asserted above
      replaceRawBoxContent(sess, xmlText!, '<Steps>RAWBOX-EDITED-BODY</Stepz>');
      await wait(600);
      expect(ytext.toString()).toContain('RAWBOX-EDITED-BODY');

      // Undo the agent's own edit (scope last).
      await agentUndo(server.port, { docName, connectionId, scope: 'last' });
      await wait(400);

      const afterUndo = ytext.toString();
      // The agent's edit is cleanly reverted …
      expect(afterUndo).not.toContain('AGENT-SECOND-EDIT');
      // … while the raw-box edit and the untouched seed content all survive.
      expect(afterUndo).toContain('RAWBOX-EDITED-BODY');
      expect(afterUndo).toContain('# Heading');
      expect(afterUndo).toContain('Trailing paragraph.');
      expect(afterUndo).not.toContain('RAWBOX-SEED-BODY');

      // Item-preservation: the rawMdxFallback Y.XmlElement identity is stable across
      // the whole cycle — the undo did not delete+reinsert the raw box.
      const rawBoxAfter = findRawMdxFallback(fragment);
      expect(rawBoxAfter).not.toBeNull();
      // biome-ignore lint/style/noNonNullAssertion: asserted above
      expect(rawBoxAfter!._item).toBe(rawItemBefore);
    } finally {
      await sm.closeSession(docName, connectionId).catch(() => {});
    }
  }, 30_000);
});
