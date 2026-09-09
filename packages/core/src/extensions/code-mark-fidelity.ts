/** Schema widening per precedent #9 (add-only forever — widening is allowed, narrowing is not). */

import Code from '@tiptap/extension-code';

export const CodeMarkFidelity = Code.extend({
  excludes: '',

  addAttributes() {
    return {
      ...this.parent?.(),
      sourceFenceChar: { default: '`' },
      sourceFenceLength: { default: 1 },
      sourcePadded: { default: false, rendered: false },
    };
  },
});
