/** Narrowing it would violate precedent #9 the same way the Code widening documents. */

import Underline from '@tiptap/extension-underline';

export const UnderlineFidelity = Underline.extend({
  priority: 60,

  addAttributes() {
    return {
      ...this.parent?.(),
      sourceForm: { default: 'u', rendered: false },
    };
  },
});
