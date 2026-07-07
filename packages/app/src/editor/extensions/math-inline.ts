/**
 * App-specific MathInline extension — extends core with the React NodeView
 * that runs KaTeX inline.
 *
 * The core MathInline owns schema + commands; this layer adds the live
 * rendering surface for the editor. Same split as JsxComponent (core
 * schema, app NodeView).
 */
import { MathInline as BaseMathInline } from '@inkeep/open-knowledge-core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { MathInlineView } from './MathInlineView';

export const MathInline = BaseMathInline.extend({
  addNodeView() {
    return ReactNodeViewRenderer(MathInlineView);
  },
});
