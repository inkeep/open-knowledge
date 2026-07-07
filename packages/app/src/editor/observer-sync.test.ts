/**
 * Observer sync tests — shimmer prevention.
 *
 * Cross-CRDT sync tests (Observer A writing Y.Text, Observer B writing XmlFragment)
 * live in server-observers.test.ts and C1-C10 integration tests (server-authoritative
 * architecture, precedent #14). This file covers client-side shimmer prevention only.
 */
import { describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import { MarkdownManager } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { updateYFragment } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { sharedExtensions } from './extensions/shared';
import { ORIGIN_TEXT_TO_TREE, ORIGIN_TREE_TO_TEXT, setupObservers } from './observers';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

/** Populate XmlFragment from markdown */
function applyMarkdown(doc: Y.Doc, fragment: Y.XmlFragment, md: string) {
  const json = mdManager.parse(md);
  const pmNode = schema.nodeFromJSON(json);
  const meta = { mapping: new Map(), isOMark: new Map() };
  updateYFragment(doc, fragment, pmNode, meta);
}

// --- Shimmer Prevention ---

describe('Shimmer prevention', () => {
  test('S01: single XmlFragment edit → bounded observer firings', async () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');

    let aFirings = 0;
    let bFirings = 0;

    ytext.observe((_event, txn) => {
      if (txn.origin === ORIGIN_TREE_TO_TEXT) aFirings++;
    });
    fragment.observeDeep((_events, txn) => {
      if (txn.origin === ORIGIN_TEXT_TO_TREE) bFirings++;
    });

    const cleanup = setupObservers({ doc, xmlFragment: fragment, ytext, mdManager, schema });

    applyMarkdown(doc, fragment, 'Single edit\n');
    await wait(300);

    expect(aFirings).toBeLessThanOrEqual(2);
    expect(bFirings).toBeLessThanOrEqual(2);
    cleanup();
  });

  test('S02: single Y.Text edit → bounded observer firings', async () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');

    let aFirings = 0;
    let bFirings = 0;

    ytext.observe((_event, txn) => {
      if (txn.origin === ORIGIN_TREE_TO_TEXT) aFirings++;
    });
    fragment.observeDeep((_events, txn) => {
      if (txn.origin === ORIGIN_TEXT_TO_TREE) bFirings++;
    });

    const cleanup = setupObservers({ doc, xmlFragment: fragment, ytext, mdManager, schema });

    doc.transact(() => {
      ytext.insert(0, 'Single edit\n');
    }, 'user-edit');

    await wait(300);

    expect(aFirings).toBeLessThanOrEqual(2);
    expect(bFirings).toBeLessThanOrEqual(2);
    cleanup();
  });
});
