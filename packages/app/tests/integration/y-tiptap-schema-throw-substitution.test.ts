/**
 * R13 live-substitution regression — drives a schema.node() / schema.text()
 * throw through `@tiptap/y-tiptap`'s actual production code path (not
 * y-prosemirror's, not `yXmlFragmentToProsemirrorJSON`'s typeName-only
 * serializer) and asserts the patched behavior:
 *
 *   1. No Y.Item was tombstoned — `_item.deleted === false` post-materialization
 *   2. `globalThis.__okYpsCounters.{block,inline}` incremented by the catch
 *   3. For block-context throws: a `rawMdxFallback` node appears in the
 *      materialized PM doc, with `reason` attr = thrown message and inline
 *      text = original nodeName
 *   4. For inline-context throws: the offending delta is skipped and Y.Item
 *      identity on both the text and its parent is preserved
 *
 * Why this test exists:
 *
 * The only previous R13 verification was `y-prosemirror-patch.test.ts` (a
 * static source-level check) plus integration tests that *could* trigger
 * `schema.node()` throws but never actually proved the patch fired. We
 * discovered via the Yjs 14 research that the production import target
 * (`@tiptap/y-tiptap@3.0.3`) bundles its own unpatched copies of
 * `createNodeFromYElement` / `createTextNodesFromYText`. The patch was only
 * applied to `y-prosemirror@1.3.7`, which `@tiptap/extension-collaboration`
 * does not import from — so the R13 safety net was off in production.
 *
 * Fix: `patches/@tiptap%2Fy-tiptap@3.0.3.patch` ports the same substitution
 * into the y-tiptap bundles. THIS test is the live-fire check that would
 * have caught the gap on day one — it imports `initProseMirrorDoc` from
 * `@tiptap/y-tiptap` (which DOES call the patched `createNodeFromYElement`
 * internally, unlike `yXmlFragmentToProsemirrorJSON`), drives a real throw,
 * and asserts substitution.
 *
 * Notes on the materialization path we test:
 *
 *   `initProseMirrorDoc` is the same function `ySyncPlugin.initBinding` calls
 *   to build the initial PM doc from the CRDT state. By using it directly we
 *   exercise the same catch blocks a live editor would, without needing a DOM
 *   or WebSocket plumbing.
 */

import { describe, expect, test } from 'bun:test';
import type { Node as PmNode } from '@tiptap/pm/model';
import { initProseMirrorDoc } from '@tiptap/y-tiptap';
import * as Y from 'yjs';

import { schema } from './test-harness';

interface YpsCounters {
  block: number;
  inline: number;
}

/**
 * Read the globalThis counter bridge the R13 patch writes through. The patch
 * initializes this lazily on first catch-block hit; we read it after
 * materialization and diff against a captured baseline so cross-test
 * interference can't bias a single test's delta.
 */
function readCounters(): YpsCounters {
  const host = globalThis as { __okYpsCounters?: YpsCounters };
  host.__okYpsCounters ||= { block: 0, inline: 0 };
  return { ...host.__okYpsCounters };
}

/** Depth-first walk of a PM node, returning the first node matching the predicate. */
function findNode(node: PmNode, predicate: (n: PmNode) => boolean): PmNode | null {
  if (predicate(node)) return node;
  for (let i = 0; i < node.childCount; i++) {
    const hit = findNode(node.child(i), predicate);
    if (hit) return hit;
  }
  return null;
}

describe('R13 @tiptap/y-tiptap schema.node() throw substitution', () => {
  test('rawMdxFallback node type exists in the shared schema (precondition)', () => {
    expect(schema.nodes.rawMdxFallback).toBeDefined();
  });

  test('unknown nodeName → rawMdxFallback substitution, no Y.Item tombstone', () => {
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment('default');

    // Insert an element whose nodeName is NOT in the schema. schema.node(name)
    // throws inside y-tiptap's createNodeFromYElement, hitting the R13 catch.
    const unknown = new Y.XmlElement('thisNodeTypeDoesNotExist');
    fragment.insert(0, [unknown]);

    expect(unknown._item).not.toBeNull();
    const beforeId = unknown._item?.id;
    const before = readCounters();

    // Act: exercise the same materialization path ySyncPlugin's initBinding
    // uses. This is where the patched createNodeFromYElement runs.
    const { doc } = initProseMirrorDoc(fragment, schema);

    // Y.Item identity preserved — destructive-delete code path bypassed.
    expect(unknown._item?.deleted).toBe(false);
    expect(unknown._item?.id).toEqual(beforeId);

    // Block-context counter bumped exactly once.
    const after = readCounters();
    expect(after.block - before.block).toBe(1);

    // Doc contains the substituted fallback node with expected shape.
    const fallback = findNode(doc, (n) => n.type.name === 'rawMdxFallback');
    expect(fallback).not.toBeNull();
    expect(fallback?.attrs.reason).toBeDefined();
    expect(String(fallback?.attrs.reason ?? '').length).toBeGreaterThan(0);
    expect(fallback?.textContent).toBe('thisNodeTypeDoesNotExist');
  });

  test('valid siblings survive a thrown sibling — fallback is local, not fatal', () => {
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment('default');

    const p1 = new Y.XmlElement('paragraph');
    const p1Text = new Y.XmlText();
    const bad = new Y.XmlElement('anotherUnknownType');
    const p2 = new Y.XmlElement('paragraph');
    const p2Text = new Y.XmlText();

    fragment.insert(0, [p1, bad, p2]);
    // Y.XmlText must be inserted AFTER its parent is attached to the doc.
    p1.insert(0, [p1Text]);
    p1Text.insert(0, 'before');
    p2.insert(0, [p2Text]);
    p2Text.insert(0, 'after');

    const before = readCounters();
    const { doc } = initProseMirrorDoc(fragment, schema);
    const after = readCounters();

    expect(after.block - before.block).toBe(1);
    expect(bad._item?.deleted).toBe(false);
    expect(p1._item?.deleted).toBe(false);
    expect(p2._item?.deleted).toBe(false);

    // Three top-level children preserved: paragraph, rawMdxFallback, paragraph.
    expect(doc.childCount).toBe(3);
    expect(doc.child(0).type.name).toBe('paragraph');
    expect(doc.child(1).type.name).toBe('rawMdxFallback');
    expect(doc.child(2).type.name).toBe('paragraph');
    expect(doc.child(0).textContent).toBe('before');
    expect(doc.child(2).textContent).toBe('after');
  });
});

describe('R13 @tiptap/y-tiptap schema.text() throw substitution', () => {
  test('unknown mark attribute → inline counter++, no Y.Item tombstone', () => {
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment('default');

    // Valid paragraph containing a Y.XmlText formatted with a non-existent
    // mark. attributesToMarks → schema.mark('thisMarkDoesNotExist') throws
    // inside createTextNodesFromYText, hitting the second R13 catch block.
    const para = new Y.XmlElement('paragraph');
    fragment.insert(0, [para]);
    const text = new Y.XmlText();
    para.insert(0, [text]);
    text.insert(0, 'formatted text');
    text.format(0, text.length, { thisMarkDoesNotExist: true });

    const beforeTextId = text._item?.id;
    const beforeParaId = para._item?.id;
    const before = readCounters();

    // Act: should not throw; inline catch handles it silently.
    let doc: PmNode | undefined;
    expect(() => {
      doc = initProseMirrorDoc(fragment, schema).doc;
    }).not.toThrow();

    // Y.Item identity preserved on both the paragraph AND its text child.
    expect(text._item?.deleted).toBe(false);
    expect(para._item?.deleted).toBe(false);
    expect(text._item?.id).toEqual(beforeTextId);
    expect(para._item?.id).toEqual(beforeParaId);

    // Inline-context counter bumped by at least 1.
    const after = readCounters();
    expect(after.inline - before.inline).toBeGreaterThanOrEqual(1);

    // Document the inline-skip output shape. When createTextNodesFromYText
    // returns null (R13 inline catch), createChildren in initProseMirrorDoc
    // skips pushing to the paragraph's children
    // array — so the paragraph materializes with empty content rather than
    // with garbage, a failed node, or a tombstoned text. This is the
    // inline-context equivalent of the block-context shape assertions above.
    expect(doc).toBeDefined();
    expect(doc?.childCount).toBe(1);
    expect(doc?.child(0).type.name).toBe('paragraph');
    expect(doc?.child(0).childCount).toBe(0);
    expect(doc?.child(0).textContent).toBe('');
  });
});
