import { Node } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    jsxComponent: {
      insertJsxComponent: (content: string) => ReturnType;
    };
  }
}

/**
 * jsxComponent — block-level PM node for MDX JSX flow elements.
 *
 *   atom: false, content: 'block*', isolating: true, defining: true
 *
 * Children are recursively-walked mdast children from mdxJsxFlowElement.
 * Descriptor dispatch at render time determines the NodeView branch
 * (registered → live React, wildcard → UnregisteredBadge, error → nested CM).
 *
 * Attrs:
 *   - componentName: the JSX tag name (e.g., 'Callout', 'Accordion')
 *   - kind: 'element' | 'expression' — discriminates JSX elements from {expression} blocks
 *   - attributes: preserved mdast MdxJsxAttribute[] for serialize reconstruct
 *   - sourceRaw: byte-exact source from parse (pristine serialization path)
 *     — for `kind:'expression'` the wrapped expression bytes, for `kind:'element'`
 *     the full `<Component …>…</Component>` source used by the pristine path.
 *   - sourceDirty: pattern flag — false = pristine (serialize via sourceRaw),
 *     true = edited (serialize via reconstruction)
 *   - props: structured props destructured from MdxJsxAttribute[] via descriptor.props
 *
 * See Precedent #9 (schema add-only), Precedent #10.
 */
export const JsxComponent = Node.create({
  name: 'jsxComponent',
  group: 'block',
  atom: false,
  content: 'block*',
  isolating: true,
  selectable: true,
  defining: true,
  priority: 60,

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
        tag: 'div[data-jsx-component]',
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
      'div',
      {
        'data-jsx-component': '',
        'data-component-name': HTMLAttributes.componentName,
        'data-source-raw': HTMLAttributes.sourceRaw,
      },
      0,
    ];
  },

  addCommands() {
    return {
      insertJsxComponent:
        (content: string) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: { sourceRaw: content },
          });
        },
    };
  },
});
