import { Node } from '@tiptap/core';
import { renderInlineObjectText } from './input-rule-text.ts';

export const ImageReferenceFidelity = Node.create({
  name: 'imageReference',
  marks: '_',
  group: 'inline',
  inline: true,
  atom: true,
  priority: 60,

  renderText: renderInlineObjectText,

  addAttributes() {
    return {
      alt: { default: '' },
      label: { default: '' },
      identifier: { default: '' },
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
