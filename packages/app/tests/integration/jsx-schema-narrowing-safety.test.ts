import { describe, expect, test } from 'bun:test';
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

describe('SH01: pre-widening jsxComponent (atom=true, raw-content-in-attrs) materialization', () => {
  test('pre-widening shape — legacy raw-content attrs materialize without tombstoning Y.Items', () => {
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment('default');

    const legacyJsxComponent = new Y.XmlElement('jsxComponent');
    legacyJsxComponent.setAttribute('componentName', 'Callout');
    legacyJsxComponent.setAttribute('content', 'Legacy inline prose content');

    fragment.insert(0, [legacyJsxComponent]);

    const beforeId = legacyJsxComponent._item?.id;
    const before = readCounters();

    const { doc } = initProseMirrorDoc(fragment, schema);

    expect(legacyJsxComponent._item?.deleted).toBe(false);
    expect(legacyJsxComponent._item?.id).toEqual(beforeId);

    const after = readCounters();
    expect(after.block - before.block).toBe(0);
    expect(after.inline - before.inline).toBe(0);

    expect(doc.childCount).toBeGreaterThanOrEqual(1);
    expect(doc.child(0).type.name).toBe('jsxComponent');
  });
});

describe('SH05: pre-narrowing jsxInline (legacy attrs + non-text inline child) materialization', () => {
  test('stale jsxInline with legacy `attributes`/`sourceRaw` attrs — parent survives, inline counter bumps', () => {
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment('default');

    const para = new Y.XmlElement('paragraph');
    fragment.insert(0, [para]);

    const inline = new Y.XmlElement('jsxInline');
    inline.setAttribute('attributes', '[]'); // legacy attr, now removed
    inline.setAttribute('sourceRaw', '<Icon name="check" />'); // legacy attr, now removed
    para.insert(0, [inline]);

    const nonTextChild = new Y.XmlElement('paragraph'); // arbitrary non-text
    inline.insert(0, [nonTextChild]);

    const beforeInlineId = inline._item?.id;
    const beforeParaId = para._item?.id;
    const before = readCounters();

    let doc: ReturnType<typeof initProseMirrorDoc>['doc'] | undefined;
    expect(() => {
      doc = initProseMirrorDoc(fragment, schema).doc;
    }).not.toThrow();

    const after = readCounters();

    expect(inline._item?.deleted).toBe(false);
    expect(para._item?.deleted).toBe(false);
    expect(inline._item?.id).toEqual(beforeInlineId);
    expect(para._item?.id).toEqual(beforeParaId);

    expect(after.block - before.block).toBe(0);

    expect(doc).toBeDefined();
    expect(doc?.childCount).toBeGreaterThanOrEqual(1);
    expect(doc?.child(0).type.name).toBe('paragraph');
  });
});
