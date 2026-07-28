/**
 * Schema-legality pin for emphasis marks on inline leaf/atom nodes.
 *
 * The Yjs-bridge fix preserves marks on these nodes through storage, but the
 * ProseMirror schema must ALSO declare the marks legal. An inline leaf has no
 * inline content, so PM computes an empty mark set for it unless the node spec
 * sets `marks` — leaving `allowsMarkType(strong) === false`. While that holds, a
 * real editor transaction can strip a parse-produced mark (schema normalization)
 * and the user cannot apply one (`toggleBold` no-ops), so formatting on a
 * wikilink/image/tag/math/hard-break survives storage but not editing.
 *
 * This pins the legality itself: every inline leaf the markdown pipeline can wrap
 * in emphasis must accept those marks. See the editing/collab coverage in
 * `packages/app/.../marked-inline-leaf-editing.dom.test.tsx` and
 * `marked-inline-leaf-collab.test.ts` for the behavior this legality unblocks.
 */

import { getSchema } from '@tiptap/core';
import { describe, expect, test } from 'vitest';
import { sharedExtensions } from './shared.ts';

const schema = getSchema(sharedExtensions);

// Inline leaf/atom nodes the markdown pipeline can attach emphasis marks to via
// `**[[a]]**`, `*![alt](x)*`, `~~$x$~~`, `**#tag**`, `**[^1]**`, `**a<br>b**`, etc.
const MARKED_INLINE_LEAF_NODES = [
  'wikiLink',
  'tag',
  'mathInline',
  'imageReference',
  'image',
  'hardBreak',
  'footnoteReference',
] as const;

// The emphasis marks the pipeline actually produces on those nodes (mdast-canonical
// names: `strong` not bold, `emphasis` not italic).
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
