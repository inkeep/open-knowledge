/**
 * App-specific JsxInline extension — extends core with React NodeView.
 *
 * The core JsxInline handles schema + markdown. This version adds the
 * React NodeView renderer that dispatches to the descriptor registry so
 * registered inline components (`<Callout />`, etc.) render as widgets
 * instead of source text. Mirrors the shape of `./jsx-component.ts`.
 */
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
      // Click on a REGISTERED inline widget → NodeSelection (which opens the
      // PropPanel popover via the view's selection-sync). PM-native
      // handleClickOn because PM's own mousedown handling wins over React
      // synthetic handlers on the node view DOM — a React onMouseDown never
      // fires reliably here. Thin-shape nodes keep default text-caret
      // behavior (their source text is editable prose).
      new Plugin({
        props: {
          // DOM-anchored: clicks land on the widget's inner chrome and PM's
          // click-position mapping skips the contentEditable=false subtree,
          // so `handleClickOn` never surfaces the jsxInline node. Resolve
          // the node from the clicked element instead and select it —
          // mousedown (not click) so PM's own caret placement never runs.
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
