
import { Node } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    footnoteDefinition: {
      insertFootnoteDefinition: (identifier: string) => ReturnType;
    };
  }
}

export const FootnoteDefinition = Node.create({
  name: 'footnoteDefinition',
  group: 'block',
  content: 'block+',
  defining: true,
  priority: 60,

  addAttributes() {
    return {
      identifier: { default: '' },
      label: { default: null },
    };
  },

  parseHTML() {
    const getAttrs = (node: HTMLElement | string) => {
      if (typeof node === 'string') return false;
      const id = node.getAttribute('data-footnote-id') || '';
      return { identifier: id, label: id || null };
    };
    return [
      { tag: 'aside[data-footnote-def]', getAttrs },
      { tag: 'aside.footnote-def', getAttrs },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const id = String(node.attrs.identifier ?? '');
    return [
      'aside',
      {
        ...HTMLAttributes,
        'data-footnote-def': '',
        'data-footnote-id': id,
        id: `fn-${id}`,
        class: 'footnote-def',
      },
      ['div', { class: 'footnote-body' }, 0],
      [
        'a',
        {
          href: `#fnref-${id}`,
          class: 'footnote-backref',
          contentEditable: 'false',
          'aria-label': 'Back to reference',
        },
        '↩', // ↩
      ],
    ];
  },

  addCommands() {
    return {
      insertFootnoteDefinition:
        (identifier) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { identifier, label: identifier },
            content: [{ type: 'paragraph' }],
          }),
    };
  },
});
