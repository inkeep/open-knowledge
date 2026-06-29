
import { CodeBlockFidelity as BaseCodeBlockFidelity } from '@inkeep/open-knowledge-core';
import { textblockTypeInputRule } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { common, createLowlight } from 'lowlight';
import { CodeBlockView } from './CodeBlockView';
import { type LowlightLike, LowlightPlugin } from './code-block-lowlight-plugin';

const lowlight = createLowlight(common) as unknown as LowlightLike;

export const CodeBlockFidelity = BaseCodeBlockFidelity.extend({

  addOptions() {
    return {
      ...this.parent?.(),
      enableTabIndentation: true,
      tabSize: 2,
    } as ReturnType<NonNullable<typeof this.parent>>;
  },

  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },

  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      LowlightPlugin({
        name: this.name,
        lowlight,
        defaultLanguage: null,
      }),
    ];
  },

  addInputRules() {
    return [
      ...(this.parent?.() ?? []),
      textblockTypeInputRule({
        find: /^```$/,
        type: this.type,
        getAttributes: () => ({ language: 'js' }),
      }),
    ];
  },
});
