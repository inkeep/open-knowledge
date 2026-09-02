import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { AGENT_WRITE_ORIGIN } from './agent-sessions.ts';
import { composeAndWriteRawBody } from './bridge-intake.ts';
import { getMetrics, resetMetrics } from './metrics.ts';
import { setupServerObservers } from './server-observers.ts';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

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

    const fixturePayload = '## Section 1\n\nLorem ipsum dolor.\n \nSit amet.\n';
    const composedAppend = `\n\n${fixturePayload}`;
    doc.transact(() => {
      composeAndWriteRawBody(doc, composedAppend, 'agent');
    }, AGENT_WRITE_ORIGIN);

    const ytextAfterAgent = ytext.toString();
    const fragmentJson = yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON();
    const fragmentSerialized = mdManager.serialize(fragmentJson);
    expect(ytextAfterAgent.includes('dolor.\n \nSit')).toBe(true);
    expect(fragmentSerialized.includes('dolor.\n \nSit')).toBe(false);
    expect(fragmentSerialized.includes('dolor.\n\nSit')).toBe(true);
    expect(ytextAfterAgent === fragmentSerialized).toBe(false);

    const pathBFiresBefore = getMetrics().observerAPathBFires;
    expect(pathBFiresBefore).toBe(0);

    doc.transact(() => {
      const para = new Y.XmlElement('paragraph');
      para.insert(0, [new Y.XmlText('USER-MARKER')]);
      xmlFragment.insert(xmlFragment.length, [para]);
    }, USER_TYPING_ORIGIN);

    const pathBFiresAfter = getMetrics().observerAPathBFires;
    expect(pathBFiresAfter).toBe(0);

    cleanup();
  });
});
