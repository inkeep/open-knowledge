import { Node } from '@tiptap/core';

export const RawMdxFallback = Node.create({
  name: 'rawMdxFallback',
  group: 'block',
  atom: false,
  content: 'text*',
  isolating: true,
  selectable: true,
  defining: true,
  priority: 60,

  addAttributes() {
    return {
      reason: { default: '' },
      originalSpan: { default: { start: 0, end: 0 } },
    };
  },

  parseHTML() {
    const getAttrs = (node: HTMLElement | string) => {
      if (typeof node === 'string') return false;
      return {
        reason: node.getAttribute('data-reason') || '',
      };
    };
    return [
      { tag: 'div[data-raw-mdx-fallback]', getAttrs },
      { tag: 'pre[data-raw-mdx-fallback]', getAttrs },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      {
        'data-raw-mdx-fallback': '',
        'data-raw-badge': 'raw',
        'data-reason': HTMLAttributes.reason,
        contenteditable: 'false',
        class: 'raw-mdx-fallback',
      },
      0,
    ];
  },

  addNodeView() {
    return ({ HTMLAttributes }) => {
      const dom = document.createElement('div');
      dom.setAttribute('data-raw-mdx-fallback', '');
      dom.setAttribute('data-raw-badge', 'raw');
      dom.setAttribute('contenteditable', 'false');
      dom.classList.add('raw-mdx-fallback');

      if (HTMLAttributes.reason) {
        dom.setAttribute('data-reason', HTMLAttributes.reason);
      }

      const contentDOM = document.createElement('pre');
      contentDOM.classList.add('raw-mdx-fallback-content');
      contentDOM.setAttribute('contenteditable', 'false');
      dom.appendChild(contentDOM);

      return {
        dom,
        contentDOM,
        ignoreMutation: () => true,
      };
    };
  },
});
