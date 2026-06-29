
import CodeBlock from '@tiptap/extension-code-block';

export const CodeBlockFidelity = CodeBlock.extend({
  priority: 60,

  addAttributes() {
    return {
      ...this.parent?.(),
      fenceDelimiter: { default: '`' },
      fenceLength: { default: 3 },
      meta: { default: null },
      sourceStyle: { default: 'fenced' },
      sourceClosingFenceLength: { default: null, rendered: false },
      sourceFenceIndent: { default: null, rendered: false },
      sourceInfoPadding: { default: null, rendered: false },
      sourceIndents: { default: null, rendered: false },
    };
  },
});
