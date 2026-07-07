/**
 * Unit tests for the MANAGED_RENAME_ORIGIN paired-write order property.
 *
 * `applyManagedRenameMapToLoadedDocument` in api-extension.ts writes both
 * Y.Text and Y.XmlFragment inside one `doc.transact(..., MANAGED_RENAME_ORIGIN)`
 * drain. Under the Y.Text-is-truth contract (precedent #38), Y.Text is the
 * source of truth — the write order MUST be ytext-first / fragment-second so
 * that a partial failure (second write throws after the first succeeds) leaves
 * ytext in the new state and Observer B Phase 1 re-derives fragment from
 * `parse(ytext)` on the next non-paired settlement.
 *
 * Reversed order (fragment-first / ytext-second) silently reverts the rename
 * if updateYFragment succeeds and applyFastDiff then throws: fragment holds
 * the new state but ytext is stale, and Observer B's next dispatch re-derives
 * fragment from the STALE ytext, undoing the rename without any visible error.
 *
 * This file mirrors the load-bearing properties already pinned for
 * `composeAndWriteRawBody` in bridge-intake.test.ts (write-order observation +
 * partial-failure recovery), specialized to the rename call site whose write
 * sequence is open-coded inside the api-extension closure.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { applyFastDiff, sharedExtensions, stripFrontmatter } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { MANAGED_RENAME_ORIGIN } from './api-extension.ts';
import { mdManager } from './md-manager.ts';
import { setupServerObservers } from './server-observers.ts';

const schema = getSchema(sharedExtensions);

/**
 * Run the rename's paired-write sequence inline. Mirrors the new ytext-first
 * order in api-extension.ts:applyManagedRenameMapToLoadedDocument.
 */
function applyRenameWritesInline(
  doc: Y.Doc,
  newMarkdown: string,
  options: { throwAfterYText?: boolean } = {},
): void {
  const xmlFragment = doc.getXmlFragment('default');
  const ytext = doc.getText('source');
  doc.transact(() => {
    const currentText = ytext.toString();
    const { body } = stripFrontmatter(newMarkdown);
    const parsedJson = mdManager.parseWithFallback(body);
    const pmNode = schema.nodeFromJSON(parsedJson);
    applyFastDiff(ytext, currentText, newMarkdown);
    if (options.throwAfterYText) {
      throw new Error('synthetic: updateYFragment failed after applyFastDiff');
    }
    updateYFragment(doc, xmlFragment, pmNode, {
      mapping: new Map(),
      isOMark: new Map(),
    });
  }, MANAGED_RENAME_ORIGIN);
}

describe('MANAGED_RENAME_ORIGIN — paired-write order property', () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
    const xmlFragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');
    const seed = '# Old\n\n[[old-page]]\n';
    doc.transact(() => {
      const seedJson = mdManager.parse(seed);
      const seedNode = schema.nodeFromJSON(seedJson);
      updateYFragment(doc, xmlFragment, seedNode, {
        mapping: new Map(),
        isOMark: new Map(),
      });
      ytext.insert(0, seed);
    }, MANAGED_RENAME_ORIGIN);
  });

  test('Y.Text is mutated before XmlFragment under MANAGED_RENAME_ORIGIN', () => {
    // Yjs's transaction.changed map is preserved in insertion order. The type
    // that received its first mutation first fires its observer first. If a
    // future refactor reverses the call sequence, this test catches it via
    // observer-dispatch order.
    const events: string[] = [];
    const xmlFragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');
    xmlFragment.observeDeep(() => events.push('xml'));
    ytext.observe(() => events.push('ytext'));

    applyRenameWritesInline(doc, '# New\n\n[[new-page]]\n');

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.indexOf('ytext')).toBeLessThan(events.indexOf('xml'));
  });

  test('partial failure (throw after applyFastDiff): ytext holds renamed bytes', () => {
    const ytext = doc.getText('source');

    expect(() => {
      applyRenameWritesInline(doc, '# New\n\n[[new-page]]\n', { throwAfterYText: true });
    }).toThrow(/synthetic/);

    // ytext was written first, so it holds the new bytes despite the throw —
    // Yjs transactions don't roll back on throw.
    expect(ytext.toString()).toBe('# New\n\n[[new-page]]\n');
  });

  test('partial failure recovery: Observer B re-derives fragment from new ytext on next settlement', () => {
    const xmlFragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');

    expect(() => {
      applyRenameWritesInline(doc, '# New\n\n[[new-page]]\n', { throwAfterYText: true });
    }).toThrow(/synthetic/);

    // After the partial-failure throw: ytext = new bytes; fragment = old bytes.
    // Now attach observers and trigger a non-paired ytext settlement that
    // forces Observer B Phase 1 (ytext → fragment) to re-derive fragment from
    // current ytext bytes.
    const cleanup = setupServerObservers({
      doc,
      xmlFragment,
      ytext,
      mdManager,
      schema,
    });

    // A non-paired ytext mutation triggers Observer B's settlement dispatch.
    doc.transact(() => {
      const cur = ytext.toString();
      ytext.insert(cur.length, ' ');
    });

    // Fragment now derives from current ytext bytes — the rename target body
    // survived through the partial-failure recovery path. Observer B serializes
    // the post-settlement xmlFragment back through the markdown pipeline; the
    // round-trip through ytext (truth) → fragment (derived) → serialize must
    // carry the rename target.
    const fragmentJson = yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON();
    const fragmentBody = mdManager.serialize(fragmentJson);
    expect(fragmentBody).toContain('new-page');
    expect(fragmentBody).not.toContain('old-page');

    cleanup();
  });
});
