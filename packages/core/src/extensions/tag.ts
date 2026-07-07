/**
 * Tag — PM atom node for the `#tagname` inline syntax (Obsidian parity).
 *
 * Markdown `#foo` is detected by the post-parse walker (`tag-promotion.ts`)
 * and converted into a `tag` mdast node carrying `value: 'foo'`. The
 * mdast→PM handler in `index.ts` reads the value and creates this atom;
 * PM→mdast emits the same shape, and `tag-to-markdown.ts`'s handler
 * serializes it back to `#${value}`.
 *
 * Renders as `<a class="tag" data-tag="{value}" href="#tag/{value}">
 * #{value}</a>`. The `<a>` gives keyboard focus + Enter activation for
 * free; the `href` is a navigation-friendly fragment that cross-app
 * static destinations treat as an in-document anchor. The `#` prefix is
 * rendering chrome — the attr stores the bare name.
 *
 * Sister to `wikiLink` (atom node with custom mdast type) and the
 * footnote-reference pattern from the Obsidian-parity stack.
 */

import { Node } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    tag: {
      /** Insert a tag with the given value (without the `#` prefix). */
      insertTag: (value: string) => ReturnType;
    };
  }
}

export const Tag = Node.create({
  name: 'tag',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  // Higher priority than StarterKit defaults so the schema registers
  // before anything that might conflict on parseHTML.
  priority: 60,

  addAttributes() {
    return {
      value: { default: '' },
    };
  },

  parseHTML() {
    // Extract `value` from `data-tag` (renderHTML emits it there).
    // Without `getAttrs`, TipTap's default attribute-mapping looks for
    // an HTML attribute literally named `value`, which doesn't exist —
    // clipboard paste would land with `value: ''` and silently break.
    // Mirrors the wiki-link pattern of pulling from `data-*`.
    return [
      {
        tag: 'a[data-tag]',
        getAttrs: (node) => {
          if (typeof node === 'string') return false;
          const value = node.getAttribute('data-tag') || '';
          return { value };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const value = String(node.attrs.value ?? '');
    return [
      'a',
      {
        ...HTMLAttributes,
        'data-tag': value,
        href: `#tag/${value}`,
        class: 'tag',
      },
      `#${value}`,
    ];
  },

  addCommands() {
    return {
      insertTag:
        (value: string) =>
        ({ chain }) =>
          chain().insertContent({ type: 'tag', attrs: { value } }).run(),
    };
  },
});
