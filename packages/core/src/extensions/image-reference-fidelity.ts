/**
 * ImageReference custom node for source-text fidelity.
 *
 * Inline atom node that preserves image-reference shape (`![alt][ref]`,
 * `![ref][]`, `![ref]`). Without this extension, the mdast-to-PM handler
 * collapses every imageReference to a plain `image` PM node with `src=''`,
 * which round-trips as `![alt]()` — losing reference identity.
 *
 * Mirrors the LinkRefDefFidelity pattern (atom node + per-node attrs +
 * dedicated parse/serialize handlers in markdown/index.ts).
 *
 * Markdown parsing/serialization is wired in packages/core/src/markdown/index.ts.
 */

import { Node } from '@tiptap/core';

export const ImageReferenceFidelity = Node.create({
  name: 'imageReference',
  group: 'inline',
  inline: true,
  atom: true,
  priority: 60,

  addAttributes() {
    return {
      // Original alt text from `![alt][ref]`. Empty for shortcut/collapsed
      // forms (where the bracket label IS the displayed text).
      alt: { default: '' },
      // Bracket label as typed (case-preserved). Used for emitting the
      // outer brackets in serialized form.
      label: { default: '' },
      // Normalized identifier (lowercased) used to match the matching
      // `[label]: url` definition. mdast keeps identifier separate from
      // label so case-mismatched references resolve correctly.
      identifier: { default: '' },
      // 'full' (`![alt][ref]`), 'collapsed' (`![ref][]`), or 'shortcut'
      // (`![ref]`). mdast-util-to-markdown's image-reference handler
      // dispatches on this.
      referenceType: { default: 'shortcut' },
    };
  },

  parseHTML() {
    return [{ tag: 'img[data-image-reference]' }];
  },

  renderHTML({ node }) {
    const { alt, label, referenceType } = node.attrs;
    const display = alt || label;
    return [
      'img',
      {
        'data-image-reference': '',
        'data-reference-type': referenceType,
        'data-label': label,
        alt: display,
      },
    ];
  },
});
