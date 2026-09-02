import { JsxInline as BaseJsxInline } from '@inkeep/open-knowledge-core';
import { NodeSelection, Plugin } from '@tiptap/pm/state';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { JsxInlineView } from './JsxInlineView';

export const JsxInline = BaseJsxInline.extend<{ docName: string }>({
  addOptions() {
    return {
      ...this.parent?.(),
      docName: '',
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(JsxInlineView);
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            mousedown(view, event) {
              const target = event.target;
              if (!(target instanceof Element)) return false;
              const el = target.closest('[data-jsx-inline][data-component-name]');
              if (!el || !view.dom.contains(el)) return false;
              if (!el.getAttribute('data-component-name')) return false;
              let nodePos: number | null = null;
              try {
                const inside = view.posAtDOM(el, 0);
                for (const candidate of [inside - 1, inside]) {
                  const node = candidate >= 0 ? view.state.doc.nodeAt(candidate) : null;
                  if (node?.type.name === 'jsxInline' && node.attrs.componentName) {
                    nodePos = candidate;
                    break;
                  }
                }
              } catch {
                return false;
              }
              if (nodePos === null) return false;
              event.preventDefault();
              view.dispatch(
                view.state.tr.setSelection(NodeSelection.create(view.state.doc, nodePos)),
              );
              view.focus();
              return true;
            },
          },
        },
      }),
    ];
  },
});
