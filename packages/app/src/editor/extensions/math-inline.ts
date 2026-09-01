import { MathInline as BaseMathInline } from '@inkeep/open-knowledge-core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { MathInlineView } from './MathInlineView';

export const MathInline = BaseMathInline.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MathInlineView);
  },
});
