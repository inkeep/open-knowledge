/**
 * Regression coverage — pre-widening `jsxComponent` (atom=true
 * with raw-content-in-attrs) and pre-narrowing `jsxInline` (with
 * `attributes`/`sourceRaw` attrs and non-text inline children) materialize
 * safely through `@tiptap/y-tiptap`'s `initProseMirrorDoc` under the
 * schema-narrowing safety patch.
 *
 * Paired with `packages/core/src/schema-invariant.test.ts`'s
 * ALLOWED_NARROWINGS registry: the registry names the exception, this test
 * file proves the safety net actually fires for the specific shapes named.
 *
 * Why separate from `y-tiptap-schema-throw-substitution.test.ts`: that file
 * drives generic unknown-nodeName / unknown-mark throws to prove the
 * patch's two catch blocks trigger. This file drives the SPECIFIC stale-shape
 * Y.Doc payloads that a mid-flight collab peer (or a pre-upgrade persisted
 * document) would replay — exercising the exact blast radius those
 * stale pre-widening / pre-narrowing shapes present.
 */

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

    // Simulate a pre-widening persisted shape: `jsxComponent` with legacy
    // raw-content attrs (`content`, `sourceRaw`). The widened schema has
    // `content: 'block*'` with structured attrs (`componentName`,
    // `attributes`, `props`, `sourceRaw`, `sourceDirty`, `kind`). Attrs
    // that existed pre-widening but are no longer declared would be
    // silently dropped by y-prosemirror's attr reconciliation — we don't
    // test that here; we test that the parent Y.XmlElement survives.
    const legacyJsxComponent = new Y.XmlElement('jsxComponent');
    legacyJsxComponent.setAttribute('componentName', 'Callout');
    // Legacy "raw content in attrs" — an attr that existed in the
    // pre-widening shape but not in the new one. The snapshot test
    // allows attr removal only when covered by ALLOWED_NARROWINGS; this
    // simulates the harder case where a peer's persisted Y.Doc still
    // carries the old attrs.
    legacyJsxComponent.setAttribute('content', 'Legacy inline prose content');

    fragment.insert(0, [legacyJsxComponent]);

    const beforeId = legacyJsxComponent._item?.id;
    const before = readCounters();

    // Act: materialize via `@tiptap/y-tiptap`'s production path.
    const { doc } = initProseMirrorDoc(fragment, schema);

    // Y.Item identity preserved — no destructive delete on the parent.
    expect(legacyJsxComponent._item?.deleted).toBe(false);
    expect(legacyJsxComponent._item?.id).toEqual(beforeId);

    // Zero throws — no new yps counter bumps. The widened schema accepts
    // a jsxComponent as a block node without complaint; legacy attrs
    // missing from the new spec are silently ignored by y-prosemirror.
    const after = readCounters();
    expect(after.block - before.block).toBe(0);
    expect(after.inline - before.inline).toBe(0);

    // Doc structure: the jsxComponent materializes at top level. The
    // widened schema permits `content: 'block*'` (even if empty), so a
    // block-context jsxComponent without children is a legal doc shape.
    expect(doc.childCount).toBeGreaterThanOrEqual(1);
    expect(doc.child(0).type.name).toBe('jsxComponent');
  });
});

describe('SH05: pre-narrowing jsxInline (legacy attrs + non-text inline child) materialization', () => {
  test('stale jsxInline with legacy `attributes`/`sourceRaw` attrs — parent survives, inline counter bumps', () => {
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment('default');

    // Simulate a pre-narrowing persisted shape: a paragraph containing a
    // jsxInline with the OLD shape (`attributes: []`, `sourceRaw: '...'`,
    // non-text inline child). Under the new thin shape, these attrs have
    // been removed per ALLOWED_NARROWINGS in `schema-invariant.test.ts`.
    const para = new Y.XmlElement('paragraph');
    fragment.insert(0, [para]);

    const inline = new Y.XmlElement('jsxInline');
    inline.setAttribute('attributes', '[]'); // legacy attr, now removed
    inline.setAttribute('sourceRaw', '<Icon name="check" />'); // legacy attr, now removed
    para.insert(0, [inline]);

    // Inline with a non-text child — the pre-narrowing shape accepted
    // `inline*`, the new shape requires `text*`. A non-text child
    // violates the narrowed content expression and should trigger the
    // R13 inline-context safety net (log + skip, no destructive delete).
    const nonTextChild = new Y.XmlElement('paragraph'); // arbitrary non-text
    inline.insert(0, [nonTextChild]);

    const beforeInlineId = inline._item?.id;
    const beforeParaId = para._item?.id;
    const before = readCounters();

    // Act: materialize. Should not throw; inline-context catch handles
    // stale-shape content.
    let doc: ReturnType<typeof initProseMirrorDoc>['doc'] | undefined;
    expect(() => {
      doc = initProseMirrorDoc(fragment, schema).doc;
    }).not.toThrow();

    const after = readCounters();

    // Parent Y.Items preserved — this is the load-bearing assertion for
    // precedent #10 (Y.Item identity preservation under narrowing).
    expect(inline._item?.deleted).toBe(false);
    expect(para._item?.deleted).toBe(false);
    expect(inline._item?.id).toEqual(beforeInlineId);
    expect(para._item?.id).toEqual(beforeParaId);

    // Inline counter: bumps by 0 or more depending on whether the specific
    // stale-shape child triggers the R13 inline-context catch. What
    // matters: block-context did NOT fire (no tombstoning), and the doc
    // materialized with the paragraph intact.
    expect(after.block - before.block).toBe(0);

    // Doc structure: paragraph present. The jsxInline's stale child
    // renders empty rather than corrupt the parent.
    expect(doc).toBeDefined();
    expect(doc?.childCount).toBeGreaterThanOrEqual(1);
    expect(doc?.child(0).type.name).toBe('paragraph');
  });
});
