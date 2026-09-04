import { Node } from '@tiptap/core';
import { renderInlineObjectText } from './input-rule-text.ts';

/**
 * jsxInline — inline PM node for MDX inline JSX (`mdxJsxTextElement`).
 *
 * Two rendering paths sit behind one node type:
 *   1. Attrs-populated (registered inline descriptor) — `componentName` set,
 *      `props` destructured. NodeView dispatches to the descriptor's React
 *      component atomically (contentEditable={false}); source characters are
 *      hidden. Paired bodies land as `props.children`. Analogous to
 *      jsxComponent but at inline flow.
 *   2. Zero-attrs (legacy thin shape) — `componentName === ''` and the text
 *      children carry raw source. WYSIWYG renders as visible source text
 *      (source-text default for unregistered tags).
 *
 * `content: 'text*'` per Precedent #10 preserves Y.Item identity on
 * per-keystroke text mutation (thin-shape path uses children for the raw
 * JSX source).
 *
 * Attrs mirror jsxComponent's (componentName / kind / attributes / sourceRaw
 * / sourceDirty / props) so NodeViews and serialization handlers can share
 * utilities. `kind` is always `'element'` today; the field is present for
 * shape parity with jsxComponent (which carries `'element' | 'expression'`).
 */
export const JsxInline = Node.create({
  name: 'jsxInline',
  group: 'inline',
  inline: true,
  atom: false,
  content: 'text*',
  isolating: false,
  selectable: true,
  priority: 60,

  renderText: renderInlineObjectText,

  addAttributes() {
    return {
      componentName: { default: '' },
      kind: { default: 'element' },
      attributes: { default: [] },
      sourceRaw: { default: '' },
      sourceDirty: { default: false },
      props: { default: {} },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-jsx-inline]',
        getAttrs: (node) => {
          if (typeof node === 'string') return false;
          return {
            componentName: node.getAttribute('data-component-name') || '',
            sourceRaw: node.getAttribute('data-source-raw') || '',
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      {
        'data-jsx-inline': '',
        'data-component-name': HTMLAttributes.componentName,
        'data-source-raw': HTMLAttributes.sourceRaw,
      },
      0,
    ];
  },
});
