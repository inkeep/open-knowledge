import { Node } from '@tiptap/core';
import { renderInlineObjectText } from './input-rule-text.ts';

/**
 * `content: 'text*'` per Precedent #10 preserves Y.Item identity on per-keystroke text mutation
 * (thin-shape path uses children for the raw JSX source).
 */
export const JsxInline = Node.create({
  name: 'jsxInline',
  group: 'inline',
  inline: true,
  atom: false,
  content: 'text*',
  isolating: false,
  selectable: true,
  priority: 60,

  renderText: renderInlineObjectText,

  addAttributes() {
    return {
      componentName: { default: '' },
      kind: { default: 'element' },
      attributes: { default: [] },
      sourceRaw: { default: '' },
      sourceDirty: { default: false },
      props: { default: {} },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-jsx-inline]',
        getAttrs: (node) => {
          if (typeof node === 'string') return false;
          return {
            componentName: node.getAttribute('data-component-name') || '',
            sourceRaw: node.getAttribute('data-source-raw') || '',
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      {
        'data-jsx-inline': '',
        'data-component-name': HTMLAttributes.componentName,
        'data-source-raw': HTMLAttributes.sourceRaw,
      },
      0,
    ];
  },
});
