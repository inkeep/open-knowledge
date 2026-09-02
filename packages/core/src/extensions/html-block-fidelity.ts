import { Node } from '@tiptap/core';

export const HtmlBlockFidelity = Node.create({
  name: 'htmlBlock',
  group: 'block',
  atom: true,
  priority: 60,

  addAttributes() {
    return {
      content: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-html-block]' }];
  },

  renderHTML({ node }) {
    return ['div', { 'data-html-block': '', class: 'html-block' }, node.attrs.content];
  },
});
