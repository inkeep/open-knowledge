/**
 * Unit tests for the ROLLBACK_ORIGIN paired-write order property.
 *
 * `handleRollback` in api-extension.ts writes both Y.Text and Y.XmlFragment
 * inside one `doc.transact(..., ROLLBACK_ORIGIN)` drain. Under the
 * Y.Text-is-truth contract (precedent #38), Y.Text is the source of truth —
 * the write order MUST be ytext-first / fragment-second so that a partial
 * failure (second write throws after the first succeeds) leaves ytext in the
 * new state and Observer B Phase 1 re-derives fragment from `parse(ytext)`
 * on the next non-paired settlement.
 *
 * Reversed order (fragment-first / ytext-second) silently reverts the
 * rollback if updateYFragment succeeds and the ytext delete/insert then
 * throws: fragment holds the new historical state but ytext is stale, and
 * Observer B's next dispatch re-derives fragment from the STALE ytext,
 * undoing the rollback without any visible error.
 *
 * This file mirrors the load-bearing properties already pinned for
 * `composeAndWriteRawBody` (`bridge-intake.ts`) and the
 * `MANAGED_RENAME_ORIGIN` write site (`managed-rename.test.ts`), specialized
 * to the rollback call site whose write sequence is open-coded inside the
 * api-extension closure.
 */

import { sharedExtensions, stripFrontmatter } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { ROLLBACK_ORIGIN } from './api-extension.ts';
import { replaceRawBody } from './bridge-intake.ts';
import { mdManager } from './md-manager.ts';
import { setupServerObservers } from './server-observers.ts';

const schema = getSchema(sharedExtensions);

function applyRollbackWritesInline(
  doc: Y.Doc,
  newMarkdown: string,
  options: { throwAfterYText?: boolean } = {},
): void {
  const xmlFragment = doc.getXmlFragment('default');
  doc.transact(() => {
    const { body } = stripFrontmatter(newMarkdown);
    const parsedJson = mdManager.parseWithFallback(body);
    const pmNode = schema.nodeFromJSON(parsedJson);

    const ytext = doc.getText('source');
    const currentText = ytext.toString();
    if (currentText !== newMarkdown) {
      ytext.delete(0, currentText.length);
      ytext.insert(0, newMarkdown);
    }

    if (options.throwAfterYText) {
      throw new Error('synthetic: updateYFragment failed after ytext delete/insert');
    }

    updateYFragment(doc, xmlFragment, pmNode, {
      mapping: new Map(),
      isOMark: new Map(),
    });
  }, ROLLBACK_ORIGIN);
}

describe('ROLLBACK_ORIGIN — paired-write order property', () => {
  let doc: Y.Doc;

  beforeEach(() => {
    doc = new Y.Doc();
    const xmlFragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');
    const seed = '# Current\n\nCurrent body content\n';
    doc.transact(() => {
      const seedJson = mdManager.parse(seed);
      const seedNode = schema.nodeFromJSON(seedJson);
      updateYFragment(doc, xmlFragment, seedNode, {
        mapping: new Map(),
        isOMark: new Map(),
      });
      ytext.insert(0, seed);
    }, ROLLBACK_ORIGIN);
  });

  test('PRODUCTION PRIMITIVE: Y.Text is mutated before XmlFragment when handleRollback uses replaceRawBody under ROLLBACK_ORIGIN', () => {
    const events: string[] = [];
    const xmlFragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');
    xmlFragment.observeDeep(() => events.push('xml'));
    ytext.observe(() => events.push('ytext'));

    doc.transact(() => {
      replaceRawBody(doc, '# Historical\n\nRestored body content\n');
    }, ROLLBACK_ORIGIN);

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.indexOf('ytext')).toBeLessThan(events.indexOf('xml'));
  });

  test('Y.Text is mutated before XmlFragment under ROLLBACK_ORIGIN (inline twin parity check)', () => {
    const events: string[] = [];
    const xmlFragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');
    xmlFragment.observeDeep(() => events.push('xml'));
    ytext.observe(() => events.push('ytext'));

    applyRollbackWritesInline(doc, '# Historical\n\nRestored body content\n');

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.indexOf('ytext')).toBeLessThan(events.indexOf('xml'));
  });

  test('partial failure (throw after ytext mutation): ytext holds historical bytes', () => {
    const ytext = doc.getText('source');

    expect(() => {
      applyRollbackWritesInline(doc, '# Historical\n\nRestored body content\n', {
        throwAfterYText: true,
      });
    }).toThrow(/synthetic/);

    expect(ytext.toString()).toBe('# Historical\n\nRestored body content\n');
  });

  test('partial failure recovery: Observer B re-derives fragment from new ytext on next settlement', () => {
    const xmlFragment = doc.getXmlFragment('default');
    const ytext = doc.getText('source');

    expect(() => {
      applyRollbackWritesInline(doc, '# Historical\n\nRestored body content\n', {
        throwAfterYText: true,
      });
    }).toThrow(/synthetic/);

    const cleanup = setupServerObservers({
      doc,
      xmlFragment,
      ytext,
      mdManager,
      schema,
    });

    doc.transact(() => {
      const cur = ytext.toString();
      ytext.insert(cur.length, ' ');
    });

    const fragmentJson = yXmlFragmentToProseMirrorRootNode(xmlFragment, schema).toJSON();
    const fragmentBody = mdManager.serialize(fragmentJson);
    expect(fragmentBody).toContain('Historical');
    expect(fragmentBody).toContain('Restored body content');
    expect(fragmentBody).not.toContain('Current body content');

    cleanup();
  });
});
