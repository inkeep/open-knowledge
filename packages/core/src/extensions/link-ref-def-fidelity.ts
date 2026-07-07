/**
 * LinkRefDef custom node for source-text fidelity.
 *
 * Atom node that stores link reference definitions ([label]: url "title").
 * Rendered as footnote-style definitions at the document position where they appear.
 *
 * Markdown parsing/serialization is handled by the unified pipeline (packages/core/src/markdown/).
 */

import { Node } from '@tiptap/core';

export const LinkRefDefFidelity = Node.create({
  name: 'linkRefDef',
  group: 'block',
  atom: true,
  priority: 60,

  addAttributes() {
    return {
      label: { default: '' },
      href: { default: '' },
      title: { default: null },
      // Source-form preferences captured at parse time.
      //   sourceLayout — 'multiline' for `[ref]:\n  url\n  "title"` form,
      //     'inline' for single-line `[ref]: url`. Drives the custom
      //     to-markdown definition handler's layout choice.
      //   sourceTitleMarker — title quote style ('single' | 'double' |
      //     'paren'). Mirrors the link contract for definitions.
      // Both default to null; absence falls through to the canonical
      // single-line + double-quote synthesis path.
      sourceLayout: { default: null },
      sourceTitleMarker: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-link-ref-def]' }];
  },

  renderHTML({ node }) {
    const { label, href, title } = node.attrs;
    const display = title ? `[${label}]: ${href} "${title}"` : `[${label}]: ${href}`;
    return ['div', { 'data-link-ref-def': '', class: 'link-ref-def' }, display];
  },
});
