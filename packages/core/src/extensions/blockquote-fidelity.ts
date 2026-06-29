import Blockquote from '@tiptap/extension-blockquote';

export const BlockquoteFidelity = Blockquote.extend({
  priority: 60,

  addAttributes() {
    return {
      ...this.parent?.(),
      sourceMarkerSpacings: { default: null },
    };
  },
});
