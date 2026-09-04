import { getSchema } from '@tiptap/core';
import { describe, expect, test } from 'vitest';
import { sharedExtensions } from './shared.ts';

const schema = getSchema(sharedExtensions);

const MARKED_INLINE_LEAF_NODES = [
  'wikiLink',
  'tag',
  'mathInline',
  'imageReference',
  'image',
  'hardBreak',
  'footnoteReference',
] as const;

const EMPHASIS_MARKS = ['strong', 'emphasis', 'strike'] as const;

describe('inline leaf nodes are legal mark carriers (schema legality)', () => {
  for (const nodeName of MARKED_INLINE_LEAF_NODES) {
    const nodeType = schema.nodes[nodeName];

    test(`${nodeName} exists in the shared schema`, () => {
      expect(nodeType, `node ${nodeName} missing from schema`).toBeDefined();
    });

    for (const markName of EMPHASIS_MARKS) {
      test(`${nodeName} allows the ${markName} mark`, () => {
        const markType = schema.marks[markName];
        expect(markType, `mark ${markName} missing from schema`).toBeDefined();
        expect(nodeType.allowsMarkType(markType)).toBe(true);
      });
    }
  }
});
