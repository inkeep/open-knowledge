import { getSchema, getTextContentFromNodes } from '@tiptap/core';
import type { NodeType, Node as PMNode } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';
import { INLINE_OBJECT_PLACEHOLDER, renderInlineObjectText } from './input-rule-text.ts';
import { sharedExtensions } from './shared.ts';

const schema = getSchema(sharedExtensions);

/** Every inline node that is not text — the nodes the runner needs a chunk for. */
function inlineObjectTypes(): NodeType[] {
  return Object.values(schema.nodes).filter((type) => type.isInline && type.name !== 'text');
}

/** One instance of `type`, filled with text when the node takes content. */
function sample(type: NodeType): PMNode | null {
  return type.isLeaf ? type.createAndFill() : type.createAndFill(null, [schema.text('foo')]);
}

describe('INLINE_OBJECT_PLACEHOLDER', () => {
  it('is one UTF-16 unit, the unit match lengths are counted in', () => {
    expect(INLINE_OBJECT_PLACEHOLDER).toHaveLength(1);
    expect(INLINE_OBJECT_PLACEHOLDER.codePointAt(0)).toBe(0xfffc);
  });

  it('is not a delimiter any shipped input rule matches on', () => {
    expect(INLINE_OBJECT_PLACEHOLDER).not.toMatch(/[*_$[\]()#~`\-+>!\\\s]/);
  });
});

describe('renderInlineObjectText', () => {
  it('yields one placeholder for a leaf — the single position it owns', () => {
    const image = schema.nodes.image?.createAndFill();
    expect(image).not.toBeNull();
    expect(renderInlineObjectText({ node: image as PMNode })).toBe(INLINE_OBJECT_PLACEHOLDER);
  });

  it('yields two for a node with children — its open and close positions', () => {
    const jsx = schema.nodes.jsxInline?.createAndFill(null, [schema.text('foo')]);
    expect(jsx).not.toBeNull();
    expect(renderInlineObjectText({ node: jsx as PMNode })).toBe(
      INLINE_OBJECT_PLACEHOLDER.repeat(2),
    );
    // The children are walked separately, so the wrapper must not speak for them.
    expect(renderInlineObjectText({ node: jsx as PMNode })).toHaveLength(
      (jsx as PMNode).nodeSize - (jsx as PMNode).content.size,
    );
  });
});

describe('input-rule matching text is position-faithful', () => {
  // The contract the range arithmetic `from - (match[0].length - text.length)`
  // depends on: the derived string is as long as the span it describes. A node
  // that breaks it skews the range for EVERY rule whose match window covers it,
  // so this walks the whole schema rather than the nodes known to have broken.
  it.each(
    inlineObjectTypes().map((type) => [type.name, type] as const),
  )('%s contributes exactly the positions it occupies', (_name, type) => {
    const node = sample(type);
    expect(node).not.toBeNull();
    const paragraph = schema.nodes.paragraph?.create(null, [
      schema.text('x'),
      node as PMNode,
      schema.text('y'),
    ]);
    expect(paragraph).toBeDefined();
    const doc = schema.nodes.doc?.createAndFill(null, [paragraph as PMNode]);
    expect(doc).not.toBeNull();
    const $end = (doc as PMNode).resolve(1 + (paragraph as PMNode).content.size);

    expect(getTextContentFromNodes($end)).toHaveLength($end.parentOffset);
  });

  it('never falls back to the six-character %leaf% sentinel', () => {
    for (const type of inlineObjectTypes()) {
      const node = sample(type);
      if (!node) continue;
      const paragraph = schema.nodes.paragraph?.create(null, [node]);
      const doc = schema.nodes.doc?.createAndFill(null, [paragraph as PMNode]);
      const $end = (doc as PMNode).resolve(1 + (paragraph as PMNode).content.size);
      expect(getTextContentFromNodes($end)).not.toContain('%leaf%');
    }
  });
});
