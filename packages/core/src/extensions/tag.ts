import { Node } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    tag: {
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
  priority: 60,

  addAttributes() {
    return {
      value: { default: '' },
    };
  },

  parseHTML() {
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
