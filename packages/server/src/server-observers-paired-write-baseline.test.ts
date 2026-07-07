/**
 * Regression: Observer A's paired-write callback must refresh the raw Y.Text
 * witness from `ytext.toString()` (raw bytes), NOT `serialize(fragment)`
 * (canonical bytes). Under the Y.Text-is-truth contract the two diverge on any
 * input where parse→serialize normalizes (e.g., a leading "\n\n" delimiter that
 * mdast drops). If the witness is set from `serialize(fragment)`, the next
 * non-paired XmlFragment mutation (a real WYSIWYG keystroke) fails Observer A's
 * strict-equality Path A gate (`currentText === lastSyncedYTextBytes`) and forces
 * Path B's mergeThreeWay to run on every keystroke. Under stress (large content
 * × many turns × every user keystroke) this exceeds the multi-turn timeout.
 *
 * Verification boundary:
 *   - Real components exercised: Y.Doc, Observer A (afterAllTransactions
 *     settlement handler), composeAndWriteRawBody, Path A gating
 *   - Modeled: WYSIWYG keystroke (simulated as a direct fragment node insert
 *     under a non-paired origin; in production TipTap fires the same
 *     XmlFragment YEvent through its prosemirror-binding).
 */
import { describe, expect, test } from 'bun:test';
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { AGENT_WRITE_ORIGIN } from './agent-sessions.ts';
import { composeAndWriteRawBody } from './bridge-intake.ts';
import { getMetrics, resetMetrics } from './metrics.ts';
import { setupServerObservers } from './server-observers.ts';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

// Non-paired-write origin (simulates TipTap WYSIWYG keystroke; no `paired:true`).
const USER_TYPING_ORIGIN = {
  source: 'connection' as const,
  context: { origin: 'user-typing' },
};

describe('Observer A paired-write baseline — raw ytext, not canonical fragment', () => {
  test('first non-paired fragment mutation after composeAndWriteRawBody does NOT trigger Path B', () => {
    const doc = new Y.Doc();
    const xmlFragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');
    const cleanup = setupServerObservers({
      doc,
      xmlFragment,
      ytext,
      mdManager,
      schema,
    });
    resetMetrics();

    // Step 1: Agent paired-write via composeAndWriteRawBody.
    // composeBody for 'append' on empty ytext: '' + '\n\n' + payload, so ytext
    // ends up with leading \n\n ('\n\n' delimiter is
    // unconditional). This mirrors the exact path agent-write-md takes for
    // the first turn.
    const fixturePayload = '## Section 1\n\nLorem ipsum dolor sit amet.\n';
    const composedAppend = `\n\n${fixturePayload}`;
    doc.transact(() => {
      composeAndWriteRawBody(doc, composedAppend, 'agent');
    }, AGENT_WRITE_ORIGIN);

    // Confirm the divergence shape that motivates this regression test:
    // ytext keeps the leading \n\n; serialize(fragment) does not.
    const ytextAfterAgent = ytext.toString();
    const fragmentJson = yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON();
    const fragmentSerialized = mdManager.serialize(fragmentJson);
    expect(ytextAfterAgent.startsWith('\n\n')).toBe(true);
    expect(fragmentSerialized.startsWith('\n\n')).toBe(false);
    expect(ytextAfterAgent === fragmentSerialized).toBe(false);

    const pathBFiresBefore = getMetrics().observerAPathBFires;
    expect(pathBFiresBefore).toBe(0);

    // Step 2: Simulate a WYSIWYG keystroke — append a paragraph to fragment
    // under a non-paired origin. In production, TipTap fires the same
    // XmlFragment YEvent. The transact origin is non-paired so the
    // `isPairedWriteOrigin` short-circuit does NOT fire; xmlDirty gets set;
    // afterAllTransactions runs Observer A's full sync.
    doc.transact(() => {
      const para = new Y.XmlElement('paragraph');
      para.insert(0, [new Y.XmlText('USER-MARKER')]);
      xmlFragment.insert(xmlFragment.length, [para]);
    }, USER_TYPING_ORIGIN);

    // Path B must NOT have fired. With the correct baseline (raw ytext), the
    // already-in-sync gate or Path A's strict-equality gate handles the
    // settlement cheaply. With a canonical baseline, Path A would fail and
    // Path B's mergeThreeWay would run.
    const pathBFiresAfter = getMetrics().observerAPathBFires;
    expect(pathBFiresAfter).toBe(0);

    cleanup();
  });
});
