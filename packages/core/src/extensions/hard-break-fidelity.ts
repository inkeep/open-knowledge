
import HardBreak from '@tiptap/extension-hard-break';

export const HardBreakFidelity = HardBreak.extend({
  priority: 60,

  addAttributes() {
    return {
      ...this.parent?.(),
      hardBreakStyle: { default: 'backslash' },
    };
  },
});
