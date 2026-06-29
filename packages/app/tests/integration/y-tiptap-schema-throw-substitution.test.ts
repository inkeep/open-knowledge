
import { describe, expect, test } from 'bun:test';
import type { Node as PmNode } from '@tiptap/pm/model';
import { initProseMirrorDoc } from '@tiptap/y-tiptap';
import * as Y from 'yjs';

import { schema } from './test-harness';

interface YpsCounters {
  block: number;
  inline: number;
}

function readCounters(): YpsCounters {
  const host = globalThis as { __okYpsCounters?: YpsCounters };
  host.__okYpsCounters ||= { block: 0, inline: 0 };
  return { ...host.__okYpsCounters };
}

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

    const unknown = new Y.XmlElement('thisNodeTypeDoesNotExist');
    fragment.insert(0, [unknown]);

    expect(unknown._item).not.toBeNull();
    const beforeId = unknown._item?.id;
    const before = readCounters();

    const { doc } = initProseMirrorDoc(fragment, schema);

    expect(unknown._item?.deleted).toBe(false);
    expect(unknown._item?.id).toEqual(beforeId);

    const after = readCounters();
    expect(after.block - before.block).toBe(1);

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

    const para = new Y.XmlElement('paragraph');
    fragment.insert(0, [para]);
    const text = new Y.XmlText();
    para.insert(0, [text]);
    text.insert(0, 'formatted text');
    text.format(0, text.length, { thisMarkDoesNotExist: true });

    const beforeTextId = text._item?.id;
    const beforeParaId = para._item?.id;
    const before = readCounters();

    let doc: PmNode | undefined;
    expect(() => {
      doc = initProseMirrorDoc(fragment, schema).doc;
    }).not.toThrow();

    expect(text._item?.deleted).toBe(false);
    expect(para._item?.deleted).toBe(false);
    expect(text._item?.id).toEqual(beforeTextId);
    expect(para._item?.id).toEqual(beforeParaId);

    const after = readCounters();
    expect(after.inline - before.inline).toBeGreaterThanOrEqual(1);

    expect(doc).toBeDefined();
    expect(doc?.childCount).toBe(1);
    expect(doc?.child(0).type.name).toBe('paragraph');
    expect(doc?.child(0).childCount).toBe(0);
    expect(doc?.child(0).textContent).toBe('');
  });
});
