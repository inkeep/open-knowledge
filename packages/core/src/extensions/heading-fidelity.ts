import Heading from '@tiptap/extension-heading';

export const HeadingFidelity = Heading.extend({
  priority: 60,

  addAttributes() {
    return {
      ...this.parent?.(),
      headingStyle: { default: 'atx' },
      sourceTrailingHashes: { default: null },
      sourceUnderlineLength: { default: null },
      sourceContiguousNext: { default: false },
      sourceLeadingIndent: { default: null, rendered: false },
      sourceInteriorSpacing: { default: null, rendered: false },
    };
  },
});
