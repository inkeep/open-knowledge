import { Node } from '@tiptap/core';
import { renderInlineObjectText } from './input-rule-text.ts';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    mathInline: {
      insertMathInline: (formula: string) => ReturnType;
    };
  }
}

export const MathInline = Node.create({
  name: 'mathInline',
  marks: '_',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  priority: 60,

  renderText: renderInlineObjectText,

  addAttributes() {
    return {
      formula: { default: '' },
      id: { default: null },
      language: { default: 'latex' },
      sourceDelimiter: { default: null, rendered: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-math-inline]',
        getAttrs: (node) => {
          if (typeof node === 'string') return false;
          return {
            formula: node.getAttribute('data-formula') || '',
            id: node.getAttribute('id') || null,
            language: node.getAttribute('data-language') || 'latex',
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      {
        'data-math-inline': '',
        'data-formula': HTMLAttributes.formula,
        'data-language': HTMLAttributes.language,
        ...(HTMLAttributes.id ? { id: HTMLAttributes.id } : {}),
      },
    ];
  },

  addCommands() {
    return {
      insertMathInline:
        (formula: string) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: { formula },
          });
        },
    };
  },
});
