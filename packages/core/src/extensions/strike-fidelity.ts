
import Strike from '@tiptap/extension-strike';

export const StrikeFidelity = Strike.extend({
  priority: 60,

  addAttributes() {
    return {
      ...this.parent?.(),
      sourceDelimiter: { default: '~~', rendered: false },
    };
  },
});
