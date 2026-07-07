/**
 * App-specific JsxComponent extension — extends core with React NodeView.
 *
 * The core JsxComponent handles schema + markdown. This version adds
 * the React NodeView renderer for the browser editor.
 */
import { JsxComponent as BaseJsxComponent } from '@inkeep/open-knowledge-core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { JsxComponentView } from './JsxComponentView';

export const JsxComponent = BaseJsxComponent.extend<{ docName: string }>({
  addOptions() {
    return {
      ...this.parent?.(),
      docName: '',
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(JsxComponentView);
  },
});
